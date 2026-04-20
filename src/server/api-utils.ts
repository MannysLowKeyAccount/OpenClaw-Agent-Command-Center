import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { exec, execFile } from "node:child_process";
import { homedir } from "node:os";
import * as https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Path constants ───
export const OPENCLAW_DIR = process.env.OPENCLAW_STATE_DIR || process.env.OPENCLAW_HOME || join(homedir(), ".openclaw");
export const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || join(OPENCLAW_DIR, "openclaw.json");
export const AGENTS_STATE_DIR = join(OPENCLAW_DIR, "agents");
export const DASHBOARD_CONFIG_DIR = join(OPENCLAW_DIR, "extensions", "openclaw-agent-dashboard");
export const DASHBOARD_CONFIG_PATH = join(DASHBOARD_CONFIG_DIR, "dashboard-config.json");
export const DASHBOARD_SESSIONS_DIR = join(DASHBOARD_CONFIG_DIR, "sessions");
export const DASHBOARD_TASKS_DIR = join(DASHBOARD_CONFIG_DIR, "Tasks");
export const DASHBOARD_FLOWS_DIR = join(DASHBOARD_TASKS_DIR, "flows");
export const DASHBOARD_FLOW_DEFS_DIR = join(DASHBOARD_FLOWS_DIR, "definitions");
export const DASHBOARD_FLOW_STATE_DIR = join(DASHBOARD_FLOWS_DIR, "state");
export const DASHBOARD_FLOW_HISTORY_DIR = join(DASHBOARD_FLOWS_DIR, "history");

export const WORKSPACE_MD_FILES = [
    "AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md",
    "TOOLS.md", "BOOTSTRAP.md", "HEARTBEAT.md",
];

// ─── CLI result cache — avoids re-spawning slow child processes on rapid page loads ───
const _cliCache = new Map<string, { data: any; expires: number }>();
const CLI_CACHE_TTL = 15_000; // 15 seconds
const CLI_CACHE_MAX_SIZE = 50; // hard cap to prevent unbounded growth

export function getCachedCli(key: string): any | null {
    const entry = _cliCache.get(key);
    if (entry && Date.now() < entry.expires) return entry.data;
    // Expired — remove it immediately
    if (entry) _cliCache.delete(key);
    return null;
}

export function setCachedCli(key: string, data: any): void {
    _cliCache.set(key, { data, expires: Date.now() + CLI_CACHE_TTL });
    // Evict expired entries when cache grows beyond limit
    if (_cliCache.size > CLI_CACHE_MAX_SIZE) {
        _pruneCliCache();
    }
}

export function deleteCachedCli(key: string): void {
    _cliCache.delete(key);
}

function _pruneCliCache(): void {
    const now = Date.now();
    for (const [k, v] of _cliCache) {
        if (now >= v.expires) _cliCache.delete(k);
    }
    // If still over limit after expiry sweep, drop oldest entries
    if (_cliCache.size > CLI_CACHE_MAX_SIZE) {
        const excess = _cliCache.size - CLI_CACHE_MAX_SIZE;
        let removed = 0;
        for (const k of _cliCache.keys()) {
            if (removed >= excess) break;
            _cliCache.delete(k);
            removed++;
        }
    }
}

// ─── Config I/O ───
let _configError: string | null = null;
let _configCache: { data: any; mtime: number } | null = null;

export function readConfig(): any {
    _configError = null;
    if (!existsSync(CONFIG_PATH)) return {};
    let mtime = 0;
    try {
        mtime = statSync(CONFIG_PATH).mtimeMs;
        if (_configCache && _configCache.mtime === mtime) return _configCache.data;
    } catch { /* fall through to read */ }
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    // Try parsing as-is first (standard JSON)
    try {
        const data = JSON.parse(raw);
        if (mtime) _configCache = { data, mtime };
        return data;
    } catch (e1: any) {
        // Fall back: strip JSON5 comments and trailing commas
        try {
            let cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
            cleaned = cleaned.replace(/,\s*([\]}])/g, "$1");
            const data = JSON.parse(cleaned);
            if (mtime) _configCache = { data, mtime };
            return data;
        } catch (e2: any) {
            // Build a helpful error message with line/column info
            const msg = e1.message || e2.message || "Unknown parse error";
            let detail = msg;
            const posMatch = msg.match(/position\s+(\d+)/i);
            if (posMatch) {
                const pos = parseInt(posMatch[1], 10);
                const before = raw.slice(0, pos);
                const line = (before.match(/\n/g) || []).length + 1;
                const lastNl = before.lastIndexOf("\n");
                const col = pos - lastNl;
                const lines = raw.split("\n");
                const startLine = Math.max(0, line - 3);
                const endLine = Math.min(lines.length, line + 2);
                const context = lines.slice(startLine, endLine).map((l, i) => {
                    const ln = startLine + i + 1;
                    const marker = ln === line ? " >>> " : "     ";
                    return marker + ln + " | " + l;
                }).join("\n");
                detail = `Line ${line}, Column ${col}: ${msg}\n\n${context}`;
            }
            _configError = detail;
            console.error("[agent-dashboard] Failed to parse openclaw.json:", detail);
            return {};
        }
    }
}

