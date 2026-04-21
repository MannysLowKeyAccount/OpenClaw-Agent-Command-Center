import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SaveFlowRequest, SaveFlowResponse, WorkflowExecutionRecord } from "../../orchestrator/types.js";
import { validateFlowDefinition, deriveFileNames, TASK_FLOW_TOOL_ID } from "../../orchestrator/utils.js";
import { generateFlowDefinitionFile, generateAgentsMdSnippet, parseFlowDefinitionFile } from "../../orchestrator/codegen.js";
import {
    json,
    parseBody,
    readConfig,
    writeConfig,
    stageConfig,
    readEffectiveConfig,
    stagePendingDestructiveOp,
    getPendingDestructiveOps,
    getAgentWorkspace,
    execAsync,
    shellEsc,
    getCachedCli,
    setCachedCli,
    deleteCachedCli,
    tryReadFile,
    AGENTS_STATE_DIR,
    OPENCLAW_DIR,
    DASHBOARD_FLOW_DEFS_DIR,
    DASHBOARD_FLOW_STATE_DIR,
    DASHBOARD_FLOW_HISTORY_DIR,
} from "../api-utils.js";

// ─── Cron jobs — gateway stores them in ~/.openclaw/cron/jobs.json ───
const CRON_DIR = join(OPENCLAW_DIR, "cron");
const CRON_JOBS_PATH = join(CRON_DIR, "jobs.json");
const CRON_RUNS_DIR = join(CRON_DIR, "runs");

type NormalizedCronRunStatus = "queued" | "running" | "completed" | "failed";

type NormalizedCronRun = {
    runId: string;
    status: NormalizedCronRunStatus;
    startedAt: string | null;
    completedAt: string | null;
    updatedAt: string | null;
    sessionId: string | null;
    agentId: string | null;
    summary: string;
    error: string;
    latestProgress: string;
    liveStatus: string | null;
    raw: any;
};

function asText(value: any): string {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
    if (typeof value === "object") {
        if (typeof value.content === "string") return value.content;
        if (typeof value.text === "string") return value.text;
        if (typeof value.message === "string") return value.message;
        if (typeof value.summary === "string") return value.summary;
        if (typeof value.error === "string") return value.error;
        try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
}

function trimText(value: string, max = 240): string {
    const text = value.trim().replace(/\s+/g, " ");
    return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

function firstTime(...values: any[]): string | null {
    for (const value of values) {
        if (!value) continue;
        const dt = new Date(value);
        if (!Number.isNaN(dt.getTime())) return dt.toISOString();
    }
    return null;
}

function normalizeCronRunStatus(rawStatus: any, record: any): NormalizedCronRunStatus {
    const status = String(rawStatus || record?.state || record?.phase || record?.result || "").toLowerCase();
    if (!status) {
        if (record?.completedAt || record?.finishedAt || record?.endedAt) return "completed";
        if (record?.startedAt || record?.runAt || record?.queuedAt) return record?.sessionId ? "running" : "queued";
        return "queued";
    }
    if (/queued|pending|scheduled|waiting/.test(status)) return "queued";
    if (/running|in[_-]?progress|active|processing|starting|dispatch/.test(status)) return "running";
    if (/completed|complete|success|succeeded|ok|done/.test(status)) return "completed";
    if (/failed|failure|error|cancel|aborted|stopped|timeout/.test(status)) return "failed";
    if (record?.error || record?.stderr) return "failed";
    return record?.sessionId && !record?.completedAt ? "running" : "queued";
}

function parseCronRunList(raw: string): any[] {
    const trimmed = (raw || "").trim();
    if (!trimmed) return [];
    try {
        if (trimmed.startsWith("[")) {
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [];
        }
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        return parsed.entries || parsed.runs || parsed.items ? (parsed.entries || parsed.runs || parsed.items || []) : [parsed];
    } catch {
        return trimmed.split("\n").map((line) => {
            try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
    }
}

function readCronRunsFile(jobId: string): any[] {
    const runsFile = join(CRON_RUNS_DIR, jobId + ".jsonl");
    const raw = tryReadFile(runsFile);
    if (raw === null) return [];
    return parseCronRunList(raw);
}

function readSessionMeta(agentId: string, sessionId: string): any | null {
    const sessionsFile = join(AGENTS_STATE_DIR, agentId, "sessions", "sessions.json");
    const raw = tryReadFile(sessionsFile);
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.find((item: any) => item?.sessionId === sessionId || item?.key === sessionId || item?.id === sessionId) || null;
        }
        const meta = parsed?.[sessionId] || parsed?.[sessionId.replace(/\.jsonl?$/, "")];
        if (meta) return meta;
        for (const [key, value] of Object.entries(parsed || {})) {
            const item = value as any;
            if (item?.sessionId === sessionId || key === sessionId) return item;
        }
    } catch { }
    return null;
}

function parseSessionTranscript(raw: string): { messages: any[]; updatedAt: string | null; progressSnippet: string; decisionSnippet: string; sessionAgentId: string; channel: string } {
    const messages: any[] = [];
    let updatedAt: string | null = null;
    let sessionAgentId = "";
    let channel = "";
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === "session") {
                sessionAgentId = entry.agentId || sessionAgentId;
                channel = entry.channel || channel;
            }
            if (entry.type === "message" && entry.message) {
                const msg = entry.message;
                if (entry.timestamp) msg._timestamp = entry.timestamp;
                messages.push(msg);
                if (entry.timestamp) updatedAt = entry.timestamp;
            }
        } catch { }
    }

    const texts = messages.map((msg) => asText(msg?.content ?? msg?.text ?? msg?.message ?? msg)).filter(Boolean);
    const latest = texts.length > 0 ? texts[texts.length - 1] : "";
    const decision = [...texts].reverse().find((text) => /decision|approve|approved|reject|denied|blocked|next step|next:|plan|summary/i.test(text)) || latest;
    const progress = [...texts].reverse().find((text) => /progress|working|update|status|running|step|doing|fetch|scan|check/i.test(text)) || latest;

    return {
        messages,
        updatedAt,
        progressSnippet: trimText(progress),
        decisionSnippet: trimText(decision),
        sessionAgentId,
        channel,
    };
}

