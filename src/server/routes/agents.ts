import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { stat as statAsync, readdir as readdirAsync, readFile as readFileAsync } from "node:fs/promises";
import { join, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    parseBody,
    readConfig,
    getConfigError,
    writeConfig,
    stageConfig,
    readEffectiveConfig,
    readDashboardConfig,
    writeDashboardConfig,
    stagePendingDestructiveOp,
    execAsync,
    execFileAsync,
    resolveHome,
    tryReadFile,
    getAgentWorkspace,
    getAgentDir,
    getAgentSessionsDir,
    AGENTS_STATE_DIR,
    WORKSPACE_MD_FILES,
    DASHBOARD_FLOW_DEFS_DIR,
    DASHBOARD_FLOW_STATE_DIR,
    DASHBOARD_FLOW_HISTORY_DIR,
} from "../api-utils.js";
import { parseFlowDefinitionFile, generateFlowDefinitionFile } from "../../orchestrator/codegen.js";

function cleanupFlowDefinitions(agentId: string): string[] {
    const warnings: string[] = [];
    if (!existsSync(DASHBOARD_FLOW_DEFS_DIR)) return warnings;
    const files = readdirSync(DASHBOARD_FLOW_DEFS_DIR).filter((f: string) => f.endsWith(".flow.ts"));
    for (const file of files) {
        const filePath = join(DASHBOARD_FLOW_DEFS_DIR, file);
        const content = readFileSync(filePath, "utf-8");
        const parsed = parseFlowDefinitionFile(content);
        if (!parsed) continue;
        if (parsed.agentId === agentId) {
            unlinkSync(filePath);
            warnings.push(`Deleted flow definition ${file} (controller ${agentId} was removed)`);
            continue;
        }
        const hasStepRef = parsed.steps.some((s: any) => s.agentId === agentId);
        if (!hasStepRef) continue;
        const newSteps = parsed.steps.filter((s: any) => s.agentId !== agentId);
        if (newSteps.length === 0) {
            unlinkSync(filePath);
            warnings.push(`Deleted flow definition ${file} (all steps referenced ${agentId})`);
            continue;
        }
        const updated = generateFlowDefinitionFile({ ...parsed, steps: newSteps });
        writeFileSync(filePath, updated, "utf-8");
        warnings.push(`Removed ${agentId} steps from flow definition ${file}`);
    }
    return warnings;
}

function getFlowDefinitionByName(flowName: string): any | null {
    if (!existsSync(DASHBOARD_FLOW_DEFS_DIR)) return null;
    const files = readdirSync(DASHBOARD_FLOW_DEFS_DIR).filter((f: string) => f.endsWith(".flow.ts"));
    for (const file of files) {
        const filePath = join(DASHBOARD_FLOW_DEFS_DIR, file);
        try {
            const content = readFileSync(filePath, "utf-8");
            const parsed = parseFlowDefinitionFile(content);
            if (parsed && parsed.name === flowName) return parsed;
        } catch {
            // Skip unreadable definition files
        }
    }
    return null;
}

function cleanupFlowState(agentId: string): string[] {
    const warnings: string[] = [];
    if (!existsSync(DASHBOARD_FLOW_STATE_DIR)) return warnings;
    const files = readdirSync(DASHBOARD_FLOW_STATE_DIR).filter((f: string) => f.endsWith(".json"));
    for (const file of files) {
        const filePath = join(DASHBOARD_FLOW_STATE_DIR, file);
        try {
            const content = readFileSync(filePath, "utf-8");
            const state = JSON.parse(content);
            const flowDef = state.flowName ? getFlowDefinitionByName(state.flowName) : null;
            const touchesDeletedAgent = !!(flowDef && (
                flowDef.agentId === agentId
                || flowDef.steps.some((step: any) => step.agentId === agentId)
            ));
            if (state.agentId === agentId || touchesDeletedAgent) {
                state.status = "cancelled";
                try {
                    if (!existsSync(DASHBOARD_FLOW_HISTORY_DIR)) {
                        mkdirSync(DASHBOARD_FLOW_HISTORY_DIR, { recursive: true });
                    }
                    const record = { ...state, completedAt: new Date().toISOString() };
                    writeFileSync(join(DASHBOARD_FLOW_HISTORY_DIR, file), JSON.stringify(record), "utf-8");
                } catch {
                    // Best-effort history save
                }
                unlinkSync(filePath);
                warnings.push(`Cancelled active flow ${state.flowName || file} because it referenced deleted agent ${agentId}`);
            }
        } catch {
            // Skip unreadable state files
        }
    }
    return warnings;
}

