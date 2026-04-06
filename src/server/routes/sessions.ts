import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { stat as statAsync, readdir as readdirAsync, readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    parseBody,
    readConfig,
    execAsync,
    resolveHome,
    tryReadFile,
    AGENTS_STATE_DIR,
    DASHBOARD_SESSIONS_DIR,
} from "../api-utils.js";

// ─── JSONL session parser ───
function parseSessionJsonl(filePath: string): { messages: any[]; agentId: string; channel: string; updatedAt: string | null } {
    const raw = readFileSync(filePath, "utf-8");
    const messages: any[] = [];
    let agentId = "";
    let channel = "";
    let updatedAt: string | null = null;
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === "session") {
                agentId = entry.agentId || agentId;
                channel = entry.channel || channel;
            }
            if (entry.type === "message" && entry.message) {
                messages.push(entry.message);
                if (entry.timestamp) updatedAt = entry.timestamp;
            }
        } catch { }
    }
    return { messages, agentId, channel, updatedAt };
}

// ─── Dashboard Session Store ───
function ensureSessionsDir(): void {
    if (!existsSync(DASHBOARD_SESSIONS_DIR)) {
        mkdirSync(DASHBOARD_SESSIONS_DIR, { recursive: true });
    }
}

function sessionFilePath(key: string): string {
    const safe = key.replace(/[<>:"/\\|?*]/g, "_");
    return join(DASHBOARD_SESSIONS_DIR, safe + ".json");
}

function readDashboardSession(key: string): any | null {
    const fp = sessionFilePath(key);
    const raw = tryReadFile(fp);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

function writeDashboardSession(session: any): void {
    ensureSessionsDir();
    const fp = sessionFilePath(session.sessionKey);
    writeFileSync(fp, JSON.stringify(session, null, 2), "utf-8");
}

function deleteDashboardSession(key: string): boolean {
    const fp = sessionFilePath(key);
    if (!existsSync(fp)) return false;
    try { unlinkSync(fp); return true; } catch { return false; }
}

async function listDashboardSessions(): Promise<any[]> {
    ensureSessionsDir();
    const sessions: any[] = [];
    try {
        for (const f of await readdirAsync(DASHBOARD_SESSIONS_DIR)) {
            if (!f.endsWith(".json")) continue;
            try {
                const raw = await readFileAsync(join(DASHBOARD_SESSIONS_DIR, f), "utf-8");
                const s = JSON.parse(raw);
                sessions.push({
                    sessionKey: s.sessionKey || f.replace(".json", ""),
                    agentId: s.agentId || "",
                    channel: s.channel || "dashboard",
                    messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
                    updatedAt: s.updatedAt || s.createdAt || null,
                });
            } catch { }
        }
    } catch { }
    return sessions;
}

// ─── Gateway HTTP API caller ───
function getGatewayPort(config?: any): number {
    if (!config) config = readConfig();
    return config?.gateway?.port || 18789;
}

function callGatewayChat(agentId: string, message: string, sessionKey: string, config?: any): Promise<string> {
    if (!config) config = readConfig();
    const port = getGatewayPort(config);
    const authToken = config?.gateway?.auth?.token || "";
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: agentId || "default",
            messages: [{ role: "user", content: message }],
            stream: false,
            session_id: sessionKey,
        });
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(postData)),
        };
        if (authToken) {
            headers["Authorization"] = "Bearer " + authToken;
        }
        const options = {
            hostname: "127.0.0.1",
            port,
            path: "/v1/chat/completions",
            method: "POST",
            headers,
            timeout: 180000,
        };
        const req = http.request(options, (res) => {
            let body = "";
            res.on("data", (chunk: any) => body += chunk);
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 400) {
                    try {
                        const err = JSON.parse(body);
                        reject(new Error(err.error || err.message || `HTTP ${res.statusCode}`));
                    } catch {
                        reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                    }
                    return;
                }
                try {
                    const parsed = JSON.parse(body);
                    const content = parsed?.choices?.[0]?.message?.content
                        || parsed?.result
                        || parsed?.response
                        || body.trim();
                    resolve(content);
                } catch {
                    resolve(body.trim() || "(empty response)");
                }
            });
        });
        req.on("error", (e) => reject(e));
        req.on("timeout", () => { req.destroy(); reject(new Error("Gateway request timed out")); });
        req.write(postData);
        req.end();
    });
}