function resolveRunSessionPath(jobId: string, run: any): { agentId: string; sessionId: string; filePath: string | null } {
    const agentId = String(run?.agentId || run?.sessionAgentId || run?.taskAgentId || "").trim();
    const sessionId = String(run?.sessionId || run?.sessionKey || run?.session || run?.key || run?.runId || "").trim();
    if (!sessionId) return { agentId, sessionId, filePath: null };

    const candidates: string[] = [];
    if (agentId) {
        candidates.push(join(AGENTS_STATE_DIR, agentId, "sessions", sessionId + ".jsonl"));
        candidates.push(join(AGENTS_STATE_DIR, agentId, "sessions", sessionId + ".json"));
    }
    const fallbackAgents = [jobId, "main", String(run?.taskId || "")].filter(Boolean);
    for (const fallbackAgent of fallbackAgents) {
        candidates.push(join(AGENTS_STATE_DIR, fallbackAgent, "sessions", sessionId + ".jsonl"));
        candidates.push(join(AGENTS_STATE_DIR, fallbackAgent, "sessions", sessionId + ".json"));
    }
    for (const fp of candidates) {
        if (existsSync(fp)) return { agentId, sessionId, filePath: fp };
    }
    return { agentId, sessionId, filePath: null };
}

function normalizeCronRun(jobId: string, record: any, index = 0): NormalizedCronRun {
    const raw = record || {};
    const runId = String(raw.runId || raw.id || raw.run_id || raw.sessionId || raw.sessionKey || raw.key || raw.startedAt || raw.createdAt || `${jobId}:${index}`);
    const sessionId = raw.sessionId || raw.sessionKey || raw.session || raw.session_id || null;
    const startedAt = firstTime(raw.startedAt, raw.runAt, raw.runAtMs, raw.createdAt, raw.timestamp, raw.queuedAt);
    const completedAt = firstTime(raw.completedAt, raw.finishedAt, raw.endedAt, raw.doneAt);
    const updatedAt = firstTime(raw.updatedAt, completedAt, startedAt);
    const status = normalizeCronRunStatus(raw.status || raw.state || raw.phase || raw.result, raw);
    const summary = trimText(asText(raw.summary || raw.message || raw.output || raw.result || raw.stdout || raw.response || raw.details || ""));
    const error = trimText(asText(raw.error || raw.failure || raw.stderr || raw.reason || raw.cause || ""));
    const latestProgress = trimText(asText(raw.latestProgress || raw.progress || raw.progressSnippet || raw.latestUpdate || raw.note || summary || error));
    const liveStatus = status === "running" ? "running" : (raw.liveStatus || raw.sessionStatus || null);

    return {
        runId,
        status,
        startedAt,
        completedAt,
        updatedAt,
        sessionId: sessionId ? String(sessionId) : null,
        agentId: raw.agentId ? String(raw.agentId) : null,
        summary,
        error,
        latestProgress,
        liveStatus: liveStatus ? String(liveStatus) : null,
        raw,
    };
}

function enrichCronRunWithSession(jobId: string, run: NormalizedCronRun): NormalizedCronRun {
    const resolved = resolveRunSessionPath(jobId, run.raw);
    let transcript: ReturnType<typeof parseSessionTranscript> | null = null;
    let sessionMeta: any | null = null;

    if (resolved.sessionId && resolved.agentId) {
        sessionMeta = readSessionMeta(resolved.agentId, resolved.sessionId);
    }

    if (resolved.filePath) {
        try {
            const raw = readFileSync(resolved.filePath, "utf-8");
            if (resolved.filePath.endsWith(".jsonl")) {
                transcript = parseSessionTranscript(raw);
            } else {
                const parsed = JSON.parse(raw);
                const lines = Array.isArray(parsed.messages) ? parsed.messages : [];
                transcript = {
                    messages: lines,
                    updatedAt: parsed.updatedAt || parsed.completedAt || parsed.lastUpdated || null,
                    progressSnippet: trimText(asText(parsed.progressSnippet || parsed.latestProgress || parsed.summary || lines.at(-1) || "")),
                    decisionSnippet: trimText(asText(parsed.decisionSnippet || parsed.decision || parsed.summary || lines.at(-1) || "")),
                    sessionAgentId: parsed.agentId || resolved.agentId,
                    channel: parsed.channel || parsed.channelType || "",
                };
            }
        } catch { }
    }

    const summary = run.summary || trimText(asText(sessionMeta?.summary || sessionMeta?.lastMessage || sessionMeta?.title || transcript?.decisionSnippet || transcript?.progressSnippet || ""));
    const latestProgress = trimText(asText(transcript?.progressSnippet || sessionMeta?.progressSnippet || run.latestProgress || summary || run.error));
    const liveStatus = run.status === "running"
        ? (sessionMeta?.status || sessionMeta?.state || "running")
        : (run.liveStatus || sessionMeta?.status || null);

    return {
        ...run,
        summary,
        latestProgress,
        liveStatus: liveStatus ? String(liveStatus) : null,
        raw: {
            ...run.raw,
            sessionMeta,
            transcript,
        },
    };
}

function readCronRunRecords(jobId: string): NormalizedCronRun[] {
    const records = readCronRunsFile(jobId);
    return records.map((record, index) => enrichCronRunWithSession(jobId, normalizeCronRun(jobId, record, index)));
}

function findCronRun(jobId: string, runId: string): NormalizedCronRun | null {
    const runs = readCronRunRecords(jobId);
    const needle = runId.toLowerCase();
    return runs.find((run) => {
        const raw = run.raw || {};
        return [run.runId, run.sessionId, raw.id, raw.runId, raw.key, raw.sessionKey].filter(Boolean).some((val) => String(val).toLowerCase() === needle);
    }) || null;
}

function readCronJobsFile(): any[] {
    const raw = tryReadFile(CRON_JOBS_PATH);
    if (raw === null) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : (parsed.jobs || []);
    } catch { return []; }
}

