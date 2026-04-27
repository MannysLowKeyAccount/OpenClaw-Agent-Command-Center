import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { stat as statAsync, readdir as readdirAsync, readFile as readFileAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { join } from "node:path";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    parseBody,
    readConfig,
    resolveHome,
    tryReadFile,
    execFileAsync,
    AGENTS_STATE_DIR,
    DASHBOARD_SESSIONS_DIR,
} from "../api-utils.js";

type ParsedSessionJsonl = {
    messages: any[];
    agentId: string;
    channel: string;
    updatedAt: string | null;
    messageCount: number;
    lastEventSeq: number;
};

type SessionJsonlMetadata = Omit<ParsedSessionJsonl, "messages">;

type SessionThreadKind = "primary" | "subagent";

type SessionThreadSummary = {
    threadId: string;
    sessionKey: string;
    agentId: string;
    kind: SessionThreadKind;
    rootSessionKey: string;
    parentSessionKey: string | null;
    attachedToSessionKey: string | null;
    attachedToAgentId: string | null;
    readOnly: boolean;
    status: "ready" | "missing";
    updatedAt: string | null;
    messageCount: number;
    lastEventSeq: number;
    channel: string;
    gatewayKey: string;
    attachedThreads?: SessionThreadSummary[];
};

type SessionPage = {
    messages: any[];
    cursor: {
        limit: number;
        startSeq: number | null;
        endSeq: number | null;
        prevCursor: number | null;
        nextCursor: number | null;
        hasMoreBefore: boolean;
        hasMoreAfter: boolean;
        mode: "initial" | "after" | "before";
    };
    messageCount: number;
    lastEventSeq: number;
};

type LoadedSessionRecord = {
    thread: SessionThreadSummary;
    session: any;
    messages: any[];
    cursor: SessionPage["cursor"];
    messageCount: number;
    lastEventSeq: number;
    pageLimit: number;
};

const DEFAULT_SESSION_PAGE_SIZE = 100;

const INTERNAL_SESSION_MARKERS = [
    "OPENCLAW_INTERNAL_CONTEXT",
    "<<<BEGIN_OPENCLAW",
    "<relevant-memories>",
    "Read HEARTBEAT.md",
    "HEARTBEAT_OK",
];

function _sessionMessageLineIsInternalLog(line: string): boolean {
    const text = line.trim();
    return /^\[plugins?\](?:\s|$)/i.test(text)
        || /^\[agent-dashboard\](?:\s|$)/i.test(text)
        || /^plugin registered(?:\s|$)/i.test(text)
        || /^loading\b.*\bplugin\b/i.test(text)
        || /^memory-lancedb:\s*plugin registered\b/i.test(text);
}

function _sessionMessageIsOnlyInternalLogs(text: string): boolean {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.length > 0 && lines.every(_sessionMessageLineIsInternalLog);
}

function _sessionMessageText(msg: any): string {
    const content = msg?.content ?? msg?.text ?? "";
    if (Array.isArray(content)) {
        return content
            .map((part: any) => {
                if (typeof part === "string") return part;
                if (typeof part?.thinking === "string") return part.thinking;
                if (typeof part?.text === "string") return part.text;
                return "";
            })
            .filter(Boolean)
            .join("\n");
    }
    return typeof content === "string" ? content : "";
}

function _sessionMessageIsInternal(msg: any): boolean {
    if (!msg || typeof msg !== "object") return false;
    if (msg.internal === true || msg.isInternal === true) return true;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role === "system" || role === "tool" || role === "toolResult") return true;
    const text = _sessionMessageText(msg);
    return INTERNAL_SESSION_MARKERS.some((marker) => text.includes(marker)) || _sessionMessageIsOnlyInternalLogs(text);
}

function _cloneSessionMessage(msg: any, seq: number): any {
    const copy = msg && typeof msg === "object" ? JSON.parse(JSON.stringify(msg)) : msg;
    if (copy && typeof copy === "object") {
        copy.seq = seq;
        copy.cursor = seq;
        const internal = _sessionMessageIsInternal(copy);
        copy.internal = internal;
        copy.isInternal = internal;
    }
    return copy;
}

function _scanSessionJsonlRaw(raw: string, collectMessages: boolean): ParsedSessionJsonl {
    const messages: any[] = [];
    let agentId = "";
    let channel = "";
    let updatedAt: string | null = null;
    let sessionHeaderFound = false;
    let seq = 0;
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === "session" && !sessionHeaderFound) {
                agentId = entry.agentId || "";
                channel = entry.channel || "";
                sessionHeaderFound = true;
            }
            if (entry.type === "message" && entry.message) {
                seq += 1;
                if (collectMessages) {
                    const message = _cloneSessionMessage(entry.message, seq);
                    if (entry.timestamp && message && typeof message === "object") message._timestamp = entry.timestamp;
                    messages.push(message);
                }
                if (entry.timestamp) updatedAt = entry.timestamp;
            }
        } catch { }
    }
    return {
        messages: collectMessages ? messages : [],
        agentId,
        channel,
        updatedAt,
        messageCount: seq,
        lastEventSeq: seq,
    };
}

function parseSessionJsonlRaw(raw: string): ParsedSessionJsonl {
    return _scanSessionJsonlRaw(raw, true);
}

function inspectSessionJsonlRaw(raw: string): SessionJsonlMetadata {
    const parsed = _scanSessionJsonlRaw(raw, false);
    return {
        agentId: parsed.agentId,
        channel: parsed.channel,
        updatedAt: parsed.updatedAt,
        messageCount: parsed.messageCount,
        lastEventSeq: parsed.lastEventSeq,
    };
}

// ─── JSONL session parser ───
export function parseSessionJsonl(filePath: string): ParsedSessionJsonl {
    return parseSessionJsonlRaw(readFileSync(filePath, "utf-8"));
}

// ─── Async JSONL session parser ───