// ─── Scan all agent session dirs on disk + merge dashboard sessions ───
async function scanAllSessions(initialSessions: any[] = []): Promise<any[]> {
    const sessions: any[] = [...initialSessions];
    const seen = new Set(sessions.map((s: any) => s.sessionKey || s.id));

    let agentDirs: string[] = [];
    try { agentDirs = await readdirAsync(AGENTS_STATE_DIR); } catch { }

    if (agentDirs.length > 0) {
        const scanAgent = async (agentId: string) => {
            const results: any[] = [];
            const localSeen = new Set<string>();
            const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
            try { await statAsync(sessDir); } catch { return results; }

            // Read sessions.json index if it exists
            const indexFile = join(sessDir, "sessions.json");
            try {
                const sessIndex = JSON.parse(await readFileAsync(indexFile, "utf-8"));
                for (const [key, val] of Object.entries(sessIndex)) {
                    const meta = val as any;
                    const sid = meta.sessionId || key;
                    localSeen.add(sid);
                    localSeen.add(key);
                    let updatedAt: string | null = meta.updatedAt || meta.lastUpdated || null;
                    let messageCount = 1;
                    for (const ext of [".jsonl", ".json"]) {
                        const fp = join(sessDir, sid + ext);
                        try {
                            const st = await statAsync(fp);
                            updatedAt = updatedAt || st.mtime.toISOString();
                            if (ext === ".jsonl") messageCount = Math.max(1, Math.round(st.size / 500));
                            break;
                        } catch { }
                    }
                    results.push({
                        sessionKey: sid,
                        agentId: meta.agentId || agentId,
                        channel: meta.channel || meta.channelType || "",
                        messageCount,
                        updatedAt,
                    });
                }
            } catch { }

            // Scan loose session files not in the index
            let files: string[] = [];
            try { files = await readdirAsync(sessDir); } catch { return results; }
            for (const f of files) {
                if (f === "sessions.json") continue;
                const isJsonl = f.endsWith(".jsonl");
                const isJson = f.endsWith(".json");
                if (!isJson && !isJsonl) continue;
                const sk = f.replace(/\.(jsonl|json)$/, "");
                if (localSeen.has(sk)) continue;
                localSeen.add(sk);
                try {
                    const fp = join(sessDir, f);
                    const st = await statAsync(fp);
                    let fileAgentId = agentId;
                    let channel = "";
                    if (isJsonl) {
                        try {
                            const head = (await readFileAsync(fp, "utf-8")).slice(0, 2000);
                            const firstLine = head.split("\n")[0];
                            if (firstLine) {
                                const entry = JSON.parse(firstLine);
                                if (entry.agentId) fileAgentId = entry.agentId;
                                if (entry.channel) channel = entry.channel;
                            }
                        } catch { }
                    } else {
                        try {
                            const raw = JSON.parse(await readFileAsync(fp, "utf-8"));
                            if (raw.agentId) fileAgentId = raw.agentId;
                            if (raw.channel || raw.channelType) channel = raw.channel || raw.channelType;
                        } catch { }
                    }
                    results.push({
                        sessionKey: sk,
                        agentId: fileAgentId,
                        channel,
                        messageCount: isJsonl ? Math.max(1, Math.round(st.size / 500)) : 1,
                        updatedAt: st.mtime.toISOString(),
                    });
                } catch { }
            }
            return results;
        };

        try {
            const allResults = await Promise.all(agentDirs.map(scanAgent));
            for (const agentResults of allResults) {
                for (const s of agentResults) {
                    if (seen.has(s.sessionKey)) continue;
                    seen.add(s.sessionKey);
                    sessions.push(s);
                }
            }
        } catch { }
    }

    // Merge dashboard session store — but skip entries where the agent already has a gateway session
    const dashSess = await listDashboardSessions();
    const seenFinal = new Set(sessions.map((s: any) => s.sessionKey || s.id));
    const seenAgents = new Set(sessions.map((s: any) => s.agentId).filter(Boolean));
    for (const ds of dashSess) {
        if (seenFinal.has(ds.sessionKey)) continue;
        if (ds.agentId && seenAgents.has(ds.agentId)) continue;
        sessions.push(ds);
    }

    return sessions;
}

// ─── In-memory session index with TTL ───
const SESSION_CACHE_TTL_MS = 30_000; // 30 seconds
let sessionCache: any[] | null = null;
let sessionCacheTimestamp = 0;

function isSessionCacheValid(): boolean {
    return sessionCache !== null && (Date.now() - sessionCacheTimestamp) < SESSION_CACHE_TTL_MS;
}