async function listCronJobs(): Promise<any[]> {
    // Try CLI first, fall back to reading the gateway's jobs.json directly
    try {
        const out = await execAsync("openclaw cron list --json", { timeout: 10000 });
        const trimmed = (out || "").trim();
        if (trimmed) {
            const parsed = JSON.parse(trimmed);
            const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
            if (jobs.length > 0) return jobs;
        }
    } catch { /* CLI unavailable */ }
    return readCronJobsFile();
}

async function getCronJobRuns(jobId: string, limit = 10): Promise<any[]> {
    // Try CLI first
    try {
        const out = await execAsync(`openclaw cron runs --id "${shellEsc(jobId)}" --limit ${limit}`, { timeout: 30000 });
        const trimmed = (out || "").trim();
        if (trimmed) {
            const parsed = JSON.parse(trimmed);
            const runs = Array.isArray(parsed) ? parsed : (parsed.entries || parsed.runs || []);
            if (runs.length > 0) return runs;
        }
    } catch { /* CLI unavailable */ }

    // Fallback: read from ~/.openclaw/cron/runs/{jobId}.jsonl
    const runsFile = join(CRON_RUNS_DIR, jobId + ".jsonl");
    const raw = tryReadFile(runsFile);
    if (raw === null) return [];
    const runs: any[] = [];
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try { runs.push(JSON.parse(line)); } catch { }
    }
    // Most recent first, limited
    return runs.reverse().slice(0, limit);
}

/**
 * Parse an agent's AGENTS.md to extract a flow definition from the "Execution policy" section.
 * This is a fallback for when no .flow.ts file exists (e.g., flow was defined manually in AGENTS.md).
 */
