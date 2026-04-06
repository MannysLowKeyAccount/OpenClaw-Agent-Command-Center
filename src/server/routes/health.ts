import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    readConfig,
    readEnv,
    httpsGet,
    tryReadFile,
    CONFIG_PATH,
    OPENCLAW_DIR,
    AGENTS_STATE_DIR,
} from "../api-utils.js";
import { getProviderCache } from "./providers.js";

// ─── Gateway port helper ───
function getGatewayPort(config?: any): number {
    if (!config) config = readConfig();
    return config?.gateway?.port || 18789;
}

export async function handleHealthRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method || "GET";

    // ─── GET /api/debug — check config parsing ───
    if (path === "/debug" && method === "GET") {
        const rawContent = tryReadFile(CONFIG_PATH);
        const raw = rawContent !== null ? rawContent.slice(0, 500) : "FILE NOT FOUND";
        const config = readConfig();
        const agentsList = config.agents?.list || [];
        json(res, 200, {
            configPath: CONFIG_PATH,
            configExists: rawContent !== null,
            rawPreview: raw,
            agentCount: agentsList.length,
            agentIds: agentsList.map((a: any) => a.id),
            hasAgentsKey: !!config.agents,
            hasListKey: !!config.agents?.list,
            topKeys: Object.keys(config),
        });
        return true;
    }

    // ─── GET /api/debug/oauth — inspect what OAuth files exist on disk ───
    if (path === "/debug/oauth" && method === "GET") {
        const scan: any = { openclaw_dir: OPENCLAW_DIR, files: {} };
        // Check the two known locations
        const globalOAuthFile = join(OPENCLAW_DIR, "credentials", "oauth.json");
        const globalOAuthRaw = tryReadFile(globalOAuthFile);
        scan.files["credentials/oauth.json"] = { exists: globalOAuthRaw !== null };
        if (globalOAuthRaw !== null) {
            try {
                const raw = JSON.parse(globalOAuthRaw);
                scan.files["credentials/oauth.json"].keys = Object.keys(raw);
                scan.files["credentials/oauth.json"].is_map = !raw.access_token && !raw.token;
            } catch (e: any) { scan.files["credentials/oauth.json"].error = e.message; }
        }
        // Per-agent auth-profiles
        scan.agent_auth_profiles = [];
        if (existsSync(AGENTS_STATE_DIR)) {
            try {
                for (const agentId of readdirSync(AGENTS_STATE_DIR)) {
                    const authFile = join(AGENTS_STATE_DIR, agentId, "agent", "auth-profiles.json");
                    const authRaw = tryReadFile(authFile);
                    const entry: any = { agentId, path: authFile, exists: authRaw !== null };
                    if (authRaw !== null) {
                        try {
                            const raw = JSON.parse(authRaw);
                            entry.keys = Array.isArray(raw) ? raw.map((p: any) => p.name || p.provider || p.id) : Object.keys(raw);
                            entry.is_array = Array.isArray(raw);
                        } catch (e: any) { entry.error = (e as any).message; }
                    }
                    scan.agent_auth_profiles.push(entry);
                }
            } catch { }
        }
        json(res, 200, scan);
        return true;
    }

    // ─── GET /api/debug/sessions — inspect session files on disk ───
    if (path === "/debug/sessions" && method === "GET") {
        const result: any = { agentsStateDir: AGENTS_STATE_DIR, exists: existsSync(AGENTS_STATE_DIR), agentDirs: [] };
        if (result.exists) {
            for (const agentId of readdirSync(AGENTS_STATE_DIR)) {
                const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
                const agentEntry: any = { agentId, sessionsDir: sessDir, exists: existsSync(sessDir), files: [] };
                if (agentEntry.exists) {
                    try {
                        for (const f of readdirSync(sessDir)) {
                            if (!f.endsWith(".json")) continue;
                            try {
                                const raw = readFileSync(join(sessDir, f), "utf-8");
                                const s = JSON.parse(raw);
                                agentEntry.files.push({ file: f, keys: Object.keys(s), agentId: s.agentId, channel: s.channel, msgCount: (s.messages || s.conversation || s.history || []).length });
                            } catch (e: any) {
                                agentEntry.files.push({ file: f, error: e.message });
                            }
                        }
                    } catch { }
                }
                result.agentDirs.push(agentEntry);
            }
        }
        json(res, 200, result);
        return true;
    }

    // ─── GET /api/health — dynamic check: gateway + all configured providers + auth profiles ───
    if (path === "/health" && method === "GET") {
        const config = readConfig();
        const port = getGatewayPort(config);
        const authToken = config?.gateway?.auth?.token || "";
        const issues: { provider: string; status: string; error: string }[] = [];
        const env = readEnv();

        // 1. Check gateway is reachable
        let gatewayOk = false;
        try {
            await new Promise<string>((resolve, reject) => {
                const req = http.request({ hostname: "127.0.0.1", port, path: "/v1/models", method: "GET", headers: authToken ? { "Authorization": "Bearer " + authToken } : {}, timeout: 5000 }, (r) => {
                    let body = ""; r.on("data", (c: any) => body += c);
                    r.on("end", () => { if (r.statusCode && r.statusCode >= 400) reject(new Error(`HTTP ${r.statusCode}`)); else resolve(body); });
                });
                req.on("error", (e) => reject(e));
                req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
                req.end();
            });
            gatewayOk = true;
        } catch (e: any) {
            issues.push({ provider: "gateway", status: "error", error: e.message });
        }

        // Helper: probe a URL, classify the HTTP status
        function probeProvider(name: string, url: string, headers: Record<string, string>): Promise<void> {
            const isLocal = url.startsWith("http://");
            const getter = isLocal
                ? (u: string, h: Record<string, string>) => new Promise<{ status: number }>((resolve) => {
                    const parsed = new URL(u);
                    const req = http.get({ hostname: parsed.hostname, port: parsed.port || 80, path: parsed.pathname + parsed.search, headers: h, timeout: 6000 }, (r) => {
                        r.resume(); r.on("end", () => resolve({ status: r.statusCode ?? 0 }));
                    });
                    req.on("error", () => resolve({ status: 0 }));
                    req.on("timeout", () => { req.destroy(); resolve({ status: 0 }); });
                })
                : (u: string, h: Record<string, string>) => httpsGet(u, h);
            return getter(url, headers).then((r: any) => {
                const s = r.status || 0;
                if (s === 401 || s === 403) issues.push({ provider: name, status: "invalid", error: `Key/token invalid or revoked (HTTP ${s})` });
                else if (s === 429) issues.push({ provider: name, status: "rate_limited", error: `Rate limited / usage cap hit (HTTP 429)` });
                else if (s >= 500) issues.push({ provider: name, status: "error", error: `Provider error (HTTP ${s})` });
            }).catch(() => { });
        }

        const checks: Promise<void>[] = [];
        const checked = new Set<string>();
        const checkedProvNorm = new Set<string>(); // normalized provider names already probed

        // 2. Check all providers from config.models.providers (dynamic — reads your config)
        const cfgProviders = config.models?.providers || {};
        for (const [provName, provCfg] of Object.entries(cfgProviders) as [string, any][]) {
            if (checked.has(provName)) continue;
            checked.add(provName);
            const normName = provName.toLowerCase().replace(/[^a-z0-9]/g, "");
            checkedProvNorm.add(normName);
            const baseUrl = (provCfg.baseUrl || "").replace(/\/+$/, "");
            if (!baseUrl) continue;
            // Resolve API key
            let apiKey = provCfg.apiKey || "";
            if (apiKey && env[apiKey]) apiKey = env[apiKey];
            if (!apiKey && provCfg.keyRef) { const ref = typeof provCfg.keyRef === "string" ? provCfg.keyRef : provCfg.keyRef?.id; if (ref) apiKey = env[ref] || ""; }
            // Skip local services with no key (ollama etc.)
            if (!apiKey && (baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost"))) continue;
            // Skip non-standard APIs that don't have a /models endpoint
            const api = (provCfg.api || "").toLowerCase();
            if (api.includes("anthropic") && !baseUrl.includes("api.anthropic.com")) continue;
            if (api.includes("ollama") && !apiKey) continue;
            // Build probe URL
            let probeUrl = baseUrl;
            if (baseUrl.endsWith("/v1")) probeUrl += "/models";
            else if (!baseUrl.includes("/models")) probeUrl += "/v1/models";
            // Build auth headers
            const headers: Record<string, string> = {};
            if (api.includes("anthropic")) { if (apiKey) headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; }
            else if (apiKey) { headers["Authorization"] = "Bearer " + apiKey; }
            checks.push(probeProvider(provName, probeUrl, headers));
        }

        // 3. Check all auth profiles (OAuth — Codex, Kimi, etc.)
        const authFiles = [join(AGENTS_STATE_DIR, "main", "agent", "auth-profiles.json"), join(OPENCLAW_DIR, "credentials", "oauth.json")];
        for (const authFile of authFiles) {
            const authRaw = tryReadFile(authFile);
            if (authRaw === null) continue;
            try {
                const raw = JSON.parse(authRaw);
                const profiles = raw.profiles || raw;
                if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) continue;
                for (const [key, val] of Object.entries(profiles)) {
                    const profile = val as any;
                    const provider = profile.provider || key.split(":")[0];
                    if (checked.has(key)) continue;
                    checked.add(key);
                    // Skip if this provider was already probed via config.models.providers
                    const provNorm = provider.toLowerCase().replace(/[^a-z0-9]/g, "");
                    if (checkedProvNorm.has(provNorm)) continue;
                    const token = profile.access || profile.access_token || profile.key || null;
                    const isOAuth = profile.mode === "oauth" || profile.type === "oauth";
                    // Check expiry
                    if (isOAuth) {
                        const expiry = profile.expires || profile.expires_at || profile.expiry_date;
                        if (expiry) { const n = typeof expiry === "string" ? Date.parse(expiry) : Number(expiry); const ms = n > 1e12 ? n : n * 1000; if (ms < Date.now()) { issues.push({ provider, status: "expired", error: "OAuth token expired" }); continue; } }
                        if (!token) { issues.push({ provider, status: "invalid", error: "No OAuth token — needs re-authentication" }); continue; }
                        // For OAuth with valid JWT + refresh token, skip probing
                        const hasRefresh = !!(profile.refresh || profile.refresh_token);
                        if (token && hasRefresh) {
                            try {
                                const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
                                if (payload.exp && (payload.exp * 1000) > Date.now()) continue; // JWT valid, skip probe
                            } catch { }
                            continue;
                        }
                    }
                    // Resolve key
                    let resolvedKey = token;
                    if (!resolvedKey && profile.keyRef) { const ref = typeof profile.keyRef === "string" ? profile.keyRef : profile.keyRef?.id; if (ref) resolvedKey = env[ref] || null; }
                    if (!resolvedKey) continue;
                    // Determine probe URL — check config first, then infer from provider name
                    const provLower = provider.toLowerCase().replace(/[^a-z0-9]/g, "");
                    let probeUrl = "";
                    const headers: Record<string, string> = {};
                    const cfgProv = cfgProviders[provider] || cfgProviders[provLower];
                    if (cfgProv?.baseUrl) {
                        const base = cfgProv.baseUrl.replace(/\/+$/, "");
                        probeUrl = base.endsWith("/v1") ? base + "/models" : base + "/v1/models";
                        const api = (cfgProv.api || "").toLowerCase();
                        if (api.includes("anthropic")) { headers["x-api-key"] = resolvedKey; headers["anthropic-version"] = "2023-06-01"; }
                        else { headers["Authorization"] = "Bearer " + resolvedKey; }
                    } else if (provLower.includes("openai") || provLower.includes("codex") || provLower.includes("copilot")) {
                        probeUrl = "https://api.openai.com/v1/models"; headers["Authorization"] = "Bearer " + resolvedKey;
                    } else if (provLower.includes("anthropic")) {
                        probeUrl = "https://api.anthropic.com/v1/models"; headers["x-api-key"] = resolvedKey; headers["anthropic-version"] = "2023-06-01";
                    } else if (provLower.includes("kimi") || provLower.includes("moonshot")) {
                        probeUrl = "https://api.moonshot.cn/v1/models"; headers["Authorization"] = "Bearer " + resolvedKey;
                    } else if (provLower.includes("groq")) {
                        probeUrl = "https://api.groq.com/openai/v1/models"; headers["Authorization"] = "Bearer " + resolvedKey;
                    } else if (provLower.includes("mistral")) {
                        probeUrl = "https://api.mistral.ai/v1/models"; headers["Authorization"] = "Bearer " + resolvedKey;
                    } else if (provLower.includes("openrouter")) {
                        probeUrl = "https://openrouter.ai/api/v1/auth/key"; headers["Authorization"] = "Bearer " + resolvedKey;
                    } else if (provLower.includes("gemini") || provLower.includes("google")) {
                        probeUrl = "https://generativelanguage.googleapis.com/v1beta/models?key=" + resolvedKey;
                    }
                    if (probeUrl) checks.push(probeProvider(provider, probeUrl, headers));
                }
            } catch { }
        }

        // 4. Check .env keys not already covered
        const envMap: [string, string, (k: string) => Record<string, string>][] = [
            ["OPENAI_API_KEY", "https://api.openai.com/v1/models", (k) => ({ "Authorization": "Bearer " + k })],
            ["ANTHROPIC_API_KEY", "https://api.anthropic.com/v1/models", (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" })],
            ["GROQ_API_KEY", "https://api.groq.com/openai/v1/models", (k) => ({ "Authorization": "Bearer " + k })],
            ["MISTRAL_API_KEY", "https://api.mistral.ai/v1/models", (k) => ({ "Authorization": "Bearer " + k })],
            ["OPENROUTER_API_KEY", "https://openrouter.ai/api/v1/auth/key", (k) => ({ "Authorization": "Bearer " + k })],
        ];
        for (const [envVar, url, hdr] of envMap) {
            if (!env[envVar]) continue;
            const name = envVar.replace(/_API_KEY$/, "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
            if (checked.has(name.toLowerCase())) continue;
            checked.add(name.toLowerCase());
            checks.push(probeProvider(name, url, hdr(env[envVar])));
        }
        const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
        if (geminiKey && !checked.has("gemini")) {
            checks.push(probeProvider("Google", "https://generativelanguage.googleapis.com/v1beta/models?key=" + geminiKey, {}));
        }

        await Promise.all(checks);
        json(res, 200, { ok: gatewayOk && issues.length === 0, gateway: gatewayOk ? "ok" : "error", issues, checkedAt: new Date().toISOString() });
        return true;
    }

    return false;
}