function setSessionCache(sessions: any[]): void {
    sessionCache = sessions;
    sessionCacheTimestamp = Date.now();
}

// ─── Scan sessions for a single agent (fast, targeted) ───
async function scanAgentSessions(agentId: string): Promise<any[]> {
    const results: any[] = [];
    const localSeen = new Set<string>();
    const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
    try { await statAsync(sessDir); } catch { return results; }

    // Read sessions.json index if it exists
    const indexFile = join(sessDir, "sessions.json");
    try {
        const sessIndex = JSON.parse(await readFileAsync(indexFile, "utf-8"));
        for (const [key, val] of Object.entries(sessIndex)) {
            const meta = val as any;
            const sid = meta.sessionId || key;
            localSeen.add(sid);
            localSeen.add(key);
            let updatedAt: string | null = meta.updatedAt || meta.lastUpdated || null;
            let messageCount = 1;
            for (const ext of [".jsonl", ".json"]) {
                const fp = join(sessDir, sid + ext);
                try {
                    const st = await statAsync(fp);
                    updatedAt = updatedAt || st.mtime.toISOString();
                    if (ext === ".jsonl") messageCount = Math.max(1, Math.round(st.size / 500));
                    break;
                } catch { }
            }
            results.push({
                sessionKey: sid,
                agentId: meta.agentId || agentId,
                channel: meta.channel || meta.channelType || "",
                messageCount,
                updatedAt,
            });
        }
    } catch { }

    // Scan loose session files not in the index
    let files: string[] = [];
    try { files = await readdirAsync(sessDir); } catch { return results; }
    for (const f of files) {
        if (f === "sessions.json") continue;
        const isJsonl = f.endsWith(".jsonl");
        const isJson = f.endsWith(".json");
        if (!isJson && !isJsonl) continue;
        const sk = f.replace(/\.(jsonl|json)$/, "");
        if (localSeen.has(sk)) continue;
        localSeen.add(sk);
        try {
            const fp = join(sessDir, f);
            const st = await statAsync(fp);
            let fileAgentId = agentId;
            let channel = "";
            if (isJsonl) {
                try {
                    const head = (await readFileAsync(fp, "utf-8")).slice(0, 2000);
                    const firstLine = head.split("\n")[0];
                    if (firstLine) {
                        const entry = JSON.parse(firstLine);
                        if (entry.agentId) fileAgentId = entry.agentId;
                        if (entry.channel) channel = entry.channel;
                    }
                } catch { }
            } else {
                try {
                    const raw = JSON.parse(await readFileAsync(fp, "utf-8"));
                    if (raw.agentId) fileAgentId = raw.agentId;
                    if (raw.channel || raw.channelType) channel = raw.channel || raw.channelType;
                } catch { }
            }
            results.push({
                sessionKey: sk,
                agentId: fileAgentId,
                channel,
                messageCount: isJsonl ? Math.max(1, Math.round(st.size / 500)) : 1,
                updatedAt: st.mtime.toISOString(),
            });
        } catch { }
    }
    return results;
}

// ─── Per-agent session cache ───
const agentSessionCache: Map<string, { sessions: any[]; timestamp: number }> = new Map();
const AGENT_SESSION_CACHE_TTL_MS = 30_000;

function getAgentSessionCache(agentId: string): any[] | null {
    const entry = agentSessionCache.get(agentId);
    if (!entry) return null;
    if ((Date.now() - entry.timestamp) >= AGENT_SESSION_CACHE_TTL_MS) return null;
    return entry.sessions;
}

function setAgentSessionCache(agentId: string, sessions: any[]): void {
    agentSessionCache.set(agentId, { sessions, timestamp: Date.now() });
}