function parseAgentsMdFlow(md: string, agentId: string): import("../../orchestrator/types.js").TaskFlowDefinition | null {
    // Extract flow name from run_task_flow call: flowName: "coding_pipeline" or flowName: `coding_pipeline`
    const flowNameMatch = md.match(/flowName:\s*["`]([^"`]+)["`]/);
    if (!flowNameMatch) return null;
    const flowName = flowNameMatch[1];

    // Extract description from "Workflow policy" section (first paragraph after heading)
    let description = "";
    const policyMatch = md.match(/##\s*Workflow policy\s*\n+([\s\S]*?)(?=\n##|\n###)/);
    if (policyMatch) {
        const firstLine = policyMatch[1].trim().split("\n")[0];
        if (firstLine && !firstLine.startsWith("-") && !firstLine.startsWith("#")) {
            description = firstLine;
        }
    }

    // Extract steps from "Execution policy" section
    const execMatch = md.match(/###?\s*Execution policy\s*\n+([\s\S]*?)(?=\n###|\n##|$)/);
    if (!execMatch) return null;

    const stepsBlock = execMatch[1];
    const stepRegex = /^\s*\d+\.\s+\*\*(\S+)\*\*\s+\(agent:\s*(\S+)\)\s*(?:—|[-–])\s*(.*?)$/gm;
    const steps: import("../../orchestrator/types.js").TaskFlowStep[] = [];
    let stepMatch: RegExpExecArray | null;

    while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
        const id = stepMatch[1];
        const stepAgentId = stepMatch[2];
        let desc = stepMatch[3].trim();
        const humanIntervention = /\[requires human approval\]/i.test(desc);
        desc = desc.replace(/\s*\[requires human approval\]\s*/i, "").trim();
        steps.push({ id, agentId: stepAgentId, description: desc, humanIntervention });
    }

    if (steps.length === 0) return null;

    return { name: flowName, description, agentId, steps };
}

function isPendingFlowDefinitionDeletion(agentId: string, flowName: string): boolean {
    return getPendingDestructiveOps().some((op) => op.kind === "flow-definition" && op.agentId === agentId && op.flowName === flowName);
}

function getFlowDeletedMarkerPath(flowFilePath: string): string {
    return `${flowFilePath}.deleted`;
}

function isFlowDefinitionDeleted(flowFilePath: string): boolean {
    return existsSync(getFlowDeletedMarkerPath(flowFilePath));
}

function markFlowDefinitionDeleted(flowFilePath: string): void {
    try {
        writeFileSync(getFlowDeletedMarkerPath(flowFilePath), new Date().toISOString(), "utf-8");
    } catch { }
}

function clearFlowDefinitionDeletedMarker(flowFilePath: string): void {
    try {
        unlinkSync(getFlowDeletedMarkerPath(flowFilePath));
    } catch { }
}

// ─── Route handler ───
export async function handleTaskRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method ?? "GET";

    // ─── GET /api/tasks — list cron jobs from OpenClaw + heartbeats ───
    if (path === "/tasks" && method === "GET") {
        const cached = getCachedCli("tasks-list");
        if (cached) { json(res, 200, cached); return true; }

        const config = readEffectiveConfig();
        const agents = config.agents?.list || [];

        // Cron jobs from OpenClaw CLI
        const cronJobs = await listCronJobs();
        const enrichedTasks = cronJobs.map((task: any) => {
            const jobId = String(task.id || task.name || "");
            const latestRun = jobId ? (readCronRunRecords(jobId)[0] || null) : null;
            return {
                ...task,
                latestRun: latestRun ? {
                    runId: latestRun.runId,
                    status: latestRun.status,
                    startedAt: latestRun.startedAt,
                    completedAt: latestRun.completedAt,
                    updatedAt: latestRun.updatedAt,
                    sessionId: latestRun.sessionId,
                    summary: latestRun.summary,
                    error: latestRun.error,
                    latestProgress: latestRun.latestProgress,
                    liveStatus: latestRun.liveStatus,
                } : null,
                liveStatus: latestRun?.liveStatus || latestRun?.status || (task.enabled === false ? "failed" : "queued"),
            };
        });

        // Heartbeats — separate informational list
        const heartbeats: any[] = [];
        agents.forEach((a: any) => {
            if (a.heartbeat) {
                heartbeats.push({
                    id: `heartbeat:${a.id}`,
                    agentId: a.id,
                    agentName: a.name || a.id,
                    interval: a.heartbeat.every || "unknown",
                    model: a.heartbeat.model || null,
                    enabled: a.heartbeat.enabled !== false,
                });
            }
        });

        const result = { tasks: enrichedTasks, heartbeats };
        setCachedCli("tasks-list", result);
        json(res, 200, result);
        return true;
    }

    // ─── POST /api/tasks — create a cron job via `openclaw cron add` ───
    if (path === "/tasks" && method === "POST") {
        const body = await parseBody(req);
        if (!body.name) { json(res, 400, { error: "name is required" }); return true; }

        // Build the openclaw cron add command
        const args: string[] = ["openclaw", "cron", "add"];
        args.push("--name", `"${shellEsc(body.name)}"`);

        // Schedule: cron expression, --at, or --every
        if (body.cron) {
            args.push("--cron", `"${shellEsc(body.cron)}"`);
        } else if (body.at) {
            args.push("--at", `"${shellEsc(body.at)}"`);
        } else if (body.every) {
            args.push("--every", `"${shellEsc(body.every)}"`);
        } else {
            json(res, 400, { error: "One of cron, at, or every is required" });
            return true;
        }

        // Timezone
        if (body.tz) args.push("--tz", `"${shellEsc(body.tz)}"`);

        // Session type
        const session = body.session || "isolated";
        args.push("--session", shellEsc(session));

        // Message (required for isolated)
        if (body.message) {
            args.push("--message", `"${shellEsc(body.message)}"`);
        } else if (session === "main" && body.systemEvent) {
            args.push("--system-event", `"${shellEsc(body.systemEvent)}"`);
        } else if (session === "isolated") {
            json(res, 400, { error: "message is required for isolated session jobs" });
            return true;
        }

        // Agent (multi-agent setups)
        if (body.agentId) args.push("--agent", `"${shellEsc(body.agentId)}"`);

        // Delivery
        if (body.announce) {
            args.push("--announce");
            if (body.channel) args.push("--channel", `"${shellEsc(body.channel)}"`);
            if (body.to) args.push("--to", `"${shellEsc(body.to)}"`);
        }

        // Model override
        if (body.model) args.push("--model", `"${shellEsc(body.model)}"`);

        // One-shot auto-delete
        if (body.deleteAfterRun) args.push("--delete-after-run");

        // Wake mode (for main session)
        if (body.wake) args.push("--wake", `"${shellEsc(body.wake)}"`);

        try {
            const out = await execAsync(args.join(" "), { timeout: 15000 });
            deleteCachedCli("tasks-list");
            json(res, 201, { ok: true, output: (out || "").trim() });
            return true;
        } catch (e: any) {
            json(res, 500, { error: `Failed to create cron job: ${e.message}` });
            return true;
        }
    }

    // ─── DELETE /api/tasks/{id} — remove a cron job ───
    if (path.match(/^\/tasks\/[^/]+$/) && !path.startsWith("/tasks/flows") && method === "DELETE") {
        const taskId = decodeURIComponent(path.split("/").pop()!);

        // Handle heartbeat disable (still in openclaw.json)
        const hbMatch = taskId.match(/^heartbeat:(.+)$/);
        if (hbMatch) {
            const defer = url.searchParams?.get("defer") === "1";
            const config = defer ? readEffectiveConfig() : readConfig();
            const agentId = hbMatch[1];
            const agent = (config.agents?.list || []).find((a: any) => a.id === agentId);
            if (agent?.heartbeat) {
                agent.heartbeat.enabled = false;
                if (defer) {
                    stageConfig(config, "Disable heartbeat: " + agentId);
                } else {
                    writeConfig(config);
                }
            }
            deleteCachedCli("tasks-list");
            json(res, 200, { ok: true, deferred: defer });
            return true;
        }

        try {
            await execAsync(`openclaw cron remove "${shellEsc(taskId)}"`, { timeout: 10000 });
            deleteCachedCli("tasks-list");
            json(res, 200, { ok: true });
            return true;
        } catch (e: any) {
            json(res, 500, { error: `Failed to remove cron job: ${e.message}` });
            return true;
        }
    }

    // ─── POST /api/tasks/{id}/run — force-run a cron job now ───
    const taskRunMatch = path.match(/^\/tasks\/([^/]+)\/run$/);
    if (taskRunMatch && !path.startsWith("/tasks/flows") && method === "POST") {
        const taskId = decodeURIComponent(taskRunMatch[1]);
        try {
            const out = await execAsync(`openclaw cron run "${shellEsc(taskId)}"`, { timeout: 15000 });
            deleteCachedCli("tasks-list");
            json(res, 200, { ok: true, status: "running", output: (out || "").trim() });
            return true;
        } catch (e: any) {
            json(res, 500, { error: `Failed to run cron job: ${e.message}` });
            return true;
        }
    }

    // ─── GET /api/tasks/{id}/runs — get run history for a cron job ───
    const taskRunsMatch = path.match(/^\/tasks\/([^/]+)\/runs(?:\/([^/]+))?$/);
    if (taskRunsMatch && !path.startsWith("/tasks/flows") && method === "GET") {
        const taskId = decodeURIComponent(taskRunsMatch[1]);
        const runId = taskRunsMatch[2] ? decodeURIComponent(taskRunsMatch[2]) : "";
        if (runId) {
            const run = findCronRun(taskId, runId);
            if (!run) {
                json(res, 404, { error: "Run not found" });
                return true;
            }
            json(res, 200, { run });
            return true;
        }
        const runs = readCronRunRecords(taskId);
        const latestRun = runs[0] || null;
        json(res, 200, { runs, latestRun });
        return true;
    }

    // ─── POST /api/tasks/{id}/edit — edit a cron job ───
    const taskEditMatch = path.match(/^\/tasks\/([^/]+)\/edit$/);
    if (taskEditMatch && !path.startsWith("/tasks/flows") && method === "POST") {
        const taskId = decodeURIComponent(taskEditMatch[1]);
        const body = await parseBody(req);
        const args: string[] = ["openclaw", "cron", "edit", `"${shellEsc(taskId)}"`];
        if (body.message) args.push("--message", `"${shellEsc(body.message)}"`);
        if (body.model) args.push("--model", `"${shellEsc(body.model)}"`);
        if (body.cron) args.push("--cron", `"${shellEsc(body.cron)}"`);
        if (body.every) args.push("--every", `"${shellEsc(body.every)}"`);
        if (body.name) args.push("--name", `"${shellEsc(body.name)}"`);
        if (body.tz) args.push("--tz", `"${shellEsc(body.tz)}"`);
        if (body.announce === true) {
            args.push("--announce");
            if (body.channel) args.push("--channel", `"${shellEsc(body.channel)}"`);
            if (body.to) args.push("--to", `"${shellEsc(body.to)}"`);
        } else if (body.announce === false) {
            args.push("--no-announce");
        }
        try {
            const out = await execAsync(args.join(" "), { timeout: 10000 });
            deleteCachedCli("tasks-list");
            json(res, 200, { ok: true, output: (out || "").trim() });
            return true;
        } catch (e: any) {
            json(res, 500, { error: `Failed to edit cron job: ${e.message}` });
            return true;
        }
    }

    // ─── POST /api/tasks/{id}/cancel — disable a cron job or heartbeat ───
    const taskCancelMatch = path.match(/^\/tasks\/([^/]+)\/cancel$/);
    if (taskCancelMatch && !path.startsWith("/tasks/flows") && method === "POST") {
        const taskId = decodeURIComponent(taskCancelMatch[1]);
        // Heartbeat disable (still in openclaw.json — heartbeats are agent config)
        let deferred = false;
        const hbMatch = taskId.match(/^heartbeat:(.+)$/);
        if (hbMatch) {
            const defer = url.searchParams?.get("defer") === "1";
            deferred = defer;
            const config = defer ? readEffectiveConfig() : readConfig();
            const agentId = hbMatch[1];
            const agent = (config.agents?.list || []).find((a: any) => a.id === agentId);
            if (agent?.heartbeat) {
                agent.heartbeat.enabled = false;
                if (defer) {
                    stageConfig(config, "Cancel heartbeat: " + agentId);
                } else {
                    writeConfig(config);
                }
            }
        }
        // For cron jobs, remove them
        try {
            await execAsync(`openclaw cron remove "${shellEsc(taskId)}"`, { timeout: 10000 });
        } catch { }
        deleteCachedCli("tasks-list");
        json(res, 200, { ok: true, deferred });
        return true;
    }

    // ─── POST /api/tasks/flows/save — generate flow definition + tool registration files ───
    if (path === "/tasks/flows/save" && method === "POST") {
        const body: SaveFlowRequest = await parseBody(req);
        const flow = body?.flow;

        // Validate required fields
        if (!flow || !flow.name || !flow.steps || flow.steps.length === 0) {
            json(res, 400, { error: "flow name and at least one step required" });
            return true;
        }

        // Validate flow definition (name format, step ids, agentIds, uniqueness)
        const validation = validateFlowDefinition(flow);
        if (!validation.valid) {
            json(res, 400, { error: validation.error });
            return true;
        }

        // Check flow name uniqueness against existing files in Tasks/ (skip if overwrite flag is set)
        const { flowFile } = deriveFileNames(flow.name);
        const overwrite = body?.overwrite === true;
        if (!overwrite && existsSync(DASHBOARD_FLOW_DEFS_DIR)) {
            const flowFilePath = join(DASHBOARD_FLOW_DEFS_DIR, flowFile);
            if (existsSync(flowFilePath)) {
                json(res, 409, { error: `Flow file already exists: Tasks/${flowFile}` });
                return true;
            }
        }

        // Create Tasks/ directory if it doesn't exist
        try {
            if (!existsSync(DASHBOARD_FLOW_DEFS_DIR)) {
                mkdirSync(DASHBOARD_FLOW_DEFS_DIR, { recursive: true });
            }
        } catch (e: any) {
            json(res, 500, { error: `Failed to create Tasks directory: ${e.message}` });
            return true;
        }

        // Generate and write flow definition file (no per-flow tool file needed)
        try {
            const flowContent = generateFlowDefinitionFile(flow);
            writeFileSync(join(DASHBOARD_FLOW_DEFS_DIR, flowFile), flowContent, "utf-8");
        } catch (e: any) {
            json(res, 500, { error: `Failed to write flow file: ${e.message}` });
            return true;
        }

        // Auto-add run_task_flow to the agent's alsoAllow if not already present
        try {
            const defer = url.searchParams?.get("defer") === "1";
            const config = defer ? readEffectiveConfig() : readConfig();
            const agents = config.agents?.list || [];
            const agent = agents.find((a: any) => a.id === flow.agentId);
            if (agent) {
                const tools = agent.tools || {};
                const also: string[] = tools.alsoAllow || tools.allow || [];
                if (!also.includes(TASK_FLOW_TOOL_ID)) {
                    if (!agent.tools) agent.tools = {};
                    agent.tools.alsoAllow = [...also, TASK_FLOW_TOOL_ID];
                    if (defer) {
                        stageConfig(config, "Add run_task_flow tool to agent: " + flow.agentId);
                    } else {
                        writeConfig(config);
                    }
                }
            }
        } catch (_e: any) {
            // Non-fatal — tool was saved, config update is best-effort
        }

        const toolId = TASK_FLOW_TOOL_ID;
        const snippet = generateAgentsMdSnippet(flow);

        const response: SaveFlowResponse = {
            ok: true,
            flowFile: `Tasks/${flowFile}`,
            toolId,
            snippet,
        };
        json(res, 200, response);
        return true;
    }

    // ─── GET /api/tasks/flows — list workflow execution records via CLI ───
    if (path === "/tasks/flows" && method === "GET") {
        const cached = getCachedCli("tasks-flows");
        if (cached) { json(res, 200, cached); return true; }

        try {
            const out = await execAsync("openclaw tasks flow list --json", { timeout: 10000 });
            const trimmed = (out || "").trim();
            if (!trimmed) {
                const result = { flows: [] };
                setCachedCli("tasks-flows", result);
                json(res, 200, result);
                return true;
            }
            const parsed = JSON.parse(trimmed);
            const flows: WorkflowExecutionRecord[] = Array.isArray(parsed) ? parsed : (parsed.flows || parsed.executions || []);
            const result = { flows };
            setCachedCli("tasks-flows", result);
            json(res, 200, result);
            return true;
        } catch (e: any) {
            json(res, 500, { error: `Task flow command failed: ${e.message}` });
            return true;
        }
    }

    // ─── POST /api/tasks/flows/:flowId/approve — approve a waiting flow ───
    const flowApproveMatch = path.match(/^\/tasks\/flows\/([^/]+)\/approve$/);
    if (flowApproveMatch && method === "POST") {
        const flowId = decodeURIComponent(flowApproveMatch[1]);
        let out: string;
        try {
            out = await execAsync(`openclaw tasks flow approve "${shellEsc(flowId)}"`, { timeout: 10000 });
        } catch (e: any) {
            out = e.message || "";
        }
        const lower = (out || "").toLowerCase();
        if (lower.includes("not found") || lower.includes("no such") || lower.includes("not exist")) {
            json(res, 404, { error: `Flow not found: ${flowId}` });
            return true;
        }
        if (lower.includes("not in waiting") || lower.includes("not waiting") || lower.includes("cannot approve") || lower.includes("conflict")) {
            json(res, 409, { error: "Flow is not in waiting state" });
            return true;
        }
        if (lower.includes("error") || lower.includes("fail")) {
            json(res, 500, { error: `Task flow command failed: ${out.trim()}` });
            return true;
        }
        json(res, 200, { ok: true });
        return true;
    }

    // ─── GET /api/tasks/flows/pending — list ALL active flows (running + waiting) with step progress ───
    if (path === "/tasks/flows/pending" && method === "GET") {
        const active: any[] = [];
        const config = readEffectiveConfig();
        const validAgentIds = new Set(["main", ...(config.agents?.list || []).map((a: any) => a.id)]);
        try {
            if (existsSync(DASHBOARD_FLOW_STATE_DIR)) {
                const files = readdirSync(DASHBOARD_FLOW_STATE_DIR).filter(f => f.endsWith(".json"));
                for (const file of files) {
                    try {
                        const raw = readFileSync(join(DASHBOARD_FLOW_STATE_DIR, file), "utf-8");
                        const state = JSON.parse(raw);
                        // Mark flows for deleted agents as orphaned instead of filtering them out
                        let orphaned = state.agentId && !validAgentIds.has(state.agentId);
                        // Enrich with flow definition steps for progress display
                        let totalSteps = 0;
                        let allStepIds: string[] = [];
                        try {
                            if (existsSync(DASHBOARD_FLOW_DEFS_DIR)) {
                                const flowFiles = readdirSync(DASHBOARD_FLOW_DEFS_DIR).filter((f2: string) => f2.endsWith(".flow.ts"));
                                for (const ff of flowFiles) {
                                    const content = readFileSync(join(DASHBOARD_FLOW_DEFS_DIR, ff), "utf-8");
                                    const parsed = parseFlowDefinitionFile(content);
                                    if (parsed && parsed.name === state.flowName) {
                                        totalSteps = parsed.steps.length;
                                        allStepIds = parsed.steps.map((s: any) => s.id);
                                        if (!orphaned && parsed.steps.some((s: any) => !validAgentIds.has(s.agentId))) {
                                            orphaned = true;
                                        }
                                        break;
                                    }
                                }
                            }
                        } catch { }
                        if (orphaned) {
                            state.orphaned = true;
                        }
                        state.totalSteps = totalSteps;
                        state.allStepIds = allStepIds;
                        // Skip cancelled flows — they'll be cleaned up shortly
                        if (state.status !== "cancelled") active.push(state);
                    } catch { }
                }
            }
        } catch { }
        // Return as "pending" for backward compat, but includes all active flows
        json(res, 200, { pending: active });
        return true;
    }

    // ─── GET /api/tasks/flows/history — list completed/cancelled flow executions (7-day retention) ───
    if (path === "/tasks/flows/history" && method === "GET") {
        const history: any[] = [];
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        try {
            if (existsSync(DASHBOARD_FLOW_HISTORY_DIR)) {
                const files = readdirSync(DASHBOARD_FLOW_HISTORY_DIR).filter(f => f.endsWith(".json"));
                for (const file of files) {
                    try {
                        const fp = join(DASHBOARD_FLOW_HISTORY_DIR, file);
                        const raw = readFileSync(fp, "utf-8");
                        const record = JSON.parse(raw);
                        const ts = new Date(record.completedAt || record.createdAt || 0).getTime();
                        if (ts < cutoff) {
                            // Auto-prune entries older than 7 days
                            try { unlinkSync(fp); } catch { }
                            continue;
                        }
                        history.push(record);
                    } catch { }
                }
            }
        } catch { }
        // Sort newest first
        history.sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime());
        json(res, 200, { history });
        return true;
    }

    // ─── DELETE /api/tasks/flows/history — clear all execution history ───
    if (path === "/tasks/flows/history" && method === "DELETE") {
        let deleted = 0;
        try {
            if (existsSync(DASHBOARD_FLOW_HISTORY_DIR)) {
                for (const file of readdirSync(DASHBOARD_FLOW_HISTORY_DIR)) {
                    try { unlinkSync(join(DASHBOARD_FLOW_HISTORY_DIR, file)); deleted++; } catch { }
                }
            }
        } catch { }
        json(res, 200, { ok: true, deleted });
        return true;
    }

    // ─── DELETE /api/tasks/flows/active — clear all active flow state files ───
    if (path === "/tasks/flows/active" && method === "DELETE") {
        let deleted = 0;
        try {
            if (existsSync(DASHBOARD_FLOW_STATE_DIR)) {
                for (const file of readdirSync(DASHBOARD_FLOW_STATE_DIR)) {
                    try { unlinkSync(join(DASHBOARD_FLOW_STATE_DIR, file)); deleted++; } catch { }
                }
            }
        } catch { }
        json(res, 200, { ok: true, deleted });
        return true;
    }

    // ─── POST /api/tasks/flows/cancel — cancel a specific active flow ───
    if (path === "/tasks/flows/cancel" && method === "POST") {
        const body = await parseBody(req);
        const token = body?.flowToken;
        if (!token) { json(res, 400, { error: "flowToken required" }); return true; }

        const statePath = join(DASHBOARD_FLOW_STATE_DIR, `${token}.json`);
        if (!existsSync(statePath)) {
            json(res, 404, { error: "Flow not found" });
            return true;
        }

        let state: any;
        try { state = JSON.parse(readFileSync(statePath, "utf-8")); } catch {
            json(res, 500, { error: "Failed to read flow state" });
            return true;
        }

        // Mark as cancelled in the state file — the tool will detect this and tell the agent
        state.status = "cancelled";
        try { writeFileSync(statePath, JSON.stringify(state), "utf-8"); } catch { }

        // Also save to history
        try {
            if (!existsSync(DASHBOARD_FLOW_HISTORY_DIR)) mkdirSync(DASHBOARD_FLOW_HISTORY_DIR, { recursive: true });
            const record = { ...state, completedAt: new Date().toISOString() };
            writeFileSync(join(DASHBOARD_FLOW_HISTORY_DIR, `${token}.json`), JSON.stringify(record), "utf-8");
        } catch { }

        // Delete state file after a delay so the agent has time to see the cancellation
        setTimeout(() => { try { unlinkSync(statePath); } catch { } }, 90000);

        json(res, 200, { ok: true, flowName: state.flowName });
        return true;
    }

    // ─── POST /api/tasks/flows/resume — approve or deny a paused flow from the dashboard ───
    if (path === "/tasks/flows/resume" && method === "POST") {
        const body = await parseBody(req);
        const token = body?.resumeToken || body?.flowToken;
        const approve = body?.approve;
        if (!token) { json(res, 400, { error: "flowToken required" }); return true; }
        if (typeof approve !== "boolean") { json(res, 400, { error: "approve (boolean) required" }); return true; }

        const statePath = join(DASHBOARD_FLOW_STATE_DIR, `${token}.json`);
        if (!existsSync(statePath)) {
            json(res, 404, { error: "Flow token not found or expired" });
            return true;
        }

        let state: any;
        try { state = JSON.parse(readFileSync(statePath, "utf-8")); } catch {
            json(res, 500, { error: "Failed to read flow state" });
            return true;
        }

        if (!approve) {
            try { unlinkSync(statePath); } catch { }
            json(res, 200, { ok: true, action: "denied", flowName: state.flowName, step: state.waitingAtStepId });
            return true;
        }

        // Approve — update state to running so the tool's resume handler will proceed
        state.status = "running";
        try { writeFileSync(statePath, JSON.stringify(state), "utf-8"); } catch { }

        // State is updated — the client-side dashboard will send the approval
        // message through the session API so it appears in the user's chat
        json(res, 200, { ok: true, action: "approved", flowName: state.flowName, step: state.waitingAtStepId, flowToken: token });
        return true;
    }

    // ─── DELETE /api/tasks/flows/:flowId — delete a workflow execution record ───
    const flowDeleteMatch = path.match(/^\/tasks\/flows\/([^/]+)$/);
    if (flowDeleteMatch && method === "DELETE") {
        const flowId = decodeURIComponent(flowDeleteMatch[1]);
        let out: string;
        try {
            out = await execAsync(`openclaw tasks flow delete "${shellEsc(flowId)}"`, { timeout: 10000 });
        } catch (e: any) {
            out = e.message || "";
        }
        const lower = (out || "").toLowerCase();
        if (lower.includes("not found") || lower.includes("no such") || lower.includes("not exist")) {
            json(res, 404, { error: `Flow not found: ${flowId}` });
            return true;
        }
        if (lower.includes("running") || lower.includes("active") || lower.includes("cannot delete") || lower.includes("conflict")) {
            json(res, 409, { error: "Cannot delete a running flow" });
            return true;
        }
        if (lower.includes("error") || lower.includes("fail")) {
            json(res, 500, { error: `Task flow command failed: ${out.trim()}` });
            return true;
        }
        deleteCachedCli("tasks-flows"); // invalidate cache
        json(res, 200, { ok: true });
        return true;
    }

    // ─── GET /api/tasks/flows/definitions — list ALL registered flow definitions ───
    if (path === "/tasks/flows/definitions" && method === "GET") {
        const flows: any[] = [];
        const config = readEffectiveConfig();
        const validAgentIds = new Set(["main", ...(config.agents?.list || []).map((a: any) => a.id)]);
        const pending = getPendingDestructiveOps().filter((op) => op.kind === "flow-definition");
        try {
            if (existsSync(DASHBOARD_FLOW_DEFS_DIR)) {
                const files = readdirSync(DASHBOARD_FLOW_DEFS_DIR).filter((f: string) => f.endsWith(".flow.ts"));
                for (const file of files) {
                    try {
                        const content = readFileSync(join(DASHBOARD_FLOW_DEFS_DIR, file), "utf-8");
                        const parsed = parseFlowDefinitionFile(content);
                        if (parsed && !pending.some((op) => op.agentId === parsed.agentId && op.flowName === parsed.name)) {
                            const orphaned = !validAgentIds.has(parsed.agentId) || parsed.steps.some((s: any) => !validAgentIds.has(s.agentId));
                            flows.push({
                                name: parsed.name,
                                description: parsed.description,
                                agentId: parsed.agentId,
                                stepCount: parsed.steps.length,
                                steps: parsed.steps.map((s: any) => ({ id: s.id, agentId: s.agentId, humanIntervention: s.humanIntervention })),
                                file: file,
                                orphaned,
                            });
                        }
                    } catch { }
                }
            }
        } catch { }
        json(res, 200, { flows });
        return true;
    }

    // ─── GET /api/tasks/flows/definition/:agentId — load flow definition for an agent ───
    const flowDefMatch = path.match(/^\/tasks\/flows\/definition\/([^/]+)$/);
    if (flowDefMatch && method === "GET") {
        const agentId = decodeURIComponent(flowDefMatch[1]);

        // 1. Try .flow.ts files in the definitions directory
        try {
            if (existsSync(DASHBOARD_FLOW_DEFS_DIR)) {
                const files = readdirSync(DASHBOARD_FLOW_DEFS_DIR).filter(f => f.endsWith(".flow.ts"));
                let foundTombstoned = false;
                for (const file of files) {
                    const content = readFileSync(join(DASHBOARD_FLOW_DEFS_DIR, file), "utf-8");
                    const parsed = parseFlowDefinitionFile(content);
                    if (parsed && parsed.agentId === agentId) {
                        if (isPendingFlowDefinitionDeletion(agentId, parsed.name)) {
                            foundTombstoned = true;
                            continue;
                        }
                        clearFlowDefinitionDeletedMarker(join(DASHBOARD_FLOW_DEFS_DIR, file));
                        json(res, 200, { flow: parsed });
                        return true;
                    }
                }
                if (foundTombstoned) {
                    json(res, 404, { error: "Flow definition not found" });
                    return true;
                }
            }
        } catch { /* fall through to AGENTS.md fallback */ }

        // 2. Fallback: parse the agent's AGENTS.md, generate + persist the .flow.ts definition
        try {
            const config = readEffectiveConfig();
            const agentsList = config.agents?.list || [];
            let agent = agentsList.find((a: any) => a.id === agentId);
            if (!agent && agentId === "main") agent = { id: "main" };
            if (agent) {
                const workspace = getAgentWorkspace(agent);
                const agentsMdPath = join(workspace, "AGENTS.md");
                const md = tryReadFile(agentsMdPath);
                if (md !== null) {
                    const flow = parseAgentsMdFlow(md, agentId);
                    if (flow) {
                        const flowFilePath = join(DASHBOARD_FLOW_DEFS_DIR, deriveFileNames(flow.name).flowFile);
                        if (isFlowDefinitionDeleted(flowFilePath)) {
                            json(res, 404, { error: "Flow definition not found" });
                            return true;
                        }
                        // Persist the definition so future loads hit the fast path
                        try {
                            if (!existsSync(DASHBOARD_FLOW_DEFS_DIR)) {
                                mkdirSync(DASHBOARD_FLOW_DEFS_DIR, { recursive: true });
                            }
                            const { flowFile } = deriveFileNames(flow.name);
                            const flowContent = generateFlowDefinitionFile(flow);
                            writeFileSync(join(DASHBOARD_FLOW_DEFS_DIR, flowFile), flowContent, "utf-8");
                            clearFlowDefinitionDeletedMarker(join(DASHBOARD_FLOW_DEFS_DIR, flowFile));
                        } catch { /* write failed — still return the parsed flow */ }
                        json(res, 200, { flow });
                        return true;
                    }
                }
            }
        } catch { /* non-fatal */ }

        json(res, 200, { flow: null });
        return true;
    }

    // ─── DELETE /api/tasks/flows/definition/:agentId/:flowName — delete a flow definition and disable tool ───
    const flowDefDeleteMatch = path.match(/^\/tasks\/flows\/definition\/([^/]+)\/([^/]+)$/);
    if (flowDefDeleteMatch && method === "DELETE") {
        const agentId = decodeURIComponent(flowDefDeleteMatch[1]);
        const flowName = decodeURIComponent(flowDefDeleteMatch[2]);
        const { flowFile } = deriveFileNames(flowName);
        const flowFilePath = join(DASHBOARD_FLOW_DEFS_DIR, flowFile);
        const defer = url.searchParams?.get("defer") === "1";

        if (!existsSync(flowFilePath)) {
            json(res, 404, { error: `Flow file not found: Tasks/${flowFile}` });
            return true;
        }

        // Check if any other flow files remain for this agent
        let hasOtherFlows = false;
        try {
            if (existsSync(DASHBOARD_FLOW_DEFS_DIR)) {
                const pendingFlowDeletes = new Set(
                    getPendingDestructiveOps()
                        .filter((op) => op.kind === "flow-definition" && op.agentId === agentId)
                        .map((op) => op.flowName),
                );
                const remaining = readdirSync(DASHBOARD_FLOW_DEFS_DIR).filter(f => f.endsWith(".flow.ts"));
                for (const file of remaining) {
                    if (file === flowFile) continue;
                    const content = readFileSync(join(DASHBOARD_FLOW_DEFS_DIR, file), "utf-8");
                    const parsed = parseFlowDefinitionFile(content);
                    if (parsed && parsed.agentId === agentId && !pendingFlowDeletes.has(parsed.name)) {
                        hasOtherFlows = true;
                        break;
                    }
                }
            }
        } catch { }

        // Remove run_task_flow from alsoAllow if no other flows remain for this agent
        if (!hasOtherFlows) {
            try {
                const config = defer ? readEffectiveConfig() : readConfig();
                const agents = config.agents?.list || [];
                const agent = agents.find((a: any) => a.id === agentId);
                if (agent) {
                    const tools = agent.tools || {};
                    const also: string[] = tools.alsoAllow || tools.allow || [];
                    const idx = also.indexOf(TASK_FLOW_TOOL_ID);
                    if (idx >= 0) {
                        if (!agent.tools) agent.tools = {};
                        agent.tools.alsoAllow = also.filter((t: string) => t !== TASK_FLOW_TOOL_ID);
                        if (defer) {
                            stageConfig(config, "Remove run_task_flow tool from agent: " + agentId);
                        } else {
                            writeConfig(config);
                        }
                    }
                }
            } catch { }
        }

        const applyRemoval = () => {
            try { unlinkSync(flowFilePath); } catch { }
            markFlowDefinitionDeleted(flowFilePath);
        };

        if (defer) {
            stagePendingDestructiveOp({
                kind: "flow-definition",
                key: `flow-definition:${agentId}:${flowName}`,
                agentId,
                flowName,
                path: flowFilePath,
                description: `Delete flow definition: ${flowName}`,
                apply: applyRemoval,
            });
        } else {
            applyRemoval();
        }

        json(res, 200, { ok: true, toolDisabled: !hasOtherFlows });
        return true;
    }

    return false;
}