export function getConfigError(): string | null { return _configError; }

export function writeConfig(config: any): void {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// ─── Deferred config staging ───
// Holds a pending config snapshot that hasn't been written to disk yet.
// This lets the dashboard batch multiple changes without triggering a
// gateway restart after each one.
let _pendingConfig: any | null = null;
let _pendingChangeCount = 0;
let _pendingDescriptions: string[] = [];
type PendingDestructiveOp = {
    kind: string;
    key: string;
    description: string;
    apply: () => void;
    name?: string;
    configKey?: string;
    path?: string;
    agentId?: string;
    flowName?: string;
    dirName?: string;
    scope?: string;
};
let _pendingDestructiveOps: PendingDestructiveOp[] = [];

type PendingDestructiveOpFailure = {
    key: string;
    description: string;
    error: string;
};

/** Stage a config snapshot for later commit. Does NOT write to disk. */
export function stageConfig(config: any, description?: string): void {
    _pendingConfig = config;
    _pendingChangeCount++;
    if (description) _pendingDescriptions.push(description);
}

/** Commit the staged config to disk (triggers gateway restart). Returns false if nothing staged. */
export function commitPendingConfig(): boolean {
    if (_pendingConfig === null) return false;
    writeConfig(_pendingConfig);
    _pendingConfig = null;
    _pendingChangeCount = 0;
    _pendingDescriptions = [];
    return true;
}

/** Discard all pending changes without writing. */
export function discardPendingConfig(): void {
    _pendingConfig = null;
    _pendingChangeCount = 0;
    _pendingDescriptions = [];
}

/** Stage a destructive operation for later apply/restart. Does NOT mutate runtime/files yet. */
export function stagePendingDestructiveOp(op: PendingDestructiveOp): void {
    const idx = _pendingDestructiveOps.findIndex((item) => item.key === op.key);
    if (idx >= 0) _pendingDestructiveOps[idx] = op;
    else _pendingDestructiveOps.push(op);
}

/** Get pending destructive ops. */
export function getPendingDestructiveOps(): { kind: string; key: string; description: string; name?: string; configKey?: string; path?: string; agentId?: string; flowName?: string; dirName?: string; scope?: string }[] {
    return _pendingDestructiveOps.map(({ kind, key, description, name, configKey, path, agentId, flowName, dirName, scope }) => ({ kind, key, description, name, configKey, path, agentId, flowName, dirName, scope }));
}

/** Apply staged destructive ops and clear the journal. */
export function commitPendingDestructiveOps(): { applied: number; failed: PendingDestructiveOpFailure[] } {
    const priority = (kind: string): number => {
        if (kind === "agent") return 0;
        if (kind === "skill") return 1;
        if (kind === "flow-definition") return 2;
        return 10;
    };

    const ops = _pendingDestructiveOps
        .map((op, index) => ({ op, index }))
        .sort((a, b) => priority(a.op.kind) - priority(b.op.kind) || a.index - b.index)
        .map(({ op }) => op);
    let applied = 0;
    const failed: PendingDestructiveOpFailure[] = [];
    const remaining: PendingDestructiveOp[] = [];
    for (const op of ops) {
        try {
            op.apply();
            applied++;
        } catch (err) {
            console.error("[agent-dashboard] Failed to apply staged destructive op:", op.key, err);
            failed.push({
                key: op.key,
                description: op.description,
                error: err instanceof Error ? err.message : String(err),
            });
            remaining.push(op);
        }
    }
    _pendingDestructiveOps = remaining;
    return { applied, failed };
}

/** Discard staged destructive ops without applying them. */
export function discardPendingDestructiveOps(): void {
    _pendingDestructiveOps = [];
}

/** Get pending config state. Returns null if nothing is staged. */
export function getPendingConfig(): { config: any; changeCount: number; descriptions: string[] } | null {
    if (_pendingConfig === null) return null;
    return { config: _pendingConfig, changeCount: _pendingChangeCount, descriptions: _pendingDescriptions };
}

export function getPendingChangeCount(): number {
    return _pendingChangeCount + _pendingDestructiveOps.length;
}

export function getPendingChangeDescriptions(): string[] {
    return [..._pendingDescriptions, ..._pendingDestructiveOps.map((op) => op.description)];
}

export function hasPendingChanges(): boolean {
    return _pendingConfig !== null || _pendingDestructiveOps.length > 0;
}

export function commitPendingChanges(): { committed: boolean; configWritten: boolean; destructiveOpFailures: PendingDestructiveOpFailure[] } {
    if (!hasPendingChanges()) return { committed: false, configWritten: false, destructiveOpFailures: [] };
    const configWritten = _pendingConfig !== null;
    if (_pendingConfig !== null) writeConfig(_pendingConfig);
    const destructiveOpResult = commitPendingDestructiveOps();
    _pendingConfig = null;
    _pendingChangeCount = 0;
    _pendingDescriptions = [];
    return { committed: true, configWritten, destructiveOpFailures: destructiveOpResult.failed };
}

export function discardPendingChanges(): void {
    discardPendingConfig();
    discardPendingDestructiveOps();
}

/**
 * Read the effective config — returns the pending staged config if one exists,
 * otherwise reads from disk. This ensures subsequent edits build on top of
 * previous staged changes rather than overwriting them.
 */
export function readEffectiveConfig(): any {
    if (_pendingConfig !== null) return JSON.parse(JSON.stringify(_pendingConfig));
    return JSON.parse(JSON.stringify(readConfig()));
}

// ─── Dashboard extension config (icons, UI prefs — NOT stored in openclaw.json) ───
export function readDashboardConfig(): any {
    const raw = tryReadFile(DASHBOARD_CONFIG_PATH);
    if (raw === null) return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

export function writeDashboardConfig(cfg: any): void {
    if (!existsSync(DASHBOARD_CONFIG_DIR)) mkdirSync(DASHBOARD_CONFIG_DIR, { recursive: true });
    writeFileSync(DASHBOARD_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

// ─── .env reader ───
export function readEnv(): Record<string, string> {
    const envPath = join(OPENCLAW_DIR, ".env");
    const content = tryReadFile(envPath);
    if (content === null) return {};
    const out: Record<string, string> = {};
    for (const line of content.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#\r\n]*)"?\s*$/);
        if (m) out[m[1]] = m[2].trim();
    }
    return out;
}

// ─── HTTP helper ───
export function httpsGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string; rawHeaders: Record<string, string> }> {
    return new Promise((resolve) => {
        const u = new URL(url);
        const opts = { hostname: u.hostname, path: u.pathname + u.search, headers, method: "GET" };
        const req = https.request(opts, (res) => {
            let body = "";
            res.on("data", (c: any) => body += c);
            res.on("end", () => {
                // Flatten headers: last value wins for duplicates
                const rawHeaders: Record<string, string> = {};
                const h = res.headers as Record<string, string | string[]>;
                for (const k of Object.keys(h)) {
                    const v = h[k];
                    rawHeaders[k] = Array.isArray(v) ? v[v.length - 1] : v;
                }
                resolve({ status: res.statusCode ?? 0, body, rawHeaders });
            });
        });
        req.on("error", () => resolve({ status: 0, body: "", rawHeaders: {} }));
        req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, body: "timeout", rawHeaders: {} }); });
        req.end();
    });
}