// ─── Route handler ───
export async function handleSessionRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
): Promise<boolean> {
    const sessionMatch = path.match(/^\/sessions(\/(.+))?$/);
    if (!sessionMatch) return false;

    const method = req.method ?? "GET";
    const sub = (sessionMatch[2] ?? "").split("/").filter(Boolean);

    try {
        // GET /sessions/agent/{agentId} — list sessions for a single agent (fast, targeted)
        if (method === "GET" && sub.length === 2 && sub[0] === "agent") {
            const agentId = decodeURIComponent(sub[1]);
            const scan = url.searchParams.get("scan") === "1";

            // If scan=1, always do a fresh disk scan (used when drawer opens)
            if (scan) {
                // Try CLI first for this specific agent, fall back to disk scan
                let sessions: any[] = [];
                try {
                    const cliPath = join(resolveHome("~"), ".npm-global", "bin", "openclaw");
                    const r = await execAsync(`${cliPath} sessions --agent "${agentId}" --json`, { timeout: 8000 });
                    const parsed = JSON.parse((r || "{}").trim());
                    sessions = (parsed.sessions || []).map((s: any) => {
                        let messageCount = 0;
                        const sid = s.sessionId;
                        const aid = s.agentId || agentId;
                        if (sid && aid) {
                            const jsonlPath = join(AGENTS_STATE_DIR, aid, "sessions", sid + ".jsonl");
                            try {
                                const st = statSync(jsonlPath);
                                messageCount = Math.max(1, Math.round(st.size / 500));
                            } catch { messageCount = 0; }
                        }
                        return {
                            sessionKey: sid || s.key,
                            agentId: aid,
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
                } catch {
                    // Fall back to disk scan for this agent
                    sessions = await scanAgentSessions(agentId);
                }

                // Also include subagent sessions (scan their dirs too)
                const config = readConfig();
                const agentCfg = (config.agents?.list || []).find((a: any) => a.id === agentId);
                const childIds: string[] = agentCfg?.subagents?.allowAgents || [];
                if (childIds.length > 0) {
                    const childResults = await Promise.all(childIds.map(cid => scanAgentSessions(cid)));
                    for (const cr of childResults) sessions.push(...cr);
                }

                // Merge dashboard sessions for this agent
                const dashSess = await listDashboardSessions();
                const seenKeys = new Set(sessions.map((s: any) => s.sessionKey));
                for (const ds of dashSess) {
                    if (ds.agentId === agentId && !seenKeys.has(ds.sessionKey)) {
                        sessions.push(ds);
                    }
                }

                // Deduplicate
                const seen = new Set<string>();
                sessions = sessions.filter(s => {
                    const k = s.sessionKey || s.id;
                    if (seen.has(k)) return false;
                    seen.add(k);
                    return true;
                });

                setAgentSessionCache(agentId, sessions);
                json(res, 200, { sessions, agentId });
                return true;
            }

            // Without scan=1, return cached if available
            const cached = getAgentSessionCache(agentId);
            if (cached) {
                json(res, 200, { sessions: cached, agentId });
                return true;
            }

            // No cache — do a disk scan
            let sessions = await scanAgentSessions(agentId);
            const config = readConfig();
            const agentCfg = (config.agents?.list || []).find((a: any) => a.id === agentId);
            const childIds: string[] = agentCfg?.subagents?.allowAgents || [];
            if (childIds.length > 0) {
                const childResults = await Promise.all(childIds.map(cid => scanAgentSessions(cid)));
                for (const cr of childResults) sessions.push(...cr);
            }
            const dashSess = await listDashboardSessions();
            const seenKeys = new Set(sessions.map((s: any) => s.sessionKey));
            for (const ds of dashSess) {
                if (ds.agentId === agentId && !seenKeys.has(ds.sessionKey)) {
                    sessions.push(ds);
                }
            }
            const seen = new Set<string>();
            sessions = sessions.filter(s => {
                const k = s.sessionKey || s.id;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });
            setAgentSessionCache(agentId, sessions);
            json(res, 200, { sessions, agentId });
            return true;
        }

        // GET /sessions — list all sessions
        if (method === "GET" && sub.length === 0) {
            const fast = url.searchParams.get("fast") === "1";

            // Return cached data if fast=1 and cache is valid
            if (fast && isSessionCacheValid()) {
                json(res, 200, { sessions: sessionCache! });
                return true;
            }

            let sessions: any[] = [];
            try {
                const cliPath = join(resolveHome("~"), ".npm-global", "bin", "openclaw");
                const r = await execAsync(`${cliPath} sessions --all-agents --json`, { timeout: 10000 });
                const parsed = JSON.parse((r || "{}").trim());
                sessions = (parsed.sessions || []).map((s: any) => {
                    let messageCount = 0;
                    const sid = s.sessionId;
                    const agentId = s.agentId || "";
                    if (sid && agentId) {
                        const jsonlPath = join(AGENTS_STATE_DIR, agentId, "sessions", sid + ".jsonl");
                        try {
                            const st = statSync(jsonlPath);
                            messageCount = Math.max(1, Math.round(st.size / 500));
                        } catch {
                            messageCount = 0;
                        }
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
            } catch {
                sessions = await scanAllSessions();
            }

            // Populate the session cache
            setSessionCache(sessions);

            json(res, 200, { sessions });
            return true;
        }

        const sessionKey = sub[0];
        const action = sub[1];

        // GET /sessions/{key} — get single session with messages
        if (method === "GET" && sessionKey && !action) {
            let session: any = null;

            function findAgentJsonl(agentId: string): any | null {
                const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
                if (!existsSync(sessDir)) return null;
                const indexFile = join(sessDir, "sessions.json");
                const indexRaw = tryReadFile(indexFile);
                if (indexRaw !== null) {
                    try {
                        const idx = JSON.parse(indexRaw);
                        for (const [key, val] of Object.entries(idx)) {
                            const sid = (val as any).sessionId;
                            if (!sid) continue;
                            if (key === sessionKey || sid === sessionKey) {
                                const jsonlPath = join(sessDir, sid + ".jsonl");
                                if (existsSync(jsonlPath)) {
                                    const parsed = parseSessionJsonl(jsonlPath);
                                    return { sessionKey, agentId: parsed.agentId || agentId, channel: parsed.channel, messages: parsed.messages, updatedAt: parsed.updatedAt };
                                }
                            }
                        }
                    } catch { }
                }
                for (const f of readdirSync(sessDir)) {
                    if (f === "sessions.json") continue;
                    const base = f.replace(/\.jsonl?$/, "");
                    if (base === sessionKey && f.endsWith(".jsonl")) {
                        const parsed = parseSessionJsonl(join(sessDir, f));
                        return { sessionKey, agentId: parsed.agentId || agentId, channel: parsed.channel, messages: parsed.messages, updatedAt: parsed.updatedAt };
                    }
                }
                return null;
            }

            const dashSession = readDashboardSession(sessionKey);
            const agentIdFromKey = dashSession?.agentId || sessionKey.replace(/-\d+$/, "");

            if (agentIdFromKey && existsSync(join(AGENTS_STATE_DIR, agentIdFromKey))) {
                session = findAgentJsonl(agentIdFromKey);
            }

            if (!session) {
                try {
                    const r = await execAsync(`openclaw sessions get "${sessionKey}" --json`, { timeout: 8000 });
                    try { const p = JSON.parse((r || "{}").trim()); if (p && (p.messages || p.conversation || p.sessionKey)) session = p; } catch { }
                } catch { }
            }

            if (!session && existsSync(AGENTS_STATE_DIR)) {
                for (const agentId of readdirSync(AGENTS_STATE_DIR)) {
                    if (agentId === agentIdFromKey) continue;
                    session = findAgentJsonl(agentId);
                    if (session) break;
                }
            }

            if (!session && dashSession) {
                session = dashSession;
            }

            json(res, 200, { session: session || {} });
            return true;
        }

        // POST /sessions/{key}/message — send a message to an agent
        if (method === "POST" && action === "message") {
            const body = await parseBody(req);
            if (!body.message) { json(res, 400, { error: "message required" }); return true; }
            const agentId = body.agentId || "";
            const userMessage = body.message;

            let session = readDashboardSession(sessionKey);
            if (!session) {
                session = {
                    sessionKey,
                    agentId,
                    channel: "dashboard",
                    messages: [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
            }
            session.updatedAt = new Date().toISOString();
            writeDashboardSession(session);

            let responseText = "";
            let responded = false;

            try {
                responseText = await callGatewayChat(agentId, userMessage, sessionKey);
                responded = true;
            } catch (gwErr: any) {
                const gwMsg = gwErr?.message || "Gateway unavailable";
                const isAuthOrLimit = /usage limit|rate.limit|rate_limit|quota|invalid.*key|invalid.*api|unauthorized|401|403|429|too many requests|failover/i.test(gwMsg);
                if (isAuthOrLimit) {
                    writeDashboardSession(session);
                    json(res, 429, {
                        error: gwMsg,
                        errorType: "model_limit",
                        userMessageSaved: true,
                    });
                    return true;
                }
                try {
                    const escaped = userMessage.replace(/"/g, '\\"');
                    const agentFlag = agentId ? ` --agent "${agentId}"` : "";
                    const cmd = `openclaw agent --message "${escaped}" --session-id "${sessionKey}"${agentFlag}`;
                    const result = await new Promise<string>((resolve, reject) => {
                        exec(cmd, { encoding: "utf-8", timeout: 180000 }, (err, stdout, stderr) => {
                            if (err) reject(new Error(stdout || stderr || err.message));
                            else resolve(stdout || "");
                        });
                    });
                    responseText = result.trim();
                    responded = true;
                } catch (cliErr: any) {
                    writeDashboardSession(session);
                    const cliMsg = cliErr?.message || "CLI unavailable";
                    json(res, 503, {
                        error: `Could not reach agent. Gateway: ${gwMsg}. CLI: ${cliMsg}. Is the OpenClaw gateway running?`,
                        userMessageSaved: true,
                    });
                    return true;
                }
            }

            json(res, 200, { ok: true, result: responseText, response: responseText });
            return true;
        }

        // POST /sessions/spawn — create a new session
        if (method === "POST" && (sessionKey === "spawn" || action === "spawn")) {
            const body = await parseBody(req);
            const newKey = body.sessionKey ?? `dashboard-${Date.now()}`;
            const agentId = body.agentId || "";
            const session = {
                sessionKey: newKey,
                agentId,
                channel: "dashboard",
                messages: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            writeDashboardSession(session);
            json(res, 201, { sessionKey: newKey, ok: true });
            return true;
        }

        // DELETE /sessions/{key} — terminate a session and clean up all files
        if (method === "DELETE" && sessionKey) {
            let deleted = false;

            // Special: "all:{agentId}" deletes ALL sessions for an agent AND its subagent children
            if (sessionKey.startsWith("all:")) {
                const agentId = sessionKey.slice(4);
                const dashSessions = await listDashboardSessions();
                dashSessions.forEach(s => {
                    if (s.agentId === agentId) { deleteDashboardSession(s.sessionKey); deleted = true; }
                });
                const config = readConfig();
                const agentCfg = (config.agents?.list || []).find((a: any) => a.id === agentId);
                const childAgentIds: string[] = agentCfg?.subagents?.allowAgents || [];
                const allAgentIds = [agentId, ...childAgentIds];
                for (const aid of allAgentIds) {
                    const sessDir = join(AGENTS_STATE_DIR, aid, "sessions");
                    if (!existsSync(sessDir)) continue;
                    try {
                        for (const f of readdirSync(sessDir)) {
                            try { unlinkSync(join(sessDir, f)); deleted = true; } catch { }
                        }
                    } catch { }
                    dashSessions.forEach(s => {
                        if (s.agentId === aid) { deleteDashboardSession(s.sessionKey); }
                    });
                }
                json(res, 200, { ok: true, deleted, cleanedAll: true, cleanedAgents: allAgentIds });
                return true;
            }

            // 1. Delete from dashboard store
            deleted = deleteDashboardSession(sessionKey) || deleted;
            // 2. Delete from agent state dirs
            if (existsSync(AGENTS_STATE_DIR)) {
                for (const agentId of readdirSync(AGENTS_STATE_DIR)) {
                    const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
                    if (!existsSync(sessDir)) continue;
                    const indexFile = join(sessDir, "sessions.json");
                    const indexRaw = tryReadFile(indexFile);
                    if (indexRaw !== null) {
                        try {
                            const idx = JSON.parse(indexRaw);
                            for (const [key, val] of Object.entries(idx)) {
                                if (key.includes(sessionKey) || sessionKey.includes(key)) {
                                    const sid = (val as any).sessionId;
                                    if (sid) {
                                        for (const ext of [".jsonl", ".json"]) {
                                            const fp = join(sessDir, sid + ext);
                                            if (existsSync(fp)) { unlinkSync(fp); deleted = true; }
                                        }
                                        delete idx[key];
                                        writeFileSync(indexFile, JSON.stringify(idx, null, 2), "utf-8");
                                    }
                                }
                            }
                        } catch { }
                    }
                    for (const ext of [".jsonl", ".json"]) {
                        const fp = join(sessDir, sessionKey + ext);
                        if (existsSync(fp)) { unlinkSync(fp); deleted = true; }
                    }
                    try {
                        for (const f of readdirSync(sessDir)) {
                            if (f !== "sessions.json" && f.includes(sessionKey)) {
                                try { unlinkSync(join(sessDir, f)); deleted = true; } catch { }
                            }
                        }
                    } catch { }
                    if (deleted) break;
                }
            }
            json(res, 200, { ok: true, deleted });
            return true;
        }
    } catch (err: any) {
        json(res, 500, { error: err.message ?? "Session operation failed" });
        return true;
    }

    return false;
}