export async function parseSessionJsonlAsync(filePath: string): Promise<ParsedSessionJsonl> {
    return parseSessionJsonlRaw(await readFileAsync(filePath, "utf-8"));
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

function appendDashboardSessionMessage(key: string, agentId: string, role: string, content: string, internal = false): void {
    const now = new Date().toISOString();
    const session = readDashboardSession(key) || {
        sessionKey: key,
        agentId,
        channel: "dashboard",
        kind: "primary",
        readOnly: false,
        messages: [],
        createdAt: now,
    };
    session.agentId = session.agentId || agentId;
    session.channel = session.channel || "dashboard";
    session.kind = session.kind || "primary";
    session.readOnly = false;
    session.messages = Array.isArray(session.messages) ? session.messages : [];
    session.messages.push({ role, content, internal, isInternal: internal, _timestamp: now });
    session.updatedAt = now;
    writeDashboardSession(session);
}

function deleteDashboardSession(key: string): boolean {
    const fp = sessionFilePath(key);
    if (!existsSync(fp)) return false;
    try { unlinkSync(fp); return true; } catch { return false; }
}

// ─── Gateway HTTP API caller ───
function getGatewayPort(config?: any): number {
    if (!config) config = readConfig();
    return config?.gateway?.port || 18789;
}

function _responseLooksFailed(text: string): boolean {
    return !String(text || "").trim()
        || /Agent couldn't generate a response/i.test(text)
        || /payloads=0/i.test(text);
}

function callGatewayChat(agentId: string, message: string, sessionKey: string, config?: any, modelOverride?: string, allowCliFallback = true): Promise<string> {
    if (!config) config = readConfig();
    const port = getGatewayPort(config);
    const authToken = config?.gateway?.auth?.token || "";

    // Try REST API first, fall back to CLI if gateway returns 404
    return new Promise((resolve, reject) => {
        const payload: Record<string, any> = {
            model: modelOverride || agentId || "default",
            agentId: agentId || undefined,
            messages: [{ role: "user", content: message }],
            stream: false,
        };
        if (sessionKey) payload.session_id = sessionKey;
        const postData = JSON.stringify(payload);
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
                // If gateway returns 404, fall back to CLI
                if (res.statusCode === 404) {
                    if (!allowCliFallback) { reject(new Error("Gateway chat API not available")); return; }
                    callGatewayChatCli(agentId, message, sessionKey).then(resolve).catch(reject);
                    return;
                }
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
        req.on("error", () => {
            // Network error — fall back to CLI
            if (!allowCliFallback) { reject(new Error("Gateway chat API unavailable")); return; }
            callGatewayChatCli(agentId, message, sessionKey).then(resolve).catch(reject);
        });
        req.on("timeout", () => { req.destroy(); reject(new Error("Gateway request timed out")); });
        req.write(postData);
        req.end();
    });
}

async function callGatewayDashboardChat(agentId: string, message: string, sessionKey: string, config?: any): Promise<string> {
    const runtimeAgentId = agentId === "main" ? "assistant" : agentId;
    const response = await callGatewayChat(runtimeAgentId, message, sessionKey, config);
    if (_responseLooksFailed(response)) throw new Error("Agent couldn't generate a response. Please try again.");
    return response;
}

// CLI fallback for sending messages when gateway REST API is unavailable
async function callGatewayChatCli(agentId: string, message: string, sessionKey: string): Promise<string> {
    const args = ["agent", "--message", message];
    if (agentId) args.push("--agent", agentId);
    if (sessionKey) args.push("--session-id", sessionKey);
    const result = await execFileAsync("openclaw", args, { timeout: 180000 });
    return result.trim() || "(empty response)";
}

// ─── In-memory session index ───
export type SessionIndexEntry = {
    sessionKey: string;
    agentId: string;
    filePath: string;
    channel: string;
    gatewayKey: string;
    messageCount: number;
    updatedAt: string | null;
    mtime: number;
    kind?: SessionThreadKind;
    rootSessionKey?: string | null;
    parentSessionKey?: string | null;
    attachedToSessionKey?: string | null;
    attachedToAgentId?: string | null;
};

export const sessionIndex: Map<string, SessionIndexEntry> = new Map();
const SESSION_INDEX_MAX = 5000; // hard cap to prevent unbounded growth

function _normalizeThreadStatus(entry: SessionIndexEntry): "ready" | "missing" {
    return entry.filePath ? "ready" : "missing";
}

function _findParentAgentId(agentId: string, config?: any): string | null {
    const agents = config?.agents?.list || [];
    for (const agent of agents) {
        const allowed = agent?.subagents?.allowAgents || [];
        if (Array.isArray(allowed) && allowed.includes(agentId)) return agent.id || null;
    }
    return null;
}

function _isSubagentGatewayKey(gatewayKey: string): boolean {
    return /:subagent:/.test(gatewayKey || "");
}

function _inferThreadKind(entry: SessionIndexEntry, config?: any): SessionThreadKind {
    if (entry.kind === "primary" || entry.kind === "subagent") return entry.kind;
    if (entry.channel === "dashboard") return "primary";
    if (entry.attachedToSessionKey || entry.parentSessionKey || entry.rootSessionKey || entry.attachedToAgentId) {
        return "subagent";
    }
    if (_isSubagentGatewayKey(entry.gatewayKey)) return "subagent";
    if (entry.gatewayKey && /:main$/.test(entry.gatewayKey)) return "primary";
    return _findParentAgentId(entry.agentId, config) ? "subagent" : "primary";
}

function _findParentSessionKey(agentId: string, config?: any): string | null {
    const parentAgentId = _findParentAgentId(agentId, config);
    if (!parentAgentId) return null;
    const candidates = [...sessionIndex.values()].filter((entry) => entry.agentId === parentAgentId && _inferThreadKind(entry, config) === "primary");
    candidates.sort((a, b) => {
        const aTime = new Date(a.updatedAt || 0).getTime();
        const bTime = new Date(b.updatedAt || 0).getTime();
        if (bTime !== aTime) return bTime - aTime;
        return b.messageCount - a.messageCount;
    });
    return candidates[0]?.sessionKey || null;
}

function buildSessionThreadSummary(entry: SessionIndexEntry, config?: any, parentSessionKey: string | null = null): SessionThreadSummary {
    const kind = _inferThreadKind(entry, config);
    const attachedToAgentId = entry.attachedToAgentId || (kind === "subagent" ? _findParentAgentId(entry.agentId, config) : null);
    const explicitAttachedSessionKey = entry.attachedToSessionKey || entry.parentSessionKey || entry.rootSessionKey || null;
    const attachedSessionKey = explicitAttachedSessionKey || (kind === "subagent" ? (parentSessionKey || _findParentSessionKey(entry.agentId, config)) : parentSessionKey);
    const summary: SessionThreadSummary = {
        threadId: entry.sessionKey,
        sessionKey: entry.sessionKey,
        agentId: entry.agentId,
        kind,
        rootSessionKey: attachedSessionKey || entry.sessionKey,
        parentSessionKey: attachedSessionKey,
        attachedToSessionKey: attachedSessionKey,
        attachedToAgentId,
        readOnly: kind === "subagent",
        status: _normalizeThreadStatus(entry),
        updatedAt: entry.updatedAt,
        messageCount: entry.messageCount,
        lastEventSeq: entry.messageCount,
        channel: entry.channel,
        gatewayKey: entry.gatewayKey,
    };
    return summary;
}

function _isSyntheticDashboardSessionKey(sessionKey: string): boolean {
    return /^dashboard:[^:]+:main$/.test(sessionKey || "");
}

function _isUsableGatewaySessionThread(summary: SessionThreadSummary | null | undefined): boolean {
    return Boolean(summary && summary.status === "ready" && !_isSyntheticDashboardSessionKey(summary.sessionKey));
}

function _primaryThreadSortScore(summary: SessionThreadSummary): number {
    let score = 0;
    if (summary.status === "ready") score += 100;
    if (!_isSyntheticDashboardSessionKey(summary.sessionKey)) score += 20;
    if (summary.gatewayKey && /:main$/.test(summary.gatewayKey)) score += 10;
    if (summary.channel === "dashboard") score -= 5;
    return score;
}

function _findBestPrimaryThread(agentId: string, config?: any): SessionThreadSummary | null {
    const candidates = [...sessionIndex.values()]
        .filter((entry) => entry.agentId === agentId)
        .map((entry) => buildSessionThreadSummary(entry, config))
        .filter((summary) => summary.kind === "primary" && summary.agentId === agentId);

    candidates.sort((a, b) => {
        const scoreDelta = _primaryThreadSortScore(b) - _primaryThreadSortScore(a);
        if (scoreDelta !== 0) return scoreDelta;
        const aTime = new Date(a.updatedAt || 0).getTime();
        const bTime = new Date(b.updatedAt || 0).getTime();
        if (bTime !== aTime) return bTime - aTime;
        return b.messageCount - a.messageCount;
    });

    return candidates[0] || null;
}

export function resolveGatewaySessionId(agentId: string, sessionKey: string, entry: SessionIndexEntry | null | undefined, config?: any): string {
    if (entry?.filePath && !_isSyntheticDashboardSessionKey(sessionKey)) return sessionKey;
    const bestPrimaryThread = agentId ? _findBestPrimaryThread(agentId, config) : null;
    const resolvedPrimaryThread = _isUsableGatewaySessionThread(bestPrimaryThread) ? bestPrimaryThread : null;
    if (resolvedPrimaryThread) return resolvedPrimaryThread.sessionKey;
    return entry?.filePath && !_isSyntheticDashboardSessionKey(sessionKey) ? sessionKey : "";
}

function _buildPageCursor(messages: any[], totalCount: number, mode: "initial" | "after" | "before", limit: number, cursorValue: number | null): SessionPage {
    const startSeq = messages.length > 0 ? (messages[0]?.seq ?? messages[0]?.cursor ?? null) : null;
    const endSeq = messages.length > 0 ? (messages[messages.length - 1]?.seq ?? messages[messages.length - 1]?.cursor ?? null) : null;
    const safeStart = typeof startSeq === "number" ? startSeq : null;
    const safeEnd = typeof endSeq === "number" ? endSeq : null;
    return {
        messages,
        cursor: {
            limit,
            startSeq: safeStart,
            endSeq: safeEnd,
            prevCursor: safeStart,
            nextCursor: safeEnd,
            hasMoreBefore: mode === "after" ? (cursorValue ?? 0) > 1 : (safeStart ?? 1) > 1,
            hasMoreAfter: typeof safeEnd === "number" ? safeEnd < totalCount : false,
            mode,
        },
        messageCount: totalCount,
        lastEventSeq: totalCount,
    };
}

function _sliceSessionMessages(parsed: ParsedSessionJsonl, query: URLSearchParams): SessionPage {
    const total = parsed.messageCount;
    const limitRaw = Number.parseInt(query.get("limit") || "", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : DEFAULT_SESSION_PAGE_SIZE;
    const cursorRaw = query.get("after") ?? query.get("cursor");
    const beforeRaw = query.get("before");
    const cursor = cursorRaw !== null && cursorRaw !== "" ? Number.parseInt(cursorRaw, 10) : null;
    const before = beforeRaw !== null && beforeRaw !== "" ? Number.parseInt(beforeRaw, 10) : null;

    if (before !== null && Number.isFinite(before)) {
        const page = parsed.messages.filter((msg: any) => (msg?.seq ?? msg?.cursor ?? 0) < before).slice(-limit);
        return _buildPageCursor(page, total, "before", limit, before);
    }

    if (cursor !== null && Number.isFinite(cursor)) {
        const page = parsed.messages.filter((msg: any) => (msg?.seq ?? msg?.cursor ?? 0) > cursor).slice(0, limit);
        return _buildPageCursor(page, total, "after", limit, cursor);
    }

    const page = parsed.messages.slice(-limit);
    return _buildPageCursor(page, total, "initial", limit, null);
}

async function _inspectSessionJsonl(filePath: string): Promise<ParsedSessionJsonl> {
    const parsed = inspectSessionJsonlRaw(await readFileAsync(filePath, "utf-8"));
    return { ...parsed, messages: [] };
}

function _parseDashboardSession(raw: any): ParsedSessionJsonl {
    const messages = Array.isArray(raw?.messages)
        ? raw.messages.map((msg: any, idx: number) => _cloneSessionMessage(msg, idx + 1))
        : [];
    return {
        messages,
        agentId: raw?.agentId || "",
        channel: raw?.channel || raw?.channelType || "dashboard",
        updatedAt: raw?.updatedAt || raw?.createdAt || null,
        messageCount: messages.length,
        lastEventSeq: messages.length,
    };
}

function _buildSessionRecord(thread: SessionThreadSummary, parsed: ParsedSessionJsonl, page: SessionPage): LoadedSessionRecord {
    const session = {
        ...thread,
        agentId: parsed.agentId || thread.agentId,
        channel: parsed.channel || thread.channel,
        messages: page.messages,
        cursor: page.cursor,
        messageCount: page.messageCount,
        lastEventSeq: page.lastEventSeq,
        pageLimit: page.cursor.limit,
    };

    return {
        thread,
        session,
        messages: page.messages,
        cursor: page.cursor,
        messageCount: page.messageCount,
        lastEventSeq: page.lastEventSeq,
        pageLimit: page.cursor.limit,
    };
}

async function _loadSessionRecord(entry: SessionIndexEntry, query: URLSearchParams, config?: any): Promise<LoadedSessionRecord | null> {
    if (!entry.filePath) return null;
    const thread = buildSessionThreadSummary(entry, config);

    if (entry.filePath.endsWith(".jsonl")) {
        const parsed = await parseSessionJsonlAsync(entry.filePath);
        const page = _sliceSessionMessages(parsed, query);
        return _buildSessionRecord(thread, parsed, page);
    }

    if (entry.filePath.endsWith(".json")) {
        try {
            const raw = JSON.parse(await readFileAsync(entry.filePath, "utf-8"));
            const parsed = _parseDashboardSession(raw);
            const page = _sliceSessionMessages(parsed, query);
            return _buildSessionRecord(thread, parsed, page);
        } catch {
            return null;
        }
    }

    return null;
}

// ─── Startup index population ───
export async function initSessionIndex(): Promise<void> {
    sessionIndex.clear();

    // 1. Scan all agent session directories
    let agentDirs: string[] = [];
    try {
        agentDirs = await readdirAsync(AGENTS_STATE_DIR);
    } catch {
        // AGENTS_STATE_DIR may not exist yet
    }

    for (const agentId of agentDirs) {
        const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
        try {
            await statAsync(sessDir);
        } catch {
            continue; // no sessions subdirectory for this agent
        }

        const localSeen = new Set<string>();

        // Read sessions.json index if present
        const indexFile = join(sessDir, "sessions.json");
        try {
            const raw = await readFileAsync(indexFile, "utf-8");
            const sessionsJson = JSON.parse(raw);
            for (const [key, val] of Object.entries(sessionsJson)) {
                const meta = val as any;
                const sid = meta.sessionId || key;
                localSeen.add(sid);
                localSeen.add(key);

                let updatedAt: string | null = meta.updatedAt || meta.lastUpdated || null;
                let messageCount = 1;
                let filePath = "";
                let mtime = 0;
                let parsedJsonl: ParsedSessionJsonl | null = null;

                for (const ext of [".jsonl", ".json"]) {
                    const fp = join(sessDir, sid + ext);
                    try {
                        const st = await statAsync(fp);
                        filePath = fp;
                        mtime = st.mtimeMs;
                        updatedAt = updatedAt || st.mtime.toISOString();
                        if (ext === ".jsonl") {
                            parsedJsonl = await _inspectSessionJsonl(fp);
                            messageCount = parsedJsonl.messageCount;
                            updatedAt = updatedAt || parsedJsonl.updatedAt || st.mtime.toISOString();
                        }
                        break;
                    } catch {
                        // file doesn't exist for this extension — try with topic suffix
                    }
                }

                // If exact match failed, scan for files starting with the session ID
                // (handles compound filenames like {sessionId}-topic-{topicId}.jsonl)
                if (!filePath) {
                    try {
                        const dirFiles = await readdirAsync(sessDir);
                        for (const df of dirFiles) {
                            if (df.startsWith(sid + "-") && (df.endsWith(".jsonl") || df.endsWith(".json")) && !df.includes(".deleted.")) {
                                const fp = join(sessDir, df);
                                const st = await statAsync(fp);
                                filePath = fp;
                                mtime = st.mtimeMs;
                                updatedAt = updatedAt || st.mtime.toISOString();
                                if (df.endsWith(".jsonl")) {
                                    parsedJsonl = await _inspectSessionJsonl(fp);
                                    messageCount = parsedJsonl.messageCount;
                                    updatedAt = updatedAt || parsedJsonl.updatedAt || st.mtime.toISOString();
                                }
                                break;
                            }
                        }
                    } catch { }
                }

                sessionIndex.set(sid, {
                    sessionKey: sid,
                    agentId: meta.agentId || agentId,
                    filePath,
                    channel: meta.channel || meta.channelType || "",
                    gatewayKey: key,
                    messageCount,
                    updatedAt,
                    mtime,
                });
            }
        } catch {
            // sessions.json doesn't exist or is malformed
        }

        // Scan loose .jsonl/.json files not covered by sessions.json
        let files: string[] = [];
        try {
            files = await readdirAsync(sessDir);
        } catch {
            continue;
        }

        for (const f of files) {
            if (f === "sessions.json") continue;
            const isJsonl = f.endsWith(".jsonl");
            const isJson = f.endsWith(".json");
            if (!isJsonl && !isJson) continue;

            const sk = f.replace(/\.(jsonl|json)$/, "");
            if (localSeen.has(sk)) continue;
            localSeen.add(sk);

            const fp = join(sessDir, f);
            try {
                const st = await statAsync(fp);
                let fileAgentId = agentId;
                let channel = "";
                let parsedJsonl: ParsedSessionJsonl | null = null;

                if (isJsonl) {
                    try {
                        parsedJsonl = await _inspectSessionJsonl(fp);
                        if (parsedJsonl.agentId) fileAgentId = parsedJsonl.agentId;
                        if (parsedJsonl.channel) channel = parsedJsonl.channel;
                    } catch {
                        // malformed file header
                    }
                } else {
                    try {
                        const raw = JSON.parse(await readFileAsync(fp, "utf-8"));
                        if (raw.agentId) fileAgentId = raw.agentId;
                        if (raw.channel || raw.channelType) channel = raw.channel || raw.channelType;
                    } catch {
                        // malformed JSON file
                    }
                }

                sessionIndex.set(sk, {
                    sessionKey: sk,
                    agentId: fileAgentId,
                    filePath: fp,
                    channel,
                    gatewayKey: "",
                    messageCount: isJsonl ? (parsedJsonl?.messageCount ?? 0) : 1,
                    updatedAt: st.mtime.toISOString(),
                    mtime: st.mtimeMs,
                });
            } catch {
                // stat failed — skip this file
            }
        }
    }

    // 2. Scan dashboard sessions directory
    try {
        const dashFiles = await readdirAsync(DASHBOARD_SESSIONS_DIR);
        for (const f of dashFiles) {
            if (!f.endsWith(".json")) continue;
            const sk = f.replace(/\.json$/, "");
            if (sessionIndex.has(sk)) continue; // agent session takes precedence

            const fp = join(DASHBOARD_SESSIONS_DIR, f);
            try {
                const st = await statAsync(fp);
                const raw = JSON.parse(await readFileAsync(fp, "utf-8"));
                sessionIndex.set(sk, {
                    sessionKey: raw.sessionKey || sk,
                    agentId: raw.agentId || "",
                    filePath: fp,
                    channel: raw.channel || "dashboard",
                    gatewayKey: "",
                    messageCount: Array.isArray(raw.messages) ? raw.messages.length : 0,
                    updatedAt: raw.updatedAt || raw.createdAt || null,
                    mtime: st.mtimeMs,
                });
            } catch {
                // malformed dashboard session file
            }
        }
    } catch {
        // DASHBOARD_SESSIONS_DIR may not exist yet
    }

    // Enforce hard cap — if index grew too large, evict oldest entries
    _enforceSessionIndexCap();
}

// ─── Incremental mtime-based index refresh ───
export async function refreshSessionIndex(): Promise<void> {
    // 1. Check existing entries: stat each file, update if mtime changed, remove if gone
    const existingKeys = [...sessionIndex.keys()];
    for (const key of existingKeys) {
        const entry = sessionIndex.get(key)!;
        if (!entry.filePath) {
            // No file path recorded — remove stale entry
            sessionIndex.delete(key);
            continue;
        }
        try {
            const st = await statAsync(entry.filePath);
            if (st.mtimeMs === entry.mtime) continue; // unchanged — skip

            // mtime changed — re-read header to update metadata
            const isJsonl = entry.filePath.endsWith(".jsonl");
            let agentId = entry.agentId;
            let channel = entry.channel;
            let messageCount = entry.messageCount;
            let updatedAt: string | null = st.mtime.toISOString();
            let parsedJsonl: ParsedSessionJsonl | null = null;

            if (isJsonl) {
                try {
                    parsedJsonl = await _inspectSessionJsonl(entry.filePath);
                    if (parsedJsonl.agentId) agentId = parsedJsonl.agentId;
                    if (parsedJsonl.channel) channel = parsedJsonl.channel;
                    messageCount = parsedJsonl.messageCount;
                    updatedAt = parsedJsonl.updatedAt || updatedAt;
                } catch { }
            } else if (entry.filePath.endsWith(".json")) {
                try {
                    const raw = JSON.parse(await readFileAsync(entry.filePath, "utf-8"));
                    if (raw.agentId) agentId = raw.agentId;
                    if (raw.channel || raw.channelType) channel = raw.channel || raw.channelType;
                    if (Array.isArray(raw.messages)) messageCount = raw.messages.length;
                    if (raw.updatedAt || raw.createdAt) updatedAt = raw.updatedAt || raw.createdAt;
                } catch { }
            }

            sessionIndex.set(key, {
                sessionKey: key,
                agentId,
                filePath: entry.filePath,
                channel,
                gatewayKey: entry.gatewayKey,
                messageCount,
                updatedAt,
                mtime: st.mtimeMs,
            });
        } catch {
            // File no longer exists — remove from index
            sessionIndex.delete(key);
        }
    }

    // 2. Discover new files in agent session directories
    let agentDirs: string[] = [];
    try {
        agentDirs = await readdirAsync(AGENTS_STATE_DIR);
    } catch { }

    for (const agentId of agentDirs) {
        const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
        try {
            await statAsync(sessDir);
        } catch {
            continue;
        }

        const localSeen = new Set<string>();

        // Check sessions.json index for new entries
        const indexFile = join(sessDir, "sessions.json");
        try {
            const raw = await readFileAsync(indexFile, "utf-8");
            const sessionsJson = JSON.parse(raw);
            for (const [key, val] of Object.entries(sessionsJson)) {
                const meta = val as any;
                const sid = meta.sessionId || key;
                localSeen.add(sid);
                localSeen.add(key);

                if (sessionIndex.has(sid)) continue; // already tracked

                let updatedAt: string | null = meta.updatedAt || meta.lastUpdated || null;
                let messageCount = 1;
                let filePath = "";
                let mtime = 0;

                for (const ext of [".jsonl", ".json"]) {
                    const fp = join(sessDir, sid + ext);
                    try {
                        const st = await statAsync(fp);
                        filePath = fp;
                        mtime = st.mtimeMs;
                        updatedAt = updatedAt || st.mtime.toISOString();
                        if (ext === ".jsonl") {
                            const parsed = await _inspectSessionJsonl(fp);
                            messageCount = parsed.messageCount;
                            updatedAt = updatedAt || parsed.updatedAt || st.mtime.toISOString();
                        }
                        break;
                    } catch { }
                }

                // Compound filename fallback (e.g. {sessionId}-topic-{topicId}.jsonl)
                if (!filePath) {
                    try {
                        const dirFiles = await readdirAsync(sessDir);
                        for (const df of dirFiles) {
                            if (df.startsWith(sid + "-") && (df.endsWith(".jsonl") || df.endsWith(".json")) && !df.includes(".deleted.")) {
                                const fp = join(sessDir, df);
                                const st = await statAsync(fp);
                                filePath = fp;
                                mtime = st.mtimeMs;
                                updatedAt = updatedAt || st.mtime.toISOString();
                                if (df.endsWith(".jsonl")) {
                                    const parsed = await _inspectSessionJsonl(fp);
                                    messageCount = parsed.messageCount;
                                    updatedAt = updatedAt || parsed.updatedAt || st.mtime.toISOString();
                                }
                                break;
                            }
                        }
                    } catch { }
                }

                sessionIndex.set(sid, {
                    sessionKey: sid,
                    agentId: meta.agentId || agentId,
                    filePath,
                    channel: meta.channel || meta.channelType || "",
                    gatewayKey: key,
                    messageCount,
                    updatedAt,
                    mtime,
                });
            }
        } catch { }

        // Scan loose files for new ones not yet in the index
        let files: string[] = [];
        try {
            files = await readdirAsync(sessDir);
        } catch {
            continue;
        }

        for (const f of files) {
            if (f === "sessions.json") continue;
            const isJsonl = f.endsWith(".jsonl");
            const isJson = f.endsWith(".json");
            if (!isJsonl && !isJson) continue;

            const sk = f.replace(/\.(jsonl|json)$/, "");
            if (localSeen.has(sk)) continue;
            localSeen.add(sk);

            if (sessionIndex.has(sk)) continue; // already tracked

            const fp = join(sessDir, f);
            try {
                const st = await statAsync(fp);
                let fileAgentId = agentId;
                let channel = "";
                let parsedJsonl: ParsedSessionJsonl | null = null;

                if (isJsonl) {
                    try {
                        parsedJsonl = await _inspectSessionJsonl(fp);
                        if (parsedJsonl.agentId) fileAgentId = parsedJsonl.agentId;
                        if (parsedJsonl.channel) channel = parsedJsonl.channel;
                    } catch { }
                } else {
                    try {
                        const raw = JSON.parse(await readFileAsync(fp, "utf-8"));
                        if (raw.agentId) fileAgentId = raw.agentId;
                        if (raw.channel || raw.channelType) channel = raw.channel || raw.channelType;
                    } catch { }
                }

                sessionIndex.set(sk, {
                    sessionKey: sk,
                    agentId: fileAgentId,
                    filePath: fp,
                    channel,
                    gatewayKey: "",
                    messageCount: isJsonl ? (parsedJsonl?.messageCount ?? 0) : 1,
                    updatedAt: st.mtime.toISOString(),
                    mtime: st.mtimeMs,
                });
            } catch { }
        }
    }

    // 3. Discover new files in dashboard sessions directory
    try {
        const dashFiles = await readdirAsync(DASHBOARD_SESSIONS_DIR);
        for (const f of dashFiles) {
            if (!f.endsWith(".json")) continue;
            const sk = f.replace(/\.json$/, "");
            if (sessionIndex.has(sk)) continue; // already tracked (agent entry takes precedence)

            const fp = join(DASHBOARD_SESSIONS_DIR, f);
            try {
                const st = await statAsync(fp);
                const raw = JSON.parse(await readFileAsync(fp, "utf-8"));
                sessionIndex.set(sk, {
                    sessionKey: raw.sessionKey || sk,
                    agentId: raw.agentId || "",
                    filePath: fp,
                    channel: raw.channel || "dashboard",
                    gatewayKey: "",
                    messageCount: Array.isArray(raw.messages) ? raw.messages.length : 0,
                    updatedAt: raw.updatedAt || raw.createdAt || null,
                    mtime: st.mtimeMs,
                });
            } catch { }
        }
    } catch { }

    // Enforce hard cap — if index grew too large, evict oldest entries
    _enforceSessionIndexCap();
}

// ─── Enforce session index size cap ───
function _enforceSessionIndexCap(): void {
    if (sessionIndex.size <= SESSION_INDEX_MAX) return;
    // Sort by updatedAt ascending (oldest first), evict oldest
    const entries = [...sessionIndex.entries()].sort((a, b) => {
        const aTime = a[1].updatedAt || "";
        const bTime = b[1].updatedAt || "";
        return aTime.localeCompare(bTime);
    });
    const excess = sessionIndex.size - SESSION_INDEX_MAX;
    for (let i = 0; i < excess; i++) {
        sessionIndex.delete(entries[i][0]);
    }
}

// ─── Targeted async scan of a single agent's sessions dir, updating the index ───
export async function scanAndIndexAgentSessions(agentId: string): Promise<void> {
    const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
    try { await statAsync(sessDir); } catch { return; }

    const localSeen = new Set<string>();

    // Read sessions.json index if present
    const indexFile = join(sessDir, "sessions.json");
    try {
        const raw = await readFileAsync(indexFile, "utf-8");
        const sessionsJson = JSON.parse(raw);
        for (const [key, val] of Object.entries(sessionsJson)) {
            const meta = val as any;
            const sid = meta.sessionId || key;
            localSeen.add(sid);
            localSeen.add(key);

            if (sessionIndex.has(sid)) continue; // already tracked

            let updatedAt: string | null = meta.updatedAt || meta.lastUpdated || null;
            let messageCount = 1;
            let filePath = "";
            let mtime = 0;
            let parsedJsonl: ParsedSessionJsonl | null = null;

            for (const ext of [".jsonl", ".json"]) {
                const fp = join(sessDir, sid + ext);
                try {
                    const st = await statAsync(fp);
                    filePath = fp;
                    mtime = st.mtimeMs;
                    updatedAt = updatedAt || st.mtime.toISOString();
                    if (ext === ".jsonl") {
                        parsedJsonl = await _inspectSessionJsonl(fp);
                        messageCount = parsedJsonl.messageCount;
                        updatedAt = updatedAt || parsedJsonl.updatedAt || st.mtime.toISOString();
                    }
                    break;
                } catch { }
            }

            // Compound filename fallback (e.g. {sessionId}-topic-{topicId}.jsonl)
            if (!filePath) {
                try {
                    const dirFiles = await readdirAsync(sessDir);
                    for (const df of dirFiles) {
                        if (df.startsWith(sid + "-") && (df.endsWith(".jsonl") || df.endsWith(".json")) && !df.includes(".deleted.")) {
                            const fp = join(sessDir, df);
                            const st = await statAsync(fp);
                            filePath = fp;
                            mtime = st.mtimeMs;
                            updatedAt = updatedAt || st.mtime.toISOString();
                            if (df.endsWith(".jsonl")) {
                                parsedJsonl = await _inspectSessionJsonl(fp);
                                messageCount = parsedJsonl.messageCount;
                                updatedAt = updatedAt || parsedJsonl.updatedAt || st.mtime.toISOString();
                            }
                            break;
                        }
                    }
                } catch { }
            }

            sessionIndex.set(sid, {
                sessionKey: sid,
                agentId: meta.agentId || agentId,
                filePath,
                channel: meta.channel || meta.channelType || "",
                gatewayKey: key,
                messageCount,
                updatedAt,
                mtime,
            });
        }
    } catch { }

    // Scan loose files
    let files: string[] = [];
    try { files = await readdirAsync(sessDir); } catch { return; }

    for (const f of files) {
        if (f === "sessions.json") continue;
        const isJsonl = f.endsWith(".jsonl");
        const isJson = f.endsWith(".json");
        if (!isJsonl && !isJson) continue;

        const sk = f.replace(/\.(jsonl|json)$/, "");
        if (localSeen.has(sk)) continue;
        localSeen.add(sk);

        if (sessionIndex.has(sk)) continue; // already tracked

        const fp = join(sessDir, f);
        try {
            const st = await statAsync(fp);
            let fileAgentId = agentId;
            let channel = "";
            let parsedJsonl: ParsedSessionJsonl | null = null;

            if (isJsonl) {
                try {
                    parsedJsonl = await _inspectSessionJsonl(fp);
                    if (parsedJsonl.agentId) fileAgentId = parsedJsonl.agentId;
                    if (parsedJsonl.channel) channel = parsedJsonl.channel;
                } catch { }
            } else {
                try {
                    const raw = JSON.parse(await readFileAsync(fp, "utf-8"));
                    if (raw.agentId) fileAgentId = raw.agentId;
                    if (raw.channel || raw.channelType) channel = raw.channel || raw.channelType;
                } catch { }
            }

            sessionIndex.set(sk, {
                sessionKey: sk,
                agentId: fileAgentId,
                filePath: fp,
                channel,
                gatewayKey: "",
                messageCount: isJsonl ? (parsedJsonl?.messageCount ?? 0) : 1,
                updatedAt: st.mtime.toISOString(),
                mtime: st.mtimeMs,
            });
        } catch { }
    }
}

// ─── Async dashboard session reader ───
async function readDashboardSessionAsync(key: string): Promise<any | null> {
    const fp = sessionFilePath(key);
    try {
        const raw = await readFileAsync(fp, "utf-8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
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
        // GET /sessions/agent/{agentId} — list sessions for a single agent (served from index)
        if (method === "GET" && sub.length === 2 && sub[0] === "agent") {
            const agentId = decodeURIComponent(sub[1]);
            const scan = url.searchParams.get("scan") === "1";

            // If scan=1, do an incremental mtime-based refresh before returning
            if (scan) {
                await refreshSessionIndex();
            }

            // Collect agent IDs to include: the requested agent + its subagents from config
            const config = readConfig();
            const agentCfg = (config.agents?.list || []).find((a: any) => a.id === agentId);
            const childIds: string[] = agentCfg?.subagents?.allowAgents || [];
            const allAgentIds = new Set([agentId, ...childIds]);

            // Query sessionIndex for the requested agent plus attached subagent threads.
            // Do not include primary sessions for child agents; each agent's main chat must stay isolated.
            const sessions: SessionThreadSummary[] = [];
            const seen = new Set<string>();
            const ownPrimaryKeys = new Set<string>();
            for (const entry of sessionIndex.values()) {
                if (entry.agentId !== agentId) continue;
                const summary = buildSessionThreadSummary(entry, config);
                if (summary.kind === "primary") ownPrimaryKeys.add(summary.sessionKey);
            }
            for (const entry of sessionIndex.values()) {
                if (seen.has(entry.sessionKey)) continue;
                const summary = buildSessionThreadSummary(entry, config);
                const isOwnThread = summary.agentId === agentId;
                const explicitAttachedSessionKey = summary.attachedToSessionKey || entry.attachedToSessionKey || entry.parentSessionKey || entry.rootSessionKey || null;
                const isAttachedChildThread = summary.kind === "subagent"
                    && childIds.includes(summary.agentId)
                    && summary.attachedToAgentId === agentId
                    && !!explicitAttachedSessionKey
                    && ownPrimaryKeys.has(explicitAttachedSessionKey);
                if (!isOwnThread && !isAttachedChildThread) continue;
                seen.add(entry.sessionKey);
                sessions.push(summary);
            }

            sessions.sort((a, b) => {
                const aDash = a.channel === "dashboard" ? 1 : 0;
                const bDash = b.channel === "dashboard" ? 1 : 0;
                if (bDash !== aDash) return bDash - aDash;
                const aTime = new Date(a.updatedAt || 0).getTime();
                const bTime = new Date(b.updatedAt || 0).getTime();
                if (bTime !== aTime) return bTime - aTime;
                return b.messageCount - a.messageCount;
            });

            const primaryThread = _findBestPrimaryThread(agentId, config);
            const attachedThreads = primaryThread
                ? sessions.filter((s) => s.kind === "subagent" && (s.attachedToSessionKey === primaryThread.sessionKey || s.rootSessionKey === primaryThread.sessionKey))
                : sessions.filter((s) => s.kind === "subagent");
            const primaryWithAttached = primaryThread ? { ...primaryThread, attachedThreads } : null;

            json(res, 200, { threads: sessions, sessions, agentId, primaryThread: primaryWithAttached, attachedThreads, threadCount: sessions.length });
            return true;
        }

        // GET /sessions — list all sessions (served from index)
        if (method === "GET" && sub.length === 0) {
            const fast = url.searchParams.get("fast") === "1";

            // Without fast=1, do an incremental mtime-based refresh first
            if (!fast) {
                await refreshSessionIndex();
            }

            // Serve all sessions from the in-memory index
            const sessions: any[] = [];
            const config = readConfig();
            for (const entry of sessionIndex.values()) {
                sessions.push(buildSessionThreadSummary(entry, config));
            }

            json(res, 200, { sessions });
            return true;
        }

        const sessionKey = sub[0];
        const action = sub[1];

        // GET /sessions/{key} and GET /sessions/{key}/messages — load a paginated session page
        if (method === "GET" && sessionKey && (!action || action === "messages" || action === "history")) {
            const config = readConfig();
            let record: LoadedSessionRecord | null = null;
            let entry = sessionIndex.get(sessionKey) || null;

            if (entry) {
                record = await _loadSessionRecord(entry, url.searchParams, config);
            }

            // If index miss, try a targeted async scan of the likely agent directory
            if (!record) {
                const agentIdFromKey = sessionKey.replace(/-\d+$/, "");
                if (agentIdFromKey) {
                    await scanAndIndexAgentSessions(agentIdFromKey);
                    entry = sessionIndex.get(sessionKey) || null;
                    if (entry) record = await _loadSessionRecord(entry, url.searchParams, config);
                }
            }

            // Final fallback: check dashboard session store (async)
            if (!record) {
                const dashSession = await readDashboardSessionAsync(sessionKey);
                if (dashSession) {
                    const parsed = _parseDashboardSession(dashSession);
                    const page = _sliceSessionMessages(parsed, url.searchParams);
                    const entryLike: SessionIndexEntry = {
                        sessionKey,
                        agentId: parsed.agentId,
                        filePath: sessionFilePath(sessionKey),
                        channel: parsed.channel,
                        gatewayKey: "",
                        messageCount: parsed.messageCount,
                        updatedAt: parsed.updatedAt,
                        mtime: Date.now(),
                    };
                    record = _buildSessionRecord(buildSessionThreadSummary(entryLike, config), parsed, page);
                }
            }

            json(res, 200, {
                ...(record || { thread: null, session: {}, messages: [], cursor: null, messageCount: 0, lastEventSeq: 0, pageLimit: DEFAULT_SESSION_PAGE_SIZE }),
                session: record?.session || {},
                thread: record?.thread || null,
            });
            return true;
        }

        // POST /sessions/{key}/clear — truncate session JSONL, keeping only the header
        if (method === "POST" && action === "clear") {
            const entry = sessionIndex.get(sessionKey);
            if (!entry || !entry.filePath || !entry.filePath.endsWith(".jsonl")) {
                json(res, 404, { error: "Session not found or not a JSONL session" });
                return true;
            }
            if (buildSessionThreadSummary(entry, readConfig()).readOnly) {
                json(res, 403, { error: "Attached subagent threads are read-only", readOnly: true });
                return true;
            }
            try {
                // Read the first line (session header) and rewrite the file with just that
                const content = await readFileAsync(entry.filePath, "utf-8");
                const firstLine = content.split("\n")[0] || "";
                await writeFileAsync(entry.filePath, firstLine + "\n", "utf-8");
                // Update the index entry
                const st = await statAsync(entry.filePath);
                sessionIndex.set(sessionKey, {
                    ...entry,
                    messageCount: 0,
                    mtime: st.mtimeMs,
                    updatedAt: new Date().toISOString(),
                });
                json(res, 200, { ok: true, cleared: true });
            } catch (e: any) {
                json(res, 500, { error: e.message || "Failed to clear session" });
            }
            return true;
        }

        // POST /sessions/{key}/message — send a message to an agent
        if (method === "POST" && action === "message") {
            const entry = sessionIndex.get(sessionKey);
            const config = readConfig();
            if (entry && buildSessionThreadSummary(entry, config).readOnly) {
                json(res, 403, { error: "Attached subagent threads are read-only", readOnly: true });
                return true;
            }

            const body = await parseBody(req);
            if (!body.message) { json(res, 400, { error: "message required" }); return true; }
            const agentId = entry?.agentId || body.agentId || "";
            const userMessage = body.message;
            const targetSessionKey = sessionKey.endsWith("-init")
                ? `dashboard-${agentId || "agent"}-main`
                : (entry?.filePath?.endsWith(".json") ? sessionKey : `dashboard-${agentId || "agent"}-main`);
            const gatewaySessionId = resolveGatewaySessionId(agentId, sessionKey, entry, config);

            let responseText = "";

            // Default primarySessionKey to the key the frontend sent
            let primarySessionKey = targetSessionKey;

            // Send via gateway HTTP API (no CLI subprocess, no out-of-band session creation)
            try {
                responseText = await callGatewayDashboardChat(agentId, userMessage, gatewaySessionId, config);
                appendDashboardSessionMessage(targetSessionKey, agentId, "user", userMessage);
                appendDashboardSessionMessage(targetSessionKey, agentId, "assistant", responseText);
            } catch (gwErr: any) {
                const gwMsg = gwErr?.message || "Message send failed";
                const isAuthOrLimit = /usage limit|rate.limit|rate_limit|quota|invalid.*key|invalid.*api|unauthorized|401|403|429|too many requests|failover/i.test(gwMsg);
                if (isAuthOrLimit) {
                    json(res, 429, {
                        error: gwMsg,
                        errorType: "model_limit",
                        userMessageSaved: false,
                    });
                    return true;
                }
                json(res, 503, {
                    error: gwMsg,
                    ok: false,
                    userMessageSaved: false,
                });
                return true;
            }

            // After gateway responds, refresh the index to pick up any new session files
            await refreshSessionIndex();

            json(res, 200, {
                ok: true,
                result: responseText,
                response: responseText,
                primarySessionKey,
            });
            return true;
        }

        // POST /sessions/spawn — create a new session
        if (method === "POST" && (sessionKey === "spawn" || action === "spawn")) {
            const body = await parseBody(req);
            const newKey = body.sessionKey ?? `dashboard-${Date.now()}`;
            const agentId = body.agentId || "";
            const now = new Date().toISOString();
            const session = {
                sessionKey: newKey,
                agentId,
                channel: "dashboard",
                messages: [],
                createdAt: now,
                updatedAt: now,
            };
            writeDashboardSession(session);
            const fp = sessionFilePath(newKey);
            let mtime = 0;
            try { mtime = statSync(fp).mtimeMs; } catch { }
            sessionIndex.set(newKey, {
                sessionKey: newKey,
                agentId,
                filePath: fp,
                channel: "dashboard",
                gatewayKey: "",
                messageCount: 0,
                updatedAt: now,
                mtime,
            });
            json(res, 201, { sessionKey: newKey, ok: true });
            return true;
        }

        // DELETE /sessions/all:{agentId} — delete ALL sessions for an agent and subagents
        if (method === "DELETE" && sessionKey && sessionKey.startsWith("all:")) {
            let deleted = false;
            const agentId = sessionKey.slice(4);
            const config = readConfig();
            const agentCfg = (config.agents?.list || []).find((a: any) => a.id === agentId);
            const childAgentIds: string[] = agentCfg?.subagents?.allowAgents || [];
            const allAgentIds = [agentId, ...childAgentIds];
            const allAgentIdSet = new Set(allAgentIds);

            // Collect matching entries from sessionIndex by agent ID
            const toDelete: SessionIndexEntry[] = [];
            for (const entry of sessionIndex.values()) {
                if (allAgentIdSet.has(entry.agentId)) {
                    toDelete.push(entry);
                }
            }

            // Track which agent session dirs need sessions.json cleanup
            const agentDirsToClean = new Set<string>();

            // Delete all matching session files from disk and dashboard store
            const deletePromises: Promise<void>[] = [];
            for (const entry of toDelete) {
                // Delete the session file itself (JSONL or JSON on disk)
                if (entry.filePath) {
                    deletePromises.push(
                        unlinkAsync(entry.filePath).then(() => { deleted = true; }).catch(() => { })
                    );
                    // Track agent dir for sessions.json cleanup
                    for (const aid of allAgentIds) {
                        const sessDir = join(AGENTS_STATE_DIR, aid, "sessions");
                        if (entry.filePath.startsWith(sessDir)) {
                            agentDirsToClean.add(sessDir);
                        }
                    }
                }
                // Delete dashboard store JSON file
                const dashFp = sessionFilePath(entry.sessionKey);
                deletePromises.push(
                    unlinkAsync(dashFp).then(() => { deleted = true; }).catch(() => { })
                );
            }

            await Promise.all(deletePromises);

            // Clean up sessions.json gateway index for each affected agent dir
            for (const sessDir of agentDirsToClean) {
                const indexFile = join(sessDir, "sessions.json");
                try {
                    const indexRaw = await readFileAsync(indexFile, "utf-8");
                    const idx = JSON.parse(indexRaw);
                    let modified = false;
                    const deletedSessionKeys = new Set(toDelete.map(e => e.sessionKey));
                    for (const [key, val] of Object.entries(idx)) {
                        const meta = val as any;
                        const sid = meta.sessionId || key;
                        if (deletedSessionKeys.has(sid) || deletedSessionKeys.has(key) ||
                            allAgentIdSet.has(meta.agentId)) {
                            delete idx[key];
                            modified = true;
                        }
                    }
                    if (modified) {
                        await writeFileAsync(indexFile, JSON.stringify(idx, null, 2), "utf-8");
                    }
                } catch { }
            }

            // Remove all matching entries from sessionIndex
            for (const entry of toDelete) {
                sessionIndex.delete(entry.sessionKey);
            }

            json(res, 200, { ok: true, deleted, cleanedAll: true, cleanedAgents: allAgentIds });
            return true;
        }

        // ─── Single session delete ───
        // DELETE /sessions/{key} — delete a single session and clean up all storage
        if (method === "DELETE" && sessionKey) {
            let deleted = false;

            // 1. Look up session in the in-memory index (O(1))
            const entry = sessionIndex.get(sessionKey);

            // 2. Delete the JSONL/JSON session file from disk
            if (entry && entry.filePath) {
                try { await unlinkAsync(entry.filePath); deleted = true; } catch { }
            }

            // 3. Delete from dashboard store JSON
            const dashFp = sessionFilePath(sessionKey);
            try { await unlinkAsync(dashFp); deleted = true; } catch { }

            // 4. Remove from sessions.json gateway index
            if (entry && entry.agentId) {
                const sessDir = join(AGENTS_STATE_DIR, entry.agentId, "sessions");
                const indexFile = join(sessDir, "sessions.json");
                try {
                    const indexRaw = await readFileAsync(indexFile, "utf-8");
                    const idx = JSON.parse(indexRaw);
                    let modified = false;
                    for (const [key, val] of Object.entries(idx)) {
                        const sid = (val as any).sessionId || "";
                        if (key === (entry.gatewayKey || "") || sid === sessionKey || key === sessionKey) {
                            // Also delete any session files referenced by the gateway index entry
                            if (sid) {
                                for (const ext of [".jsonl", ".json"]) {
                                    try { await unlinkAsync(join(sessDir, sid + ext)); deleted = true; } catch { }
                                }
                            }
                            delete idx[key];
                            modified = true;
                        }
                    }
                    if (modified) {
                        await writeFileAsync(indexFile, JSON.stringify(idx, null, 2), "utf-8");
                    }
                } catch { }

                // Also try deleting session files by key name directly (covers cases where
                // the file exists but wasn't tracked in the index entry's filePath)
                for (const ext of [".jsonl", ".json"]) {
                    const fp = join(sessDir, sessionKey + ext);
                    try { await unlinkAsync(fp); deleted = true; } catch { }
                }
            }

            // 5. Remove from sessionIndex map
            sessionIndex.delete(sessionKey);

            json(res, 200, { ok: true, deleted });
            return true;
        }
    } catch (err: any) {
        json(res, 500, { error: err.message ?? "Session operation failed" });
        return true;
    }

    return false;
}