// ─── Agent enrichment — full detail (file reads, session counting) ───
export async function enrichAgent(agent: any, config: any): Promise<any> {
    const workspace = getAgentWorkspace(agent);
    const agentDir = getAgentDir(agent);
    const sessionsDir = getAgentSessionsDir(agent.id);

    // Merge dashboard-specific overrides (icons etc.)
    const dashCfg = readDashboardConfig();
    const dashIcon = dashCfg.icons?.[agent.id];

    // Find bindings for this agent (sync — no I/O)
    const bindings = (config.bindings || config.routing?.bindings || [])
        .filter((b: any) => b.agentId === agent.id);

    // Run all file I/O concurrently: MD file stats, extra MD discovery, session counting
    const mdFiles: Record<string, { exists: true; lines: number; size: number } | null> = {};
    const extraMdFiles: string[] = [];
    let sessionCount = 0;

    const [, , sessionResult] = await Promise.all([
        // 1. Stat known workspace MD files
        Promise.all(WORKSPACE_MD_FILES.map(async (f) => {
            const fp = join(workspace, f);
            try {
                const st = await statAsync(fp);
                mdFiles[f] = { exists: true, lines: Math.max(1, Math.round(st.size / 40)), size: st.size };
            } catch { /* file doesn't exist */ }
        })),

        // 2. Discover and stat extra .md files in workspace
        (async () => {
            try {
                const entries = await readdirAsync(workspace);
                await Promise.all(entries.map(async (f) => {
                    if (extname(f).toLowerCase() === ".md" && !WORKSPACE_MD_FILES.includes(f)) {
                        extraMdFiles.push(f);
                        const fp = join(workspace, f);
                        try {
                            const st = await statAsync(fp);
                            mdFiles[f] = { exists: true, lines: Math.max(1, Math.round(st.size / 40)), size: st.size };
                        } catch { }
                    }
                }));
            } catch { /* workspace doesn't exist */ }
        })(),

        // 3. Count sessions (from index + loose files)
        (async () => {
            try {
                const indexFile = join(sessionsDir, "sessions.json");
                const [dirEntries, indexContent] = await Promise.all([
                    readdirAsync(sessionsDir).catch(() => [] as string[]),
                    readFileAsync(indexFile, "utf-8").catch(() => null),
                ]);
                const looseFiles = dirEntries.filter((f: string) => (f.endsWith(".json") || f.endsWith(".jsonl")) && f !== "sessions.json");
                let indexCount = 0;
                if (indexContent) {
                    try { indexCount = Object.keys(JSON.parse(indexContent)).length; } catch { }
                }
                return Math.max(looseFiles.length, indexCount);
            } catch { return 0; }
        })(),
    ]);

    sessionCount = sessionResult;

    return {
        ...agent,
        ...(dashIcon ? { icon: dashIcon } : {}),
        workspace,
        agentDir,
        sessionsDir,
        mdFiles,
        extraMdFiles,
        bindings,
        sessionCount,
        tools: agent.tools || {},
        sandbox: agent.sandbox || {},
        identity: agent.identity || {},
        groupChat: agent.groupChat || {},
    };
}

// ─── Lightweight agent enrichment (no file reads, no session counting) ───
export function enrichAgentLight(agent: any, config: any, dashCfg: any): any {
    const workspace = getAgentWorkspace(agent);
    const agentDir = getAgentDir(agent);
    const dashIcon = dashCfg.icons?.[agent.id];
    const bindings = (config.bindings || config.routing?.bindings || [])
        .filter((b: any) => b.agentId === agent.id);

    return {
        ...agent,
        ...(dashIcon ? { icon: dashIcon } : {}),
        workspace,
        agentDir,
        bindings,
        tools: agent.tools || {},
        sandbox: agent.sandbox || {},
        identity: agent.identity || {},
        groupChat: agent.groupChat || {},
    };
}