// ─── Process helpers ───
export function execAsync(cmd: string, opts: any = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(cmd, { encoding: "utf-8", ...opts }, (err: any, stdout: string | Buffer, stderr: string | Buffer) => {
            if (err) {
                reject(new Error(String(stderr || stdout || err.message || "Command failed")));
            } else {
                resolve(String(stdout || ""));
            }
        });
    });
}

export function execFileAsync(file: string, args: string[], opts: any = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { encoding: "utf-8", ...opts }, (err: any, stdout: string | Buffer, stderr: string | Buffer) => {
            if (err) {
                reject(new Error(String(stderr || stdout || err.message || "Command failed")));
            } else {
                resolve(String(stdout || ""));
            }
        });
    });
}

/** Escape a string for safe use inside double quotes in a shell command. */
export function shellEsc(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

// ─── Response helpers ───
const MAX_API_BODY = 1_048_576; // 1MB

export function parseBody(req: IncomingMessage, maxSize: number = MAX_API_BODY): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk: any) => {
            if (body.length + chunk.length > maxSize) {
                req.destroy();
                reject(new Error("Payload too large"));
                return;
            }
            body += chunk;
        });
        req.on("end", () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(new Error("Invalid JSON body")); }
        });
        req.on("error", reject);
    });
}

export function json(res: ServerResponse, status: number, data: any): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
}

// ─── Agent helpers ───
export function resolveHome(p: string): string {
    if (p.startsWith("~/")) return join(homedir(), p.slice(2));
    return p;
}

export function getAgentWorkspace(agent: any): string {
    if (agent.workspace) return resolveHome(agent.workspace);
    return join(OPENCLAW_DIR, agent.id === "main" ? "workspace" : `workspace-${agent.id}`);
}

export function getAgentDir(agent: any): string {
    if (agent.agentDir) return resolveHome(agent.agentDir);
    return join(AGENTS_STATE_DIR, agent.id, "agent");
}

export function getAgentSessionsDir(agentId: string): string {
    return join(AGENTS_STATE_DIR, agentId, "sessions");
}

// ─── File read helper — replaces existsSync + readFileSync pattern ───
export function tryReadFile(path: string): string | null {
    try { return readFileSync(path, "utf-8"); } catch { return null; }
}

// ─── Async file read helper — for hot paths (session routes) to avoid blocking the event loop ───
export async function tryReadFileAsync(path: string): Promise<string | null> {
    try { return await readFileAsync(path, "utf-8"); } catch { return null; }
}
