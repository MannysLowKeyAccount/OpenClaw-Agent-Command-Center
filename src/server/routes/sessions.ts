import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { stat as statAsync, readdir as readdirAsync, readFile as readFileAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";

import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    parseBody,
    readConfig,
    resolveHome,
    tryReadFile,
    AGENTS_STATE_DIR,
    DASHBOARD_SESSIONS_DIR,
} from "../api-utils.js";

// ─── JSONL session parser ───
export function parseSessionJsonl(filePath: string): { messages: any[]; agentId: string; channel: string; updatedAt: string | null } {
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

// ─── Async JSONL session parser ───
export async function parseSessionJsonlAsync(filePath: string): Promise<{ messages: any[]; agentId: string; channel: string; updatedAt: string | null }> {
    const raw = await readFileAsync(filePath, "utf-8");
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
};

export const sessionIndex: Map<string, SessionIndexEntry> = new Map();

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

                for (const ext of [".jsonl", ".json"]) {
                    const fp = join(sessDir, sid + ext);
                    try {
                        const st = await statAsync(fp);
                        filePath = fp;
                        mtime = st.mtimeMs;
                        updatedAt = updatedAt || st.mtime.toISOString();
                        if (ext === ".jsonl") {
                            messageCount = Math.max(1, Math.round(st.size / 500));
                        }
                        break;
                    } catch {
                        // file doesn't exist for this extension
                    }
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

                if (isJsonl) {
                    try {
                        const head = (await readFileAsync(fp, "utf-8")).slice(0, 2000);
                        const firstLine = head.split("\n")[0];
                        if (firstLine) {
                            const entry = JSON.parse(firstLine);
                            if (entry.agentId) fileAgentId = entry.agentId;
                            if (entry.channel) channel = entry.channel;
                        }
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
                    messageCount: isJsonl ? Math.max(1, Math.round(st.size / 500)) : 1,
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

            if (isJsonl) {
                try {
                    const head = (await readFileAsync(entry.filePath, "utf-8")).slice(0, 2000);
                    const firstLine = head.split("\n")[0];
                    if (firstLine) {
                        const parsed = JSON.parse(firstLine);
                        if (parsed.agentId) agentId = parsed.agentId;
                        if (parsed.channel) channel = parsed.channel;
                    }
                } catch { }
            } else if (entry.filePath.endsWith(".json")) {
                try {
                    const raw = JSON.parse(await readFileAsync(entry.filePath, "utf-8"));
                    if (raw.agentId) agentId = raw.agentId;
                    if (raw.channel || raw.channelType) channel = raw.channel || raw.channelType;
                } catch { }
            }

            sessionIndex.set(key, {
                sessionKey: key,
                agentId,
                filePath: entry.filePath,
                channel,
                gatewayKey: entry.gatewayKey,
                messageCount: isJsonl ? Math.max(1, Math.round(st.size / 500)) : 1,
                updatedAt: st.mtime.toISOString(),
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
                            messageCount = Math.max(1, Math.round(st.size / 500));
                        }
                        break;
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

                sessionIndex.set(sk, {
                    sessionKey: sk,
                    agentId: fileAgentId,
                    filePath: fp,
                    channel,
                    gatewayKey: "",
                    messageCount: isJsonl ? Math.max(1, Math.round(st.size / 500)) : 1,
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
}

// ─── Legacy cache stubs (no-ops, removed in task 5 when route handlers are rewritten) ───
function isSessionCacheValid(): boolean { return false; }
function setSessionCache(_sessions: any[]): void { }
let sessionCache: any[] | null = null;
function getAgentSessionCache(_agentId: string): any[] | null { return null; }
function setAgentSessionCache(_agentId: string, _sessions: any[]): void { }

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

// ─── Targeted async scan of a single agent's sessions dir, updating the index ───
async function scanAndIndexAgentSessions(agentId: string): Promise<void> {
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

            for (const ext of [".jsonl", ".json"]) {
                const fp = join(sessDir, sid + ext);
                try {
                    const st = await statAsync(fp);
                    filePath = fp;
                    mtime = st.mtimeMs;
                    updatedAt = updatedAt || st.mtime.toISOString();
                    if (ext === ".jsonl") {
                        messageCount = Math.max(1, Math.round(st.size / 500));
                    }
                    break;
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

            sessionIndex.set(sk, {
                sessionKey: sk,
                agentId: fileAgentId,
                filePath: fp,
                channel,
                gatewayKey: "",
                messageCount: isJsonl ? Math.max(1, Math.round(st.size / 500)) : 1,
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

            // If scan=1, do an incremental mtime-based refresh (no CLI spawn)
            if (scan) {
                await refreshSessionIndex();
            }

            // Collect agent IDs to include: the requested agent + its subagents
            const config = readConfig();
            const agentCfg = (config.agents?.list || []).find((a: any) => a.id === agentId);
            const childIds: string[] = agentCfg?.subagents?.allowAgents || [];
            const allAgentIds = new Set([agentId, ...childIds]);

            // Filter sessionIndex entries by agentId (including subagents and dashboard sessions)
            const seen = new Set<string>();
            const sessions: any[] = [];
            for (const entry of sessionIndex.values()) {
                if (!allAgentIds.has(entry.agentId) && entry.channel !== "dashboard") continue;
                // For dashboard entries, only include if they belong to this agent
                if (entry.channel === "dashboard" && entry.agentId !== agentId) continue;
                // For non-dashboard entries, agentId must be in allAgentIds (already checked above)
                if (entry.channel !== "dashboard" && !allAgentIds.has(entry.agentId)) continue;

                if (seen.has(entry.sessionKey)) continue;
                seen.add(entry.sessionKey);
                sessions.push({
                    sessionKey: entry.sessionKey,
                    agentId: entry.agentId,
                    channel: entry.channel,
                    gatewayKey: entry.gatewayKey,
                    messageCount: entry.messageCount,
                    updatedAt: entry.updatedAt,
                });
            }

            json(res, 200, { sessions, agentId });
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
            for (const entry of sessionIndex.values()) {
                sessions.push({
                    sessionKey: entry.sessionKey,
                    agentId: entry.agentId,
                    channel: entry.channel,
                    gatewayKey: entry.gatewayKey,
                    messageCount: entry.messageCount,
                    updatedAt: entry.updatedAt,
                });
            }

            json(res, 200, { sessions });
            return true;
        }

        const sessionKey = sub[0];
        const action = sub[1];

        // GET /sessions/{key} — get single session with messages (deterministic single-path)
        if (method === "GET" && sessionKey && !action) {
            let session: any = null;

            // 1. Look up sessionKey in the in-memory index
            let entry = sessionIndex.get(sessionKey);

            // 2. If found, load messages from the file
            if (entry && entry.filePath) {
                if (entry.filePath.endsWith(".jsonl")) {
                    const parsed = await parseSessionJsonlAsync(entry.filePath);
                    session = {
                        sessionKey,
                        agentId: parsed.agentId || entry.agentId,
                        channel: parsed.channel || entry.channel,
                        messages: parsed.messages,
                        updatedAt: parsed.updatedAt,
                    };
                } else if (entry.filePath.endsWith(".json")) {
                    try {
                        const raw = JSON.parse(await readFileAsync(entry.filePath, "utf-8"));
                        session = {
                            sessionKey,
                            agentId: raw.agentId || entry.agentId,
                            channel: raw.channel || raw.channelType || entry.channel,
                            messages: Array.isArray(raw.messages) ? raw.messages : [],
                            updatedAt: raw.updatedAt || entry.updatedAt,
                        };
                    } catch { }
                }
            }

            // 3. If index miss, try a targeted async scan of the likely agent directory
            if (!session) {
                const agentIdFromKey = sessionKey.replace(/-\d+$/, "");
                if (agentIdFromKey) {
                    await scanAndIndexAgentSessions(agentIdFromKey);
                    entry = sessionIndex.get(sessionKey);
                    if (entry && entry.filePath) {
                        if (entry.filePath.endsWith(".jsonl")) {
                            const parsed = await parseSessionJsonlAsync(entry.filePath);
                            session = {
                                sessionKey,
                                agentId: parsed.agentId || entry.agentId,
                                channel: parsed.channel || entry.channel,
                                messages: parsed.messages,
                                updatedAt: parsed.updatedAt,
                            };
                        } else if (entry.filePath.endsWith(".json")) {
                            try {
                                const raw = JSON.parse(await readFileAsync(entry.filePath, "utf-8"));
                                session = {
                                    sessionKey,
                                    agentId: raw.agentId || entry.agentId,
                                    channel: raw.channel || raw.channelType || entry.channel,
                                    messages: Array.isArray(raw.messages) ? raw.messages : [],
                                    updatedAt: raw.updatedAt || entry.updatedAt,
                                };
                            } catch { }
                        }
                    }
                }
            }

            // 4. Final fallback: check dashboard session store (async)
            if (!session) {
                const dashSession = await readDashboardSessionAsync(sessionKey);
                if (dashSession) {
                    session = dashSession;
                }
            }

            json(res, 200, {
                session: session || {},
                messageCount: session?.messages?.length ?? 0,
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
            const body = await parseBody(req);
            if (!body.message) { json(res, 400, { error: "message required" }); return true; }
            const agentId = body.agentId || "";
            const userMessage = body.message;

            let responseText = "";

            // The openclaw CLI always routes messages to the agent's primary session.
            // Find the primary session key so the frontend can refresh from the right place.
            let primarySessionKey = sessionKey;
            for (const entry of sessionIndex.values()) {
                if (entry.gatewayKey.endsWith(":main") && entry.filePath.endsWith(".jsonl")) {
                    // Find the agent:X:main session — that's where the CLI routes messages
                    const gkAgent = entry.gatewayKey.replace(/:main$/, "").replace(/^agent:/, "");
                    if (gkAgent === agentId) {
                        primarySessionKey = entry.sessionKey;
                        break;
                    }
                }
            }

            // Send via openclaw CLI (the gateway's native message interface)
            try {
                const escaped = userMessage.replace(/"/g, '\\"');
                const agentFlag = agentId ? ` --agent "${agentId}"` : "";
                const cmd = `openclaw agent --message "${escaped}"${agentFlag}`;
                const rawOutput = await new Promise<string>((resolve, reject) => {
                    exec(cmd, { encoding: "utf-8", timeout: 180000 }, (err, stdout, stderr) => {
                        if (err) reject(new Error(stdout || stderr || err.message));
                        else resolve(stdout || "");
                    });
                });
                // Strip plugin initialization logs and deprecation warnings from CLI output
                responseText = rawOutput.split("\n").filter(line =>
                    !line.startsWith("[plugins]") &&
                    !line.startsWith("Config warnings") &&
                    !line.startsWith("(node:") &&
                    !line.startsWith("(Use `node")
                ).join("\n").trim();
            } catch (cliErr: any) {
                const cliMsg = cliErr?.message || "Message send failed";
                const isAuthOrLimit = /usage limit|rate.limit|rate_limit|quota|invalid.*key|invalid.*api|unauthorized|401|403|429|too many requests|failover/i.test(cliMsg);
                if (isAuthOrLimit) {
                    json(res, 429, {
                        error: cliMsg,
                        errorType: "model_limit",
                        userMessageSaved: true,
                    });
                    return true;
                }
                json(res, 503, {
                    error: cliMsg,
                    ok: false,
                });
                return true;
            }

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
            const session = {
                sessionKey: newKey,
                agentId,
                channel: "dashboard",
                messages: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            writeDashboardSession(session);
            sessionIndex.set(newKey, {
                sessionKey: newKey,
                agentId,
                filePath: sessionFilePath(newKey),
                channel: "dashboard",
                gatewayKey: "",
                messageCount: 0,
                updatedAt: new Date().toISOString(),
                mtime: 0,
            });
            json(res, 201, { sessionKey: newKey, ok: true });
            return true;
        }

        // DELETE /sessions/{key} — terminate a session and clean up all files
        if (method === "DELETE" && sessionKey) {
            let deleted = false;

            // Special: "all:{agentId}" deletes ALL sessions for an agent AND its subagent children
            if (sessionKey.startsWith("all:")) {
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

                // Delete all matching session files (async)
                const deletePromises: Promise<void>[] = [];
                for (const entry of toDelete) {
                    // Delete the session file itself
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
                    // Delete dashboard JSON file
                    const dashFp = sessionFilePath(entry.sessionKey);
                    deletePromises.push(
                        unlinkAsync(dashFp).then(() => { deleted = true; }).catch(() => { })
                    );
                }

                // Also delete dashboard sessions that might not be in the index
                // (filter by agentId from dashboard files)
                for (const aid of allAgentIds) {
                    const sessDir = join(AGENTS_STATE_DIR, aid, "sessions");
                    agentDirsToClean.add(sessDir);
                    // Delete all files in the agent sessions dir
                    try {
                        const files = await readdirAsync(sessDir);
                        for (const f of files) {
                            deletePromises.push(
                                unlinkAsync(join(sessDir, f)).then(() => { deleted = true; }).catch(() => { })
                            );
                        }
                    } catch { }
                }

                await Promise.all(deletePromises);

                // Remove all matching entries from sessionIndex immediately
                for (const entry of toDelete) {
                    sessionIndex.delete(entry.sessionKey);
                }

                json(res, 200, { ok: true, deleted, cleanedAll: true, cleanedAgents: allAgentIds });
                return true;
            }

            // ─── Single session delete ───

            // 1. Look up session in the in-memory index (O(1))
            const entry = sessionIndex.get(sessionKey);

            // 2. Delete the session file (async, ignore ENOENT)
            if (entry && entry.filePath) {
                try { await unlinkAsync(entry.filePath); deleted = true; } catch { }
            }

            // 3. Delete the dashboard JSON file
            const dashFp = sessionFilePath(sessionKey);
            try { await unlinkAsync(dashFp); deleted = true; } catch { }

            // 4. Update sessions.json in the agent's sessions dir (async read/write)
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

                // Also try deleting session files by key name directly
                for (const ext of [".jsonl", ".json"]) {
                    const fp = join(sessDir, sessionKey + ext);
                    try { await unlinkAsync(fp); deleted = true; } catch { }
                }
            }

            // 5. Remove from sessionIndex immediately
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