// ─── Main handler ───
export async function handleAgentRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method ?? "GET";

    // ─── GET /api/overview — full dashboard data in one call ───
    if (path === "/overview" && method === "GET") {
        const fast = url.searchParams?.get("fast") === "1";
        const config = readEffectiveConfig();
        const agentsList = config.agents?.list || [];
        const agents = agentsList.length > 0 ? agentsList : [{ id: "main", default: true }];

        if (fast) {
            const dashCfg = readDashboardConfig();
            const enriched = agents.map((a: any) => enrichAgentLight(a, config, dashCfg));
            return json(res, 200, {
                agents: enriched,
                config,
                channels: config.channels || {},
                bindings: config.bindings || config.routing?.bindings || [],
                gateway: config.gateway || {},
                gatewayStatus: {},
                sessions: [],
                agentDefaults: config.agents?.defaults || {},
                configError: getConfigError(),
                _fast: true,
            }), true;
        }

        const dashCfg = readDashboardConfig();
        const enriched = agents.map((a: any) => enrichAgentLight(a, config, dashCfg));

        // Gateway status + sessions — async to avoid blocking the event loop
        const [gatewayStatus, cliSessions] = await Promise.all([
            execAsync("openclaw status --json", { timeout: 8000 }).then((out) => {
                try {
                    const raw = (out || "{}").trim();
                    const jsonStart = raw.indexOf("{");
                    return JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
                } catch { return {}; }
            }).catch(() => ({})),
            execAsync("openclaw sessions --all-agents --json", { timeout: 10000 }).then((out) => {
                try {
                    const raw = (out || "{}").trim();
                    const jsonStart = raw.indexOf("{");
                    const p = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
                    return (p.sessions || []).map((s: any) => {
                        let messageCount = 0;
                        const sid = s.sessionId;
                        const agentId = s.agentId || "";
                        if (sid && agentId) {
                            const jsonlPath = join(AGENTS_STATE_DIR, agentId, "sessions", sid + ".jsonl");
                            try {
                                // Estimate message count from file size instead of reading entire file into memory.
                                // Average JSONL message line is ~500 bytes; subtract ~200 for the session header line.
                                const st = statSync(jsonlPath);
                                messageCount = Math.max(0, Math.round((st.size - 200) / 500));
                            } catch { }
                        }
                        return {
                            sessionKey: sid || s.key,
                            agentId,
                            channel: s.kind || "",
                            messageCount,
                            updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
                            createdAt: s.updatedAt ? new Date(s.updatedAt - (s.ageMs || 0)).toISOString() : null,
                            model: s.model || null,
                            inputTokens: s.inputTokens || 0,
                            outputTokens: s.outputTokens || 0,
                            gatewayKey: s.key || null,
                        };
                    });
                } catch { return []; }
            }).catch(() => []),
        ]);

        const sessions = Array.isArray(cliSessions) ? cliSessions : [];

        json(res, 200, {
            agents: enriched,
            config,
            channels: config.channels || {},
            bindings: config.bindings || config.routing?.bindings || [],
            gateway: config.gateway || {},
            gatewayStatus,
            sessions: sessions.filter((s: any) => (s.sessionKey || s.id || "") !== "sessions"),
            agentDefaults: config.agents?.defaults || {},
            configError: getConfigError(),
        });
        return true;
    }

    // ─── GET /api/agents/{id} — single agent full detail ───
    const agentDetailMatch = path.match(/^\/agents\/([^/]+)$/);
    if (agentDetailMatch && method === "GET") {
        const agentId = decodeURIComponent(agentDetailMatch[1]);
        const config = readEffectiveConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main", default: true };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;
        json(res, 200, { agent: await enrichAgent(agent, config) });
        return true;
    }

    // ─── PUT /api/agents/{id} — update agent in openclaw.json ───
    const agentUpdateMatch = path.match(/^\/agents\/([^/]+)$/);
    if (agentUpdateMatch && method === "PUT") {
        const agentId = decodeURIComponent(agentUpdateMatch[1]);
        const body = await parseBody(req);
        const defer = url.searchParams?.get("defer") === "1";

        // Strip icon from main config — store in dashboard extension config instead
        if (body.icon !== undefined) {
            const dashCfg = readDashboardConfig();
            if (!dashCfg.icons) dashCfg.icons = {};
            dashCfg.icons[agentId] = body.icon;
            writeDashboardConfig(dashCfg);
            delete body.icon;
        }

        // Strip agentToAgent from per-agent tools — it's only valid at global tools level
        if (body.tools && body.tools.agentToAgent !== undefined) {
            delete body.tools.agentToAgent;
        }

        const config = defer ? readEffectiveConfig() : readConfig();
        if (!config.agents) config.agents = {};
        if (!config.agents.list) config.agents.list = [];

        const idx = config.agents.list.findIndex((a: any) => a.id === agentId);
        if (idx >= 0) {
            config.agents.list[idx] = { ...config.agents.list[idx], ...body, id: agentId };
            if (config.agents.list[idx].tools?.agentToAgent) {
                delete config.agents.list[idx].tools.agentToAgent;
            }
            if (body.heartbeat === null) {
                delete config.agents.list[idx].heartbeat;
            }
            if (body.thinkingDefault === null) {
                delete config.agents.list[idx].thinkingDefault;
            }
            if (body.reasoningDefault === null) {
                delete config.agents.list[idx].reasoningDefault;
            }
        } else {
            config.agents.list.push({ ...body, id: agentId });
        }
        if (defer) {
            stageConfig(config, "Update agent: " + agentId);
            json(res, 200, { ok: true, deferred: true, agent: config.agents.list.find((a: any) => a.id === agentId) });
        } else {
            writeConfig(config);
            json(res, 200, { ok: true, agent: config.agents.list.find((a: any) => a.id === agentId) });
        }
        return true;
    }

    // ─── POST /api/agents — create new agent ───
    if (path === "/agents" && method === "POST") {
        const body = await parseBody(req);
        if (!body.id) return json(res, 400, { error: "id required" }), true;
        const defer = url.searchParams?.get("defer") === "1";
        const config = defer ? readEffectiveConfig() : readConfig();
        if (!config.agents) config.agents = {};
        if (!config.agents.list) config.agents.list = [];
        if (config.agents.list.some((a: any) => a.id === body.id)) {
            return json(res, 409, { error: "Agent already exists" }), true;
        }

        const workspace = body.workspace || `~/.openclaw/workspace-${body.id}`;
        const newAgent: any = {
            id: body.id,
            name: body.name || body.id,
            workspace,
            ...(body.model ? { model: body.model } : {}),
            ...(body.default ? { default: true } : {}),
        };
        config.agents.list.push(newAgent);

        // Create workspace directory with default MD files
        const wsPath = resolveHome(workspace);
        if (!existsSync(wsPath)) mkdirSync(wsPath, { recursive: true });
        for (const f of WORKSPACE_MD_FILES) {
            const fp = join(wsPath, f);
            if (!existsSync(fp)) {
                writeFileSync(fp, `# ${f.replace(".md", "")}\n\n`, "utf-8");
            }
        }

        if (defer) {
            stageConfig(config, "Create agent: " + body.id);
            json(res, 201, { ok: true, deferred: true, agent: newAgent });
        } else {
            writeConfig(config);
            json(res, 201, { ok: true, agent: newAgent });
        }
        return true;
    }

    // ─── DELETE /api/agents/{id} ───
    const agentDeleteMatch = path.match(/^\/agents\/([^/]+)$/);
    if (agentDeleteMatch && method === "DELETE") {
        const agentId = decodeURIComponent(agentDeleteMatch[1]);
        const defer = url.searchParams?.get("defer") === "1";
        const config = defer ? readEffectiveConfig() : readConfig();
        if (!config.agents?.list) return json(res, 404, { error: "No agents" }), true;
        config.agents.list = config.agents.list.filter((a: any) => a.id !== agentId);
        if (config.bindings) {
            config.bindings = config.bindings.filter((b: any) => b.agentId !== agentId);
        }
        if (config.routing?.bindings) {
            config.routing.bindings = config.routing.bindings.filter((b: any) => b.agentId !== agentId);
        }

        // Remove deleted agent from other agents' subagents.allowAgents
        const warnings: string[] = [];
        for (const other of config.agents.list || []) {
            const allowed = other.subagents?.allowAgents;
            if (Array.isArray(allowed) && allowed.includes(agentId)) {
                other.subagents.allowAgents = allowed.filter((id: string) => id !== agentId);
                if (other.subagents.allowAgents.length === 0) {
                    delete other.subagents.allowAgents;
                }
                if (Object.keys(other.subagents).length === 0) {
                    delete other.subagents;
                }
                warnings.push(`Removed ${agentId} from ${other.id} subagents.allowAgents`);
            }
        }

        // Remove deleted agent from global tools.agentToAgent.allow
        const a2a = config.tools?.agentToAgent;
        if (a2a && Array.isArray(a2a.allow) && a2a.allow.includes(agentId)) {
            a2a.allow = a2a.allow.filter((id: string) => id !== agentId);
            if (a2a.allow.length === 0) {
                delete config.tools.agentToAgent;
                if (Object.keys(config.tools || {}).length === 0) {
                    delete config.tools;
                }
            }
            warnings.push(`Removed ${agentId} from tools.agentToAgent.allow`);
        }

        const applyCleanup = () => {
            try {
                warnings.push(...cleanupFlowState(agentId));
            } catch {
                // Non-fatal — runtime cleanup is best-effort
            }
            try {
                warnings.push(...cleanupFlowDefinitions(agentId));
            } catch {
                // Non-fatal — flow cleanup is best-effort
            }
        };

        if (defer) {
            stagePendingDestructiveOp({
                kind: "agent",
                key: `agent:${agentId}`,
                agentId,
                description: `Delete agent: ${agentId}`,
                apply: applyCleanup,
            });
            warnings.push(`Flow/runtime cleanup will run on Apply & Restart for ${agentId}.`);
        } else {
            applyCleanup();
        }

        if (defer) {
            stageConfig(config, "Delete agent: " + agentId);
            json(res, 200, { ok: true, deferred: true, warnings: warnings.length > 0 ? warnings : undefined });
        } else {
            writeConfig(config);
            json(res, 200, { ok: true, warnings: warnings.length > 0 ? warnings : undefined });
        }
        return true;
    }

    // ─── MD file read/write ───
    const mdMatch = path.match(/^\/agents\/([^/]+)\/md\/(.+)$/);
    if (mdMatch && !path.includes("/generate")) {
        const agentId = decodeURIComponent(mdMatch[1]);
        const filename = decodeURIComponent(mdMatch[2]);
        const config = readEffectiveConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;

        const workspace = getAgentWorkspace(agent);
        const filePath = join(workspace, filename);
        if (!filePath.startsWith(workspace)) return json(res, 403, { error: "Path traversal" }), true;

        if (method === "GET") {
            const content = tryReadFile(filePath);
            if (content === null) return json(res, 404, { error: "File not found" }), true;
            json(res, 200, { filename, content });
            return true;
        }
        if (method === "PUT") {
            if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
            const body = await parseBody(req);
            writeFileSync(filePath, body.content ?? "", "utf-8");
            json(res, 200, { ok: true });
            return true;
        }
        if (method === "DELETE") {
            if (existsSync(filePath)) unlinkSync(filePath);
            json(res, 200, { ok: true });
            return true;
        }
    }

    // ─── Bindings CRUD ───
    if (path === "/bindings" && method === "GET") {
        const config = readEffectiveConfig();
        json(res, 200, { bindings: config.bindings || config.routing?.bindings || [] });
        return true;
    }
    if (path === "/bindings" && method === "PUT") {
        const body = await parseBody(req);
        const defer = url.searchParams?.get("defer") === "1";
        const config = defer ? readEffectiveConfig() : readConfig();
        config.bindings = body.bindings || [];
        if (config.routing?.bindings) delete config.routing.bindings;
        if (defer) {
            stageConfig(config, "Update bindings");
            json(res, 200, { ok: true, deferred: true });
        } else {
            writeConfig(config);
            json(res, 200, { ok: true });
        }
        return true;
    }

    // ─── POST /api/agents/{id}/generate-all — generate all workspace MD files from description ───
    const genAllMatch = path.match(/^\/agents\/([^/]+)\/generate-all$/);
    if (genAllMatch && method === "POST") {
        const agentId = decodeURIComponent(genAllMatch[1]);
        const body = await parseBody(req);
        const description = (body.description || "").trim();
        const model = (body.model || "").trim();
        if (!description) return json(res, 400, { error: "description required" }), true;
        const config = readEffectiveConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;
        const workspace = getAgentWorkspace(agent);
        if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
        const results: Record<string, string> = {};
        const filesToGenerate = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md", "BOOTSTRAP.md"];
        const fileDescriptions: Record<string, string> = {
            "SOUL.md": "the agent's core personality, values, communication style, and behavioural guidelines",
            "IDENTITY.md": "the agent's name, role, purpose, and how it introduces itself",
            "AGENTS.md": "instructions about how this agent coordinates with other agents and its place in the system",
            "TOOLS.md": "guidelines for how this agent should use its available tools",
            "BOOTSTRAP.md": "startup instructions and initial context the agent needs when a session begins",
        };
        for (const filename of filesToGenerate) {
            const desc = fileDescriptions[filename] || filename;
            const prompt = `You are writing ${filename} for an AI agent. This file contains ${desc}. Based on the agent description below, write a complete, well-structured markdown file. Output ONLY the markdown content, no preamble or explanation.\n\nAgent description:\n${description}`;
            try {
                const modelArgs = model ? ["--model", model] : [];
                let result = await execFileAsync("openclaw", ["agent", "--message", prompt, ...modelArgs, "--no-session"], { timeout: 120000 });
                if (!result.trim()) {
                    result = await execFileAsync("openclaw", ["agent", "--message", prompt, ...modelArgs], { timeout: 120000 });
                }
                const content = result.trim();
                writeFileSync(join(workspace, filename), content, "utf-8");
                results[filename] = "ok";
            } catch (err: any) {
                results[filename] = "error: " + err.message;
            }
        }
        json(res, 200, { ok: true, results });
        return true;
    }

    // ─── POST /api/agents/{id}/md/{file}/generate — generate MD from notes via model ───
    const mdGenMatch = path.match(/^\/agents\/([^/]+)\/md\/(.+)\/generate$/);
    if (mdGenMatch && method === "POST") {
        const agentId = decodeURIComponent(mdGenMatch[1]);
        const filename = decodeURIComponent(mdGenMatch[2]);
        const body = await parseBody(req);
        const notes = (body.notes || "").trim();
        const model = (body.model || "").trim();
        if (!notes) return json(res, 400, { error: "notes required" }), true;
        const config = readEffectiveConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;
        const workspace = getAgentWorkspace(agent);
        const filePath = join(workspace, filename);
        if (!filePath.startsWith(workspace)) return json(res, 403, { error: "Path traversal" }), true;
        const prompt = `You are generating a ${filename} file for an AI agent. Based on the following notes, write a complete, well-structured markdown file. Output ONLY the markdown content, no preamble.\n\nNotes:\n${notes}`;
        const modelArgs = model ? ["--model", model] : [];
        try {
            let result = await execFileAsync("openclaw", ["agent", "--message", prompt, ...modelArgs, "--no-session"], { timeout: 120000 });
            if (!result.trim()) {
                result = await execFileAsync("openclaw", ["agent", "--message", prompt, ...modelArgs], { timeout: 120000 });
            }
            const content = result.trim();
            if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
            writeFileSync(filePath, content, "utf-8");
            json(res, 200, { ok: true, content });
            return true;
        } catch (err: any) {
            json(res, 500, { error: err.message });
            return true;
        }
    }

    // Not handled by this module
    return false;
}
