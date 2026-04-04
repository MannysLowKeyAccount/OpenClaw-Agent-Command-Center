import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync, watchFile, unwatchFile, openSync, readSync, closeSync } from "node:fs";
import { join, extname } from "node:path";
import { exec } from "node:child_process";
import { homedir } from "node:os";
import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Paths ───
const OPENCLAW_DIR = join(homedir(), ".openclaw");
const CONFIG_PATH = join(OPENCLAW_DIR, "openclaw.json");
const AGENTS_STATE_DIR = join(OPENCLAW_DIR, "agents");
const DASHBOARD_CONFIG_DIR = join(OPENCLAW_DIR, "extensions", "openclaw-agent-dashboard");
const DASHBOARD_CONFIG_PATH = join(DASHBOARD_CONFIG_DIR, "dashboard-config.json");
const DASHBOARD_SESSIONS_DIR = join(DASHBOARD_CONFIG_DIR, "sessions");

const WORKSPACE_MD_FILES = [
    "AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md",
    "TOOLS.md", "BOOTSTRAP.md", "HEARTBEAT.md",
];

// ─── Provider status cache — built once at startup, served on page load ───
let _providerCache: any = null;
let _providerCacheBuilding = false;

// ─── Scan all providers: API keys from .env + OAuth/auth profiles ───
async function _scanAllProviders(): Promise<{ providers: any[]; oauth: any[]; note?: string }> {
    const env = readEnv();
    const results: any[] = [];

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400e3);
    const toIso = (d: Date) => d.toISOString().split("T")[0];

    // Anthropic
    if (env.ANTHROPIC_API_KEY) {
        try {
            const headers = { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" };
            const r = await httpsGet("https://api.anthropic.com/v1/models", headers);
            const ok = r.status === 200;
            let models: string[] = [];
            try { models = JSON.parse(r.body).data?.map((m: any) => m.id) || []; } catch { }
            let billing: any = { type: "pay-per-token" };
            try {
                const startTs = Math.floor(startOfMonth.getTime() / 1000);
                const ru = await httpsGet(`https://api.anthropic.com/v1/usage?start_time=${startTs}&granularity=month`, headers);
                if (ru.status === 200) {
                    const ud = JSON.parse(ru.body);
                    const entry = (ud.data || [])[0] || {};
                    billing.costThisMonth = entry.total_cost ?? null;
                    billing.inputTokens = entry.input_tokens ?? null;
                    billing.outputTokens = entry.output_tokens ?? null;
                }
            } catch { }
            results.push({ provider: "Anthropic", keyHint: "..." + env.ANTHROPIC_API_KEY.slice(-4), status: ok ? "ok" : "error", httpStatus: r.status, models: models.slice(0, 8), billing, source: "~/.openclaw/.env", envVar: "ANTHROPIC_API_KEY" });
        } catch (e: any) {
            results.push({ provider: "Anthropic", keyHint: "..." + env.ANTHROPIC_API_KEY.slice(-4), status: "error", note: e.message, source: "~/.openclaw/.env", envVar: "ANTHROPIC_API_KEY" });
        }
    }

    // OpenAI
    if (env.OPENAI_API_KEY) {
        try {
            const headers = { "Authorization": "Bearer " + env.OPENAI_API_KEY };
            const r = await httpsGet("https://api.openai.com/v1/models", headers);
            const ok = r.status === 200;
            let models: string[] = [];
            try { models = JSON.parse(r.body).data?.map((m: any) => m.id).filter((id: string) => id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")).slice(0, 8) || []; } catch { }
            let billing: any = { type: "pay-per-token" };
            try {
                const r7 = await httpsGet(`https://api.openai.com/v1/organization/costs?start_time=${Math.floor(sevenDaysAgo.getTime() / 1000)}&bucket_width=1d`, headers);
                if (r7.status === 200) { const d7 = JSON.parse(r7.body); billing.costLast7d = (d7.data || []).reduce((s: number, b: any) => s + (b.results?.[0]?.amount?.value ?? 0), 0); }
                const rm = await httpsGet(`https://api.openai.com/v1/organization/costs?start_time=${Math.floor(startOfMonth.getTime() / 1000)}&bucket_width=1d`, headers);
                if (rm.status === 200) { const dm = JSON.parse(rm.body); billing.costThisMonth = (dm.data || []).reduce((s: number, b: any) => s + (b.results?.[0]?.amount?.value ?? 0), 0); }
                const rl = await httpsGet(`https://api.openai.com/v1/organization/costs?start_time=${Math.floor(startOfLastMonth.getTime() / 1000)}&end_time=${Math.floor(endOfLastMonth.getTime() / 1000)}&bucket_width=1d`, headers);
                if (rl.status === 200) { const dl = JSON.parse(rl.body); billing.costLastMonth = (dl.data || []).reduce((s: number, b: any) => s + (b.results?.[0]?.amount?.value ?? 0), 0); }
            } catch { }
            results.push({ provider: "OpenAI", keyHint: "..." + env.OPENAI_API_KEY.slice(-4), status: ok ? "ok" : "error", httpStatus: r.status, models, billing, source: "~/.openclaw/.env", envVar: "OPENAI_API_KEY" });
        } catch (e: any) {
            results.push({ provider: "OpenAI", keyHint: "..." + env.OPENAI_API_KEY.slice(-4), status: "error", note: e.message, source: "~/.openclaw/.env", envVar: "OPENAI_API_KEY" });
        }
    }

    // Google Gemini
    const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (geminiKey) {
        try {
            const r = await httpsGet(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`, {});
            const ok = r.status === 200;
            let models: string[] = [];
            try { models = JSON.parse(r.body).models?.map((m: any) => m.name?.replace("models/", "")).filter(Boolean).slice(0, 8) || []; } catch { }
            results.push({ provider: "Google", keyHint: "..." + geminiKey.slice(-4), status: ok ? "ok" : "error", httpStatus: r.status, models, billing: { type: "pay-per-token", renewalNote: "No billing API available" }, source: "~/.openclaw/.env", envVar: env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY" });
        } catch (e: any) {
            results.push({ provider: "Google", keyHint: "..." + geminiKey.slice(-4), status: "error", note: e.message, source: "~/.openclaw/.env", envVar: env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY" });
        }
    }

    // Groq
    if (env.GROQ_API_KEY) {
        try {
            const headers = { "Authorization": "Bearer " + env.GROQ_API_KEY };
            const r = await httpsGet("https://api.groq.com/openai/v1/models", headers);
            const ok = r.status === 200;
            let models: string[] = [];
            try { models = JSON.parse(r.body).data?.map((m: any) => m.id).slice(0, 8) || []; } catch { }
            let billing: any = { type: "rate-limited-free", renewalNote: "Rate limits reset daily/minutely" };
            try {
                const ru = await httpsGet(`https://api.groq.com/openai/v1/usage?start_date=${toIso(startOfMonth)}&end_date=${toIso(now)}`, headers);
                if (ru.status === 200) {
                    const ud = JSON.parse(ru.body);
                    billing.inputTokens = ud.prompt_tokens ?? ud.input_tokens ?? null;
                    billing.outputTokens = ud.completion_tokens ?? ud.output_tokens ?? null;
                    billing.totalTokens = ud.total_tokens ?? null;
                }
            } catch { }
            results.push({ provider: "Groq", keyHint: "..." + env.GROQ_API_KEY.slice(-4), status: ok ? "ok" : "error", httpStatus: r.status, models, billing, source: "~/.openclaw/.env", envVar: "GROQ_API_KEY" });
        } catch (e: any) {
            results.push({ provider: "Groq", keyHint: "..." + env.GROQ_API_KEY.slice(-4), status: "error", note: e.message, source: "~/.openclaw/.env", envVar: "GROQ_API_KEY" });
        }
    }

    // Mistral
    if (env.MISTRAL_API_KEY) {
        try {
            const headers = { "Authorization": "Bearer " + env.MISTRAL_API_KEY };
            const r = await httpsGet("https://api.mistral.ai/v1/models", headers);
            const ok = r.status === 200;
            let models: string[] = [];
            try { models = JSON.parse(r.body).data?.map((m: any) => m.id).slice(0, 8) || []; } catch { }
            let billing: any = { type: "pay-per-token" };
            try {
                const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
                const ru = await httpsGet(`https://api.mistral.ai/v1/usage?month=${monthStr}`, headers);
                if (ru.status === 200) {
                    const ud = JSON.parse(ru.body);
                    billing.costThisMonth = ud.total_cost ?? ud.cost ?? null;
                    billing.inputTokens = ud.prompt_tokens ?? null;
                    billing.outputTokens = ud.completion_tokens ?? null;
                }
            } catch { }
            results.push({ provider: "Mistral", keyHint: "..." + env.MISTRAL_API_KEY.slice(-4), status: ok ? "ok" : "error", httpStatus: r.status, models, billing, source: "~/.openclaw/.env", envVar: "MISTRAL_API_KEY" });
        } catch (e: any) {
            results.push({ provider: "Mistral", keyHint: "..." + env.MISTRAL_API_KEY.slice(-4), status: "error", note: e.message, source: "~/.openclaw/.env", envVar: "MISTRAL_API_KEY" });
        }
    }

    // OpenRouter
    if (env.OPENROUTER_API_KEY) {
        try {
            const headers = { "Authorization": "Bearer " + env.OPENROUTER_API_KEY };
            const [rKey, rCredits] = await Promise.all([
                httpsGet("https://openrouter.ai/api/v1/auth/key", headers),
                httpsGet("https://openrouter.ai/api/v1/credits", headers),
            ]);
            const ok = rKey.status === 200;
            let keyInfo: any = {};
            let credInfo: any = {};
            try { keyInfo = JSON.parse(rKey.body).data || {}; } catch { }
            try { credInfo = JSON.parse(rCredits.body) || {}; } catch { }
            const bought = credInfo.total_credits ?? keyInfo.limit ?? null;
            const used = credInfo.total_usage ?? keyInfo.usage ?? null;
            const remaining = (bought != null && used != null) ? bought - used : (keyInfo.limit_remaining ?? null);
            const billing: any = { type: "credits", creditsBought: bought, creditsUsed: used, creditsRemaining: remaining, isFreeTier: keyInfo.is_free_tier ?? false, rateLimit: keyInfo.rate_limit ?? null };
            results.push({ provider: "OpenRouter", keyHint: "..." + env.OPENROUTER_API_KEY.slice(-4), status: ok ? "ok" : "error", httpStatus: rKey.status, models: [], billing, source: "~/.openclaw/.env", envVar: "OPENROUTER_API_KEY" });
        } catch (e: any) {
            results.push({ provider: "OpenRouter", keyHint: "..." + env.OPENROUTER_API_KEY.slice(-4), status: "error", note: e.message, source: "~/.openclaw/.env", envVar: "OPENROUTER_API_KEY" });
        }
    }

    // Scan ALL remaining *_API_KEY / *_KEY entries from .env that weren't already handled
    const handledEnvVars = new Set(results.map((r: any) => r.envVar).filter(Boolean));
    // Google Gemini checks both GEMINI_API_KEY and GOOGLE_API_KEY — mark both as handled
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
        handledEnvVars.add("GEMINI_API_KEY");
        handledEnvVars.add("GOOGLE_API_KEY");
    }
    for (const [envVar, envVal] of Object.entries(env)) {
        if (handledEnvVars.has(envVar)) continue;
        if (!envVar.endsWith("_API_KEY") && !envVar.endsWith("_KEY")) continue;
        if (!envVal || envVal.length < 8) continue;
        const provName = envVar.replace(/_API_KEY$/, "").replace(/_KEY$/, "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
        const keyHint = "..." + envVal.slice(-4);
        const config2 = readConfig();
        const cfgProviders2 = config2.models?.providers || {};
        let matched = false;
        for (const [cpName, cpCfg] of Object.entries(cfgProviders2) as [string, any][]) {
            const cpNorm = cpName.toLowerCase().replace(/[^a-z0-9]/g, "");
            const envNorm = envVar.replace(/_API_KEY$/, "").replace(/_KEY$/, "").toLowerCase().replace(/_/g, "");
            if (cpNorm === envNorm || cpName.toLowerCase().replace(/-/g, "") === envNorm) {
                const cfgKey = (cpCfg as any).apiKey || "";
                if (cfgKey === envVar || env[cfgKey] === envVal) {
                    matched = true;
                    const baseUrl = ((cpCfg as any).baseUrl || "").replace(/\/+$/, "");
                    const models = ((cpCfg as any).models || []).map((m: any) => m.id || m.name || m).filter(Boolean).slice(0, 8);
                    results.push({ provider: cpName, keyHint, status: "ok", models, billing: {}, source: "~/.openclaw/.env", envVar, note: baseUrl ? "via " + baseUrl : undefined });
                    break;
                }
            }
        }
        if (!matched) {
            results.push({ provider: provName, keyHint, status: "ok", models: [], billing: {}, source: "~/.openclaw/.env", envVar, note: "Not referenced by any provider in models.providers" });
        }
    }

    // OAuth / auth-profile connections
    const oauthConnections: any[] = [];

    // Helper: check if a JWT token has a valid (future) expiry
    function _jwtNotExpired(token: string): boolean {
        try {
            const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
            const exp = payload.exp;
            if (!exp) return false;
            return (exp * 1000) > Date.now();
        } catch { return false; }
    }

    // Probe a provider with its stored token to get rate-limit / quota info
    async function probeAuthProfile(provider: string, profile: any): Promise<any> {
        const token = profile.access || profile.access_token || profile.key || null;
        const env2 = readEnv();

        let resolvedKey = token;
        if (!resolvedKey && profile.keyRef) {
            const ref = typeof profile.keyRef === "string" ? profile.keyRef : profile.keyRef?.id;
            if (ref) resolvedKey = env2[ref] || null;
        }
        if (!resolvedKey) return {};

        const prov = (provider || "").toLowerCase().replace(/[^a-z0-9]/g, "");

        // For OAuth tokens on openai/codex/copilot: if the JWT is not expired and
        // a refresh token exists, mark as connected without probing /v1/models
        // (OAuth tokens often can't list models but work fine for chat completions)
        if (profile.type === "oauth" && (prov === "openai" || prov === "openaicopilot" || prov === "openaicodex")) {
            const hasRefresh = !!(profile.refresh || profile.refresh_token);
            if (_jwtNotExpired(resolvedKey) && hasRefresh) {
                return { keyValid: true, note: "OAuth token valid (JWT not expired, refresh available)" };
            }
            // JWT expired but refresh exists — still mark as connected (refresh will handle it)
            if (hasRefresh) {
                return { keyValid: true, note: "OAuth token may be expired but refresh token available" };
            }
        }

        function classifyStatus(r: { status: number; body: string; rawHeaders: Record<string, string> }, quota: any): void {
            quota.httpStatus = r.status;
            quota.keyValid = r.status === 200;
            if (r.status === 429) {
                quota.rateLimited = true;
                quota.error = "Rate limited / usage cap hit (HTTP 429)";
                try {
                    const body = JSON.parse(r.body);
                    const msg = body.error?.message || body.message || "";
                    if (msg) quota.error = msg;
                } catch { }
            } else if (r.status === 401 || r.status === 403) {
                quota.error = "Key/token invalid or revoked (HTTP " + r.status + ")";
            } else if (r.status >= 500) {
                quota.error = "Provider error (HTTP " + r.status + ")";
            }
            const raw = r.rawHeaders || {};
            if (raw["x-ratelimit-limit-tokens"]) quota.rateLimitTokens = Number(raw["x-ratelimit-limit-tokens"]);
            if (raw["x-ratelimit-remaining-tokens"]) quota.remainingTokens = Number(raw["x-ratelimit-remaining-tokens"]);
            if (raw["x-ratelimit-reset-tokens"]) quota.resetsIn = raw["x-ratelimit-reset-tokens"];
            if (raw["x-ratelimit-limit-requests"]) quota.rateLimitRequests = Number(raw["x-ratelimit-limit-requests"]);
            if (raw["x-ratelimit-remaining-requests"]) quota.remainingRequests = Number(raw["x-ratelimit-remaining-requests"]);
            if (raw["retry-after"]) quota.retryAfter = raw["retry-after"];
        }

        try {
            // OpenAI / openai-codex
            if (prov === "openai" || prov === "openaicopilot" || prov === "openaicodex") {
                const isCodex = prov === "openaicodex" || prov === "openaicopilot";
                if (isCodex) {
                    let probeModel = "gpt-4o-mini";
                    const config3 = readConfig();
                    const codexProv = config3.models?.providers?.["openai-codex"];
                    if (codexProv?.models?.length) {
                        const firstModel = codexProv.models[0];
                        probeModel = typeof firstModel === "string" ? firstModel : (firstModel.id || firstModel.name || probeModel);
                    }
                    const probeBody = JSON.stringify({ model: probeModel, messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
                    const r = await new Promise<{ status: number; body: string; rawHeaders: Record<string, string> }>((resolve) => {
                        const opts = {
                            hostname: "api.openai.com", path: "/v1/chat/completions", method: "POST",
                            headers: { "Authorization": "Bearer " + resolvedKey, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(probeBody)) },
                            timeout: 10000,
                        };
                        const hReq = https.request(opts, (hRes) => {
                            let body = ""; const rawHeaders: Record<string, string> = {};
                            const h = hRes.headers as Record<string, string | string[]>;
                            for (const k of Object.keys(h)) { const v = h[k]; rawHeaders[k] = Array.isArray(v) ? v[v.length - 1] : v; }
                            hRes.on("data", (c: any) => body += c);
                            hRes.on("end", () => resolve({ status: hRes.statusCode ?? 0, body, rawHeaders }));
                        });
                        hReq.on("error", () => resolve({ status: 0, body: "", rawHeaders: {} }));
                        hReq.on("timeout", () => { hReq.destroy(); resolve({ status: 0, body: "timeout", rawHeaders: {} }); });
                        hReq.write(probeBody);
                        hReq.end();
                    });
                    const quota: any = {};
                    classifyStatus(r, quota);
                    if ((r.status === 401 || r.status === 403) && (quota.rateLimitTokens || quota.rateLimitRequests)) {
                        quota.keyValid = true;
                        delete quota.error;
                    }
                    if (r.status === 200) {
                        try {
                            const parsed = JSON.parse(r.body);
                            quota.models = [parsed.model || "gpt-4o-mini"];
                        } catch { quota.models = ["gpt-4o-mini"]; }
                    }
                    return quota;
                }
                const r = await httpsGet("https://api.openai.com/v1/models", { "Authorization": "Bearer " + resolvedKey });
                const quota: any = {};
                let models: string[] = [];
                try { models = JSON.parse(r.body).data?.map((m: any) => m.id).filter((id: string) => id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")).slice(0, 15) || []; } catch { }
                classifyStatus(r, quota);
                quota.models = models;
                return quota;
            }

            // Anthropic
            if (prov === "anthropic") {
                const r = await httpsGet("https://api.anthropic.com/v1/models", {
                    "x-api-key": resolvedKey,
                    "anthropic-version": "2023-06-01",
                });
                const quota: any = {};
                let models: string[] = [];
                try { models = JSON.parse(r.body).data?.map((m: any) => m.id).slice(0, 15) || []; } catch { }
                classifyStatus(r, quota);
                quota.models = models;
                return quota;
            }

            // Ollama (local)
            if (prov === "ollama") {
                const ollamaBase = profile.baseUrl || "http://localhost:11434";
                const models: string[] = await new Promise((resolve) => {
                    const hReq = http.get(ollamaBase + "/api/tags", (hRes) => {
                        let body = ""; hRes.on("data", (c: any) => body += c);
                        hRes.on("end", () => {
                            try { resolve(JSON.parse(body).models?.map((m: any) => m.name) || []); } catch { resolve([]); }
                        });
                    });
                    hReq.on("error", () => resolve([]));
                    hReq.setTimeout(4000, () => { hReq.destroy(); resolve([]); });
                });
                return { keyValid: true, localModels: models, modelCount: models.length };
            }

            // Groq
            if (prov === "groq") {
                const r = await httpsGet("https://api.groq.com/openai/v1/models", { "Authorization": "Bearer " + resolvedKey });
                const quota: any = {};
                let models: string[] = [];
                try { models = JSON.parse(r.body).data?.map((m: any) => m.id).slice(0, 15) || []; } catch { }
                classifyStatus(r, quota);
                quota.models = models;
                return quota;
            }

            // Mistral
            if (prov === "mistral") {
                const r = await httpsGet("https://api.mistral.ai/v1/models", { "Authorization": "Bearer " + resolvedKey });
                const quota: any = {};
                let models: string[] = [];
                try { models = JSON.parse(r.body).data?.map((m: any) => m.id).slice(0, 15) || []; } catch { }
                classifyStatus(r, quota);
                quota.models = models;
                return quota;
            }

            // OpenRouter
            if (prov === "openrouter") {
                const r = await httpsGet("https://openrouter.ai/api/v1/auth/key", { "Authorization": "Bearer " + resolvedKey });
                const quota: any = {};
                classifyStatus(r, quota);
                if (r.status === 200) {
                    try {
                        const info = JSON.parse(r.body).data || {};
                        quota.creditsRemaining = info.limit_remaining;
                        quota.creditsUsed = info.usage;
                        quota.isFreeTier = info.is_free_tier;
                    } catch { }
                }
                return quota;
            }

            // Kimi / Moonshot
            if (prov === "kimicoding" || prov === "moonshot" || prov === "kimi") {
                const config = readConfig();
                const cfgProv = config.models?.providers?.["kimi-coding"] || config.models?.providers?.["kimi"] || config.models?.providers?.["moonshot"];
                const baseUrl = cfgProv?.baseUrl?.replace(/\/+$/, "") || "";
                const cfgApi = (cfgProv?.api || "").toLowerCase();
                if (cfgApi.includes("anthropic") && baseUrl && !baseUrl.includes("api.anthropic.com")) {
                    return { keyValid: true, note: "Uses Anthropic-compatible API — cannot probe /models" };
                }
                const probeUrl = baseUrl ? (baseUrl.endsWith("/v1") ? baseUrl + "/models" : baseUrl + "/v1/models") : "https://api.moonshot.cn/v1/models";
                const r = await httpsGet(probeUrl, { "Authorization": "Bearer " + resolvedKey });
                const quota: any = {};
                let models: string[] = [];
                try { models = JSON.parse(r.body).data?.map((m: any) => m.id).slice(0, 15) || []; } catch { }
                classifyStatus(r, quota);
                quota.models = models;
                return quota;
            }

            if (resolvedKey) return { keyValid: true };
        } catch { }
        return {};
    }

    async function parseAuthProfile(profileKey: string, profile: any, source: string): Promise<void> {
        const provider = profile.provider || profileKey.split(":")[0];
        const accountId = profileKey.includes(":") ? profileKey.split(":").slice(1).join(":") : "default";
        const type = profile.type || "unknown";

        let status = "not_connected";
        let expired = false;

        if (type === "oauth") {
            const hasToken = !!(profile.access || profile.access_token);
            if (hasToken) {
                const expiry = profile.expires || profile.expires_at || profile.expiry_date;
                if (expiry) {
                    const n = typeof expiry === "string" ? Date.parse(expiry) : Number(expiry);
                    const ms = n > 1e12 ? n : n * 1000;
                    expired = ms < Date.now();
                }
                status = expired ? "expired" : "connected";
            }
        } else if (type === "api_key") {
            status = (profile.key || profile.keyRef) ? "connected" : "not_connected";
        }

        let account: string | null = null;
        if (profile.access) {
            try {
                const payload = JSON.parse(Buffer.from(profile.access.split(".")[1], "base64").toString());
                account = payload["https://api.openai.com/profile"]?.email || payload.email || payload.sub || null;
            } catch { }
        }

        let quota: any = {};
        if (status === "connected") {
            try { quota = await probeAuthProfile(provider, profile); } catch { }
        }

        oauthConnections.push({
            name: provider,
            profileKey,
            accountId,
            type,
            source,
            status,
            account,
            expiresAt: (type === "oauth") ? (profile.expires || null) : null,
            keyRef: profile.keyRef || null,
            quota,
        });
    }

    // 1. ~/.openclaw/agents/main/agent/auth-profiles.json
    const mainAuthFile = join(AGENTS_STATE_DIR, "main", "agent", "auth-profiles.json");
    if (existsSync(mainAuthFile)) {
        try {
            const raw = JSON.parse(readFileSync(mainAuthFile, "utf-8"));
            const profiles = raw.profiles || raw;
            if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
                for (const [key, val] of Object.entries(profiles)) {
                    if (val && typeof val === "object") {
                        await parseAuthProfile(key, val as any, "agents/main/agent/auth-profiles.json");
                    }
                }
            }
        } catch { }
    }

    // 1b. ~/.openclaw/agents/main/auth-profiles.json (legacy location)
    const mainAuthFileLegacy = join(AGENTS_STATE_DIR, "main", "auth-profiles.json");
    if (existsSync(mainAuthFileLegacy)) {
        try {
            const raw = JSON.parse(readFileSync(mainAuthFileLegacy, "utf-8"));
            const profiles = raw.profiles || raw;
            if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
                const existingKeys = new Set(oauthConnections.map((c: any) => c.profileKey));
                for (const [key, val] of Object.entries(profiles)) {
                    if (val && typeof val === "object" && !existingKeys.has(key)) {
                        await parseAuthProfile(key, val as any, "agents/main/auth-profiles.json");
                    }
                }
            }
        } catch { }
    }

    // 2. ~/.openclaw/credentials/oauth.json
    const globalOAuthFile = join(OPENCLAW_DIR, "credentials", "oauth.json");
    if (existsSync(globalOAuthFile)) {
        try {
            const raw = JSON.parse(readFileSync(globalOAuthFile, "utf-8"));
            const profiles = raw.profiles || raw;
            if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
                for (const [key, val] of Object.entries(profiles)) {
                    if (val && typeof val === "object") {
                        await parseAuthProfile(key, val as any, "credentials/oauth.json");
                    }
                }
            }
        } catch { }
    }

    if (results.length === 0 && oauthConnections.length === 0) {
        return { providers: [], oauth: [], note: "No API keys found in ~/.openclaw/.env and no OAuth connections found" };
    }

    return { providers: results, oauth: oauthConnections };
}

async function buildProviderCache(): Promise<any> {
    if (_providerCacheBuilding) return _providerCache;
    _providerCacheBuilding = true;
    try {
        const result = await _scanAllProviders();
        _providerCache = { ...result, cachedAt: new Date().toISOString() };
    } catch (e: any) {
        console.error("[agent-dashboard] Provider cache build error:", e.message);
    }
    _providerCacheBuilding = false;
    return _providerCache;
}

// Kick off cache build after a short delay (let gateway finish starting)
setTimeout(() => { buildProviderCache(); }, 3000);

// ─── Config I/O ───
let _configError: string | null = null;
function readConfig(): any {
    _configError = null;
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    // Try parsing as-is first (standard JSON)
    try {
        return JSON.parse(raw);
    } catch (e1: any) {
        // Fall back: strip JSON5 comments and trailing commas
        try {
            let cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
            cleaned = cleaned.replace(/,\s*([\]}])/g, "$1");
            return JSON.parse(cleaned);
        } catch (e2: any) {
            // Build a helpful error message with line/column info
            const msg = e1.message || e2.message || "Unknown parse error";
            // Try to extract position from the error
            let detail = msg;
            const posMatch = msg.match(/position\s+(\d+)/i);
            if (posMatch) {
                const pos = parseInt(posMatch[1], 10);
                const before = raw.slice(0, pos);
                const line = (before.match(/\n/g) || []).length + 1;
                const lastNl = before.lastIndexOf("\n");
                const col = pos - lastNl;
                // Extract the offending line and surrounding context
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

function getConfigError(): string | null { return _configError; }

function writeConfig(config: any): void {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// ─── Dashboard extension config (icons, UI prefs — NOT stored in openclaw.json) ───
function readDashboardConfig(): any {
    if (!existsSync(DASHBOARD_CONFIG_PATH)) return {};
    try { return JSON.parse(readFileSync(DASHBOARD_CONFIG_PATH, "utf-8")); } catch { return {}; }
}
function writeDashboardConfig(cfg: any): void {
    if (!existsSync(DASHBOARD_CONFIG_DIR)) mkdirSync(DASHBOARD_CONFIG_DIR, { recursive: true });
    writeFileSync(DASHBOARD_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

function resolveHome(p: string): string {
    if (p.startsWith("~/")) return join(homedir(), p.slice(2));
    return p;
}

// ─── Tool Discovery — scan config + extensions for available tools ───
async function discoverTools(): Promise<any> {
    const config = readConfig();
    const EXTENSIONS_DIR = join(OPENCLAW_DIR, "extensions");

    // 1. Query gateway for actual registered tools (if CLI available)
    const builtinTools: any[] = [];
    try {
        const r = await new Promise<string>((resolve) => {
            exec("openclaw tools list --json", { encoding: "utf-8", timeout: 8000 }, (err, stdout) => {
                resolve((stdout || "[]").trim());
            });
        });
        const toolList = JSON.parse(r);
        if (Array.isArray(toolList)) {
            for (const t of toolList) {
                const id = typeof t === "string" ? t : (t.id || t.name || "");
                if (!id) continue;
                const name = typeof t === "object" ? (t.name || t.id) : t;
                const cat = typeof t === "object" ? (t.category || "system") : "system";
                builtinTools.push({ id, name, category: cat, builtin: true });
            }
        }
    } catch { }

    // 2. Browser tool (from config)
    if (config.browser?.enabled !== false && !builtinTools.some(t => t.id === "browser")) {
        builtinTools.push({ id: "browser", name: "Browser", category: "web", builtin: true });
    }

    // 3. Channel-provided tools (from config.channels)
    const channelTools: any[] = [];
    const channels = config.channels || {};
    for (const chType of Object.keys(channels)) {
        if (channels[chType]?.enabled !== false) {
            channelTools.push({ id: chType, name: chType.charAt(0).toUpperCase() + chType.slice(1), category: "messaging", source: "channel" });
        }
    }

    // 4. Plugin-provided tools — scan installed plugins
    const pluginTools: any[] = [];
    const pluginEntries = config.plugins?.entries || {};
    const pluginInstalls = config.plugins?.installs || {};
    const pluginLoadPaths = config.plugins?.load?.paths || [];

    // Known plugin → tool mappings (plugins register tools with the gateway)
    const knownPluginTools: Record<string, { tools: { id: string; name: string }[]; category: string }> = {};

    // Scan each installed plugin for a package.json that declares openclaw tools
    const allPluginDirs: { name: string; path: string }[] = [];

    // From installs
    for (const [name, info] of Object.entries(pluginInstalls) as [string, any][]) {
        if (info.installPath && existsSync(info.installPath)) {
            allPluginDirs.push({ name, path: info.installPath });
        }
    }

    // From load paths
    for (const lp of pluginLoadPaths) {
        const resolved = resolveHome(lp);
        if (existsSync(resolved)) {
            const pkgPath = join(resolved, "package.json");
            if (existsSync(pkgPath)) {
                try {
                    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
                    const name = pkg.name || resolved.split("/").pop() || "unknown";
                    // Avoid duplicates
                    if (!allPluginDirs.some(d => d.path === resolved)) {
                        allPluginDirs.push({ name, path: resolved });
                    }
                } catch { }
            }
        }
    }

    // Also scan the extensions directory for any plugins not in installs
    if (existsSync(EXTENSIONS_DIR)) {
        try {
            for (const dir of readdirSync(EXTENSIONS_DIR)) {
                const fullPath = join(EXTENSIONS_DIR, dir);
                const pkgPath = join(fullPath, "package.json");
                if (existsSync(pkgPath) && !allPluginDirs.some(d => d.path === fullPath)) {
                    allPluginDirs.push({ name: dir, path: fullPath });
                }
            }
        } catch { }
    }

    for (const { name, path: pluginPath } of allPluginDirs) {
        const pkgPath = join(pluginPath, "package.json");
        if (!existsSync(pkgPath)) continue;

        try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            const ocMeta = pkg.openclaw || pkg.openClaw || {};
            const pluginEnabled = pluginEntries[name]?.enabled !== false;

            // Skip disabled plugins — don't show their tools
            if (!pluginEnabled) continue;

            // Check if plugin declares tools in package.json
            if (ocMeta.tools && Array.isArray(ocMeta.tools)) {
                for (const tool of ocMeta.tools) {
                    const toolId = typeof tool === "string" ? tool : tool.id || tool.name;
                    const toolName = typeof tool === "string" ? tool : (tool.name || tool.id);
                    const toolDesc = typeof tool === "object" ? tool.description : undefined;
                    pluginTools.push({
                        id: toolId,
                        name: toolName,
                        description: toolDesc,
                        category: "plugin",
                        source: name,
                        enabled: pluginEnabled,
                    });
                }
            }

            // Also check for known plugin patterns by name
            if (!ocMeta.tools) {
                const toolsFromName = inferToolsFromPlugin(name, pkg);
                for (const t of toolsFromName) {
                    if (!pluginTools.some(pt => pt.id === t.id)) {
                        pluginTools.push({ ...t, source: name, enabled: pluginEnabled });
                    }
                }
            }
        } catch { }
    }

    // 5. Tools referenced in agent configs but not yet discovered
    const agentReferencedTools = new Set<string>();
    const agentsList = config.agents?.list || [];
    for (const agent of agentsList) {
        const tools = agent.tools || {};
        for (const t of (tools.alsoAllow || tools.allow || [])) {
            agentReferencedTools.add(t);
        }
        for (const t of (tools.deny || [])) {
            agentReferencedTools.add(t);
        }
    }

    // 6. Group tools
    const groupTools: any[] = [
        { id: "group:web", name: "Web Group", category: "group", builtin: true },
        { id: "group:automation", name: "Automation Group", category: "group", builtin: true },
    ];

    // Merge everything
    const allTools = [...builtinTools, ...channelTools, ...pluginTools, ...groupTools];
    const allIds = new Set(allTools.map(t => t.id));

    // Add any agent-referenced tools that weren't discovered
    for (const toolId of agentReferencedTools) {
        if (!allIds.has(toolId)) {
            allTools.push({ id: toolId, name: toolId, category: "unknown", source: "agent-config" });
            allIds.add(toolId);
        }
    }

    // Build profiles — these are gateway-interpreted labels, tool lists are for display only
    const profiles: Record<string, any> = {
        full: {
            label: "Full",
            desc: "Every tool enabled — file system, shell, browser, messaging, memory, and all integrations.",
            tools: allTools.filter(t => t.category !== "group").map(t => t.id),
        },
        coding: {
            label: "Coding",
            desc: "Code-focused tools — file system, shell, browser, git, sessions, memory, and image. No messaging or personal data tools.",
            tools: [],
        },
        minimal: {
            label: "Minimal",
            desc: "Read-only — session status only. No file access, no shell, no messaging.",
            tools: [],
        },
        none: {
            label: "None",
            desc: "No tools at all. Agent can only respond with text based on its context.",
            tools: [],
        },
    };

    return {
        tools: allTools,
        profiles,
        scannedAt: new Date().toISOString(),
        pluginCount: allPluginDirs.length,
        channelCount: Object.keys(channels).length,
    };
}

// Infer tools from well-known plugin names — only used as hints, not authoritative
function inferToolsFromPlugin(name: string, pkg: any): any[] {
    const tools: any[] = [];

    // Only use package.json keywords — no more hardcoded name matching
    const keywords: string[] = pkg.keywords || [];
    for (const kw of keywords) {
        if (kw.startsWith("openclaw-tool:")) {
            const toolId = kw.replace("openclaw-tool:", "");
            if (!tools.some(t => t.id === toolId)) {
                tools.push({ id: toolId, name: toolId, category: "plugin" });
            }
        }
    }

    return tools;
}

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
    // Sanitize key to be filesystem-safe
    const safe = key.replace(/[<>:"/\\|?*]/g, "_");
    return join(DASHBOARD_SESSIONS_DIR, safe + ".json");
}

function readDashboardSession(key: string): any | null {
    const fp = sessionFilePath(key);
    if (!existsSync(fp)) return null;
    try { return JSON.parse(readFileSync(fp, "utf-8")); } catch { return null; }
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

function listDashboardSessions(): any[] {
    ensureSessionsDir();
    const sessions: any[] = [];
    try {
        for (const f of readdirSync(DASHBOARD_SESSIONS_DIR)) {
            if (!f.endsWith(".json")) continue;
            try {
                const raw = readFileSync(join(DASHBOARD_SESSIONS_DIR, f), "utf-8");
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

// Cross-platform async exec helper
function execAsync(cmd: string, opts: any = {}): Promise<string> {
    return new Promise((resolve) => {
        exec(cmd, { encoding: "utf-8", ...opts }, (err: any, stdout: string | Buffer) => {
            resolve(String(stdout || ""));
        });
    });
}

// ─── Helpers ───
function parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk: any) => (body += chunk));
        req.on("end", () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(new Error("Invalid JSON body")); }
        });
        req.on("error", reject);
    });
}

function json(res: ServerResponse, status: number, data: any): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
}

function getAgentWorkspace(agent: any): string {
    if (agent.workspace) return resolveHome(agent.workspace);
    return join(OPENCLAW_DIR, agent.id === "main" ? "workspace" : `workspace-${agent.id}`);
}

function getAgentDir(agent: any): string {
    if (agent.agentDir) return resolveHome(agent.agentDir);
    return join(AGENTS_STATE_DIR, agent.id, "agent");
}

function getAgentSessionsDir(agentId: string): string {
    return join(AGENTS_STATE_DIR, agentId, "sessions");
}

// ─── Enrich agent data from filesystem + config ───
function enrichAgent(agent: any, config: any): any {
    const workspace = getAgentWorkspace(agent);
    const agentDir = getAgentDir(agent);
    const sessionsDir = getAgentSessionsDir(agent.id);

    // Merge dashboard-specific overrides (icons etc.)
    const dashCfg = readDashboardConfig();
    const dashIcon = dashCfg.icons?.[agent.id];

    // List workspace MD files with metadata (no content — stat only for size)
    const mdFiles: Record<string, { exists: true; lines: number; size: number } | null> = {};
    for (const f of WORKSPACE_MD_FILES) {
        const fp = join(workspace, f);
        if (existsSync(fp)) {
            try {
                const st = statSync(fp);
                // Estimate line count from file size (~40 bytes per line avg) to avoid reading content
                mdFiles[f] = { exists: true, lines: Math.max(1, Math.round(st.size / 40)), size: st.size };
            } catch { mdFiles[f] = null; }
        }
    }

    // Also list any extra .md files in workspace
    const extraMdFiles: string[] = [];
    if (existsSync(workspace)) {
        for (const f of readdirSync(workspace)) {
            if (extname(f).toLowerCase() === ".md" && !WORKSPACE_MD_FILES.includes(f)) {
                extraMdFiles.push(f);
                const fp = join(workspace, f);
                try {
                    const st = statSync(fp);
                    mdFiles[f] = { exists: true, lines: Math.max(1, Math.round(st.size / 40)), size: st.size };
                } catch { }
            }
        }
    }

    // Find bindings for this agent
    const bindings = (config.bindings || config.routing?.bindings || [])
        .filter((b: any) => b.agentId === agent.id);

    // Count sessions (from index + loose files)
    let sessionCount = 0;
    if (existsSync(sessionsDir)) {
        try {
            const indexFile = join(sessionsDir, "sessions.json");
            const looseFiles = readdirSync(sessionsDir).filter((f: string) => (f.endsWith(".json") || f.endsWith(".jsonl")) && f !== "sessions.json");
            let indexCount = 0;
            if (existsSync(indexFile)) {
                try { indexCount = Object.keys(JSON.parse(readFileSync(indexFile, "utf-8"))).length; } catch { }
            }
            sessionCount = Math.max(looseFiles.length, indexCount);
        } catch { }
    }

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
function enrichAgentLight(agent: any, config: any, dashCfg: any): any {
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

// ─── Helpers: .env reader ───
function readEnv(): Record<string, string> {
    const envPath = join(OPENCLAW_DIR, ".env");
    if (!existsSync(envPath)) return {};
    const out: Record<string, string> = {};
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#\r\n]*)"?\s*$/);
        if (m) out[m[1]] = m[2].trim();
    }
    return out;
}

function httpsGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string; rawHeaders: Record<string, string> }> {
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

// ─── Log file discovery ───
function _findLogFile(): string | null {
    // Default: /tmp/openclaw/openclaw-YYYY-MM-DD.log
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const candidates = [
        `/tmp/openclaw/openclaw-${dateStr}.log`,
        `/tmp/openclaw/openclaw.log`,
        join(OPENCLAW_DIR, "logs", `openclaw-${dateStr}.log`),
        join(OPENCLAW_DIR, "logs", "openclaw.log"),
        join(OPENCLAW_DIR, "openclaw.log"),
    ];
    for (const f of candidates) {
        if (existsSync(f)) return f;
    }
    // Scan /tmp/openclaw for the most recent log
    const tmpDir = "/tmp/openclaw";
    if (existsSync(tmpDir)) {
        try {
            const files = readdirSync(tmpDir).filter(f => f.endsWith(".log")).sort().reverse();
            if (files.length > 0) return join(tmpDir, files[0]);
        } catch { }
    }
    return null;
}

// ─── Journald log reader (fallback when no log file exists) ───
async function _readJournaldLogs(lines: number, unit?: string): Promise<{ lines: string[]; source: string } | null> {
    const unitName = unit || "openclaw-gateway.service";
    try {
        const out = await execAsync(`journalctl --user -u ${unitName} --no-pager -n ${lines} --output=short-iso 2>/dev/null || journalctl -u ${unitName} --no-pager -n ${lines} --output=short-iso 2>/dev/null`, { timeout: 8000 });
        const result = (out || "").trim();
        if (!result || result.includes("No journal files")) return null;
        return { lines: result.split("\n").filter(Boolean), source: `journald (${unitName})` };
    } catch {
        return null;
    }
}

// ─── Scan all agent session dirs on disk + merge dashboard sessions ───
function scanAllSessions(initialSessions: any[] = []): any[] {
    const sessions: any[] = [...initialSessions];
    const seen = new Set(sessions.map((s: any) => s.sessionKey || s.id));

    if (existsSync(AGENTS_STATE_DIR)) {
        try {
            for (const agentId of readdirSync(AGENTS_STATE_DIR)) {
                const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
                if (!existsSync(sessDir)) continue;

                // Read sessions.json index if it exists
                const indexFile = join(sessDir, "sessions.json");
                if (existsSync(indexFile)) {
                    try {
                        const sessIndex = JSON.parse(readFileSync(indexFile, "utf-8"));
                        for (const [key, val] of Object.entries(sessIndex)) {
                            const meta = val as any;
                            const sid = meta.sessionId || key;
                            if (seen.has(sid) || seen.has(key)) continue;
                            seen.add(sid);
                            seen.add(key);
                            let updatedAt: string | null = meta.updatedAt || meta.lastUpdated || null;
                            let messageCount = 1;
                            for (const ext of [".jsonl", ".json"]) {
                                const fp = join(sessDir, sid + ext);
                                if (existsSync(fp)) {
                                    try {
                                        const st = statSync(fp);
                                        updatedAt = updatedAt || st.mtime.toISOString();
                                        if (ext === ".jsonl") messageCount = Math.max(1, Math.round(st.size / 500));
                                    } catch { }
                                    break;
                                }
                            }
                            sessions.push({
                                sessionKey: sid,
                                agentId: meta.agentId || agentId,
                                channel: meta.channel || meta.channelType || "",
                                messageCount,
                                updatedAt,
                            });
                        }
                    } catch { }
                }

                // Scan loose session files not in the index
                let files: string[] = [];
                try { files = readdirSync(sessDir); } catch { continue; }
                for (const f of files) {
                    if (f === "sessions.json") continue;
                    const isJsonl = f.endsWith(".jsonl");
                    const isJson = f.endsWith(".json");
                    if (!isJson && !isJsonl) continue;
                    const sk = f.replace(/\.(jsonl|json)$/, "");
                    if (seen.has(sk)) continue;
                    seen.add(sk);
                    try {
                        const fp = join(sessDir, f);
                        const st = statSync(fp);
                        let fileAgentId = agentId;
                        let channel = "";
                        if (isJsonl) {
                            try {
                                const head = readFileSync(fp, "utf-8").slice(0, 2000);
                                const firstLine = head.split("\n")[0];
                                if (firstLine) {
                                    const entry = JSON.parse(firstLine);
                                    if (entry.agentId) fileAgentId = entry.agentId;
                                    if (entry.channel) channel = entry.channel;
                                }
                            } catch { }
                        } else {
                            try {
                                const raw = JSON.parse(readFileSync(fp, "utf-8"));
                                if (raw.agentId) fileAgentId = raw.agentId;
                                if (raw.channel || raw.channelType) channel = raw.channel || raw.channelType;
                            } catch { }
                        }
                        sessions.push({
                            sessionKey: sk,
                            agentId: fileAgentId,
                            channel,
                            messageCount: isJsonl ? Math.max(1, Math.round(st.size / 500)) : 1,
                            updatedAt: st.mtime.toISOString(),
                        });
                    } catch { }
                }
            }
        } catch { }
    }

    // Merge dashboard session store
    const dashSess = listDashboardSessions();
    const seenFinal = new Set(sessions.map((s: any) => s.sessionKey || s.id));
    for (const ds of dashSess) {
        if (!seenFinal.has(ds.sessionKey)) sessions.push(ds);
    }

    return sessions;
}

// ─── Main Router ───
export async function handleApiRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method ?? "GET";

    // ─── GET /api/logs — tail the openclaw log file (or journald) ───
    if (path === "/logs" && method === "GET") {
        const lines = parseInt(url.searchParams?.get("lines") || "200", 10);
        const config = readConfig();
        const logFile = config.logging?.file || _findLogFile();

        // Try file-based logs first
        if (logFile && existsSync(logFile)) {
            try {
                const content = readFileSync(logFile, "utf-8");
                const allLines = content.split("\n");
                const tail = allLines.slice(-lines).filter(Boolean);
                return json(res, 200, { lines: tail, logFile, totalLines: allLines.length });
            } catch (e: any) {
                return json(res, 200, { lines: [], logFile, error: e.message });
            }
        }

        // Fallback: try journald
        const journald = await _readJournaldLogs(lines);
        if (journald) {
            return json(res, 200, { lines: journald.lines, logFile: journald.source, totalLines: journald.lines.length });
        }

        return json(res, 200, { lines: [], logFile: logFile || "not found", error: "No log file found and journald not available. If OpenClaw runs as a systemd service, check: journalctl --user -u openclaw-gateway.service -f" });
    }

    // ─── GET /api/logs/stream — SSE stream for live log tailing ───
    if (path === "/logs/stream" && method === "GET") {
        const config = readConfig();
        const logFile = config.logging?.file || _findLogFile();

        // If we have a log file, use file-based streaming
        if (logFile && existsSync(logFile)) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            res.write("data: " + JSON.stringify({ type: "connected", logFile }) + "\n\n");

            let lastSize = 0;
            try { lastSize = statSync(logFile).size; } catch { }

            const onFileChange = () => {
                try {
                    const st = statSync(logFile);
                    if (st.size <= lastSize) { lastSize = st.size; return; }
                    const fd = openSync(logFile, "r");
                    const buf = Buffer.alloc(st.size - lastSize);
                    readSync(fd, buf, 0, buf.length, lastSize);
                    closeSync(fd);
                    lastSize = st.size;
                    const newLines = buf.toString("utf-8").split("\n").filter(Boolean);
                    for (const line of newLines) {
                        res.write("data: " + JSON.stringify({ type: "line", text: line }) + "\n\n");
                    }
                } catch { }
            };

            watchFile(logFile, { interval: 1000 }, onFileChange);
            req.on("close", () => { unwatchFile(logFile, onFileChange); });
            return;
        }

        // Fallback: stream from journald using `journalctl -f`
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });
        res.write("data: " + JSON.stringify({ type: "connected", logFile: "journald (openclaw-gateway.service)" }) + "\n\n");

        const journalProc = exec(
            "journalctl --user -u openclaw-gateway.service -f --no-pager --output=short-iso 2>/dev/null || journalctl -u openclaw-gateway.service -f --no-pager --output=short-iso 2>/dev/null",
            { encoding: "utf-8" }
        );
        let journalBuf = "";
        journalProc.stdout?.on("data", (chunk: string) => {
            journalBuf += chunk;
            const lines = journalBuf.split("\n");
            journalBuf = lines.pop() || ""; // keep incomplete last line in buffer
            for (const line of lines) {
                if (line.trim()) {
                    res.write("data: " + JSON.stringify({ type: "line", text: line }) + "\n\n");
                }
            }
        });
        journalProc.on("error", () => {
            res.write("data: " + JSON.stringify({ type: "line", text: "[dashboard] journalctl not available" }) + "\n\n");
        });
        req.on("close", () => {
            journalProc.kill();
        });
        return;
    }

    // ─── GET /api/debug — check config parsing ───
    if (path === "/debug" && method === "GET") {
        const raw = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf-8").slice(0, 500) : "FILE NOT FOUND";
        const config = readConfig();
        const agentsList = config.agents?.list || [];
        return json(res, 200, {
            configPath: CONFIG_PATH,
            configExists: existsSync(CONFIG_PATH),
            rawPreview: raw,
            agentCount: agentsList.length,
            agentIds: agentsList.map((a: any) => a.id),
            hasAgentsKey: !!config.agents,
            hasListKey: !!config.agents?.list,
            topKeys: Object.keys(config),
        });
    }

    // ─── GET /api/debug/oauth — inspect what OAuth files exist on disk ───
    if (path === "/debug/oauth" && method === "GET") {
        const scan: any = { openclaw_dir: OPENCLAW_DIR, files: {} };
        // Check the two known locations
        const globalOAuthFile = join(OPENCLAW_DIR, "credentials", "oauth.json");
        scan.files["credentials/oauth.json"] = { exists: existsSync(globalOAuthFile) };
        if (existsSync(globalOAuthFile)) {
            try {
                const raw = JSON.parse(readFileSync(globalOAuthFile, "utf-8"));
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
                    const entry: any = { agentId, path: authFile, exists: existsSync(authFile) };
                    if (entry.exists) {
                        try {
                            const raw = JSON.parse(readFileSync(authFile, "utf-8"));
                            entry.keys = Array.isArray(raw) ? raw.map((p: any) => p.name || p.provider || p.id) : Object.keys(raw);
                            entry.is_array = Array.isArray(raw);
                        } catch (e: any) { entry.error = (e as any).message; }
                    }
                    scan.agent_auth_profiles.push(entry);
                }
            } catch { }
        }
        return json(res, 200, scan);
    }


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
        return json(res, 200, result);
    }

    // ─── GET /api/overview — full dashboard data in one call ───
    if (path === "/overview" && method === "GET") {
        const fast = url.searchParams?.get("fast") === "1";
        const config = readConfig();
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
            });
        }

        const enriched = agents.map((a: any) => enrichAgent(a, config));

        // Gateway status + sessions — async to avoid blocking the event loop
        const [gatewayStatus, cliSessions] = await Promise.all([
            execAsync("openclaw status --json", { timeout: 8000 }).then((out) => {
                try { return JSON.parse((out || "{}").trim()); } catch { return {}; }
            }),
            execAsync("openclaw sessions list --json", { timeout: 8000 }).then((out) => {
                try { const p = JSON.parse((out || "[]").trim()); return Array.isArray(p) ? p : []; } catch { return []; }
            }),
        ]);

        // Merge disk sessions using shared helper
        const sessions = scanAllSessions(Array.isArray(cliSessions) ? cliSessions : []);

        return json(res, 200, {
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
    }

    // ─── GET /api/agents/{id} — single agent full detail ───
    const agentDetailMatch = path.match(/^\/agents\/([^/]+)$/);
    if (agentDetailMatch && method === "GET") {
        const agentId = decodeURIComponent(agentDetailMatch[1]);
        const config = readConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main", default: true };
        if (!agent) return json(res, 404, { error: "Agent not found" });
        return json(res, 200, { agent: enrichAgent(agent, config) });
    }

    // ─── PUT /api/agents/{id} — update agent in openclaw.json ───
    const agentUpdateMatch = path.match(/^\/agents\/([^/]+)$/);
    if (agentUpdateMatch && method === "PUT") {
        const agentId = decodeURIComponent(agentUpdateMatch[1]);
        const body = await parseBody(req);

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

        const config = readConfig();
        if (!config.agents) config.agents = {};
        if (!config.agents.list) config.agents.list = [];

        const idx = config.agents.list.findIndex((a: any) => a.id === agentId);
        if (idx >= 0) {
            // Merge updates, preserve id
            config.agents.list[idx] = { ...config.agents.list[idx], ...body, id: agentId };
            // Also strip agentToAgent from merged result in case it existed before
            if (config.agents.list[idx].tools?.agentToAgent) {
                delete config.agents.list[idx].tools.agentToAgent;
            }
            // Handle heartbeat: null means remove heartbeat
            if (body.heartbeat === null) {
                delete config.agents.list[idx].heartbeat;
            }
        } else {
            config.agents.list.push({ ...body, id: agentId });
        }
        writeConfig(config);
        return json(res, 200, { ok: true, agent: config.agents.list.find((a: any) => a.id === agentId) });
    }

    // ─── POST /api/agents — create new agent ───
    if (path === "/agents" && method === "POST") {
        const body = await parseBody(req);
        if (!body.id) return json(res, 400, { error: "id required" });
        const config = readConfig();
        if (!config.agents) config.agents = {};
        if (!config.agents.list) config.agents.list = [];
        if (config.agents.list.some((a: any) => a.id === body.id)) {
            return json(res, 409, { error: "Agent already exists" });
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

        writeConfig(config);
        return json(res, 201, { ok: true, agent: newAgent });
    }

    // ─── DELETE /api/agents/{id} ───
    const agentDeleteMatch = path.match(/^\/agents\/([^/]+)$/);
    if (agentDeleteMatch && method === "DELETE") {
        const agentId = decodeURIComponent(agentDeleteMatch[1]);
        const config = readConfig();
        if (!config.agents?.list) return json(res, 404, { error: "No agents" });
        config.agents.list = config.agents.list.filter((a: any) => a.id !== agentId);
        // Also remove bindings for this agent
        if (config.bindings) {
            config.bindings = config.bindings.filter((b: any) => b.agentId !== agentId);
        }
        if (config.routing?.bindings) {
            config.routing.bindings = config.routing.bindings.filter((b: any) => b.agentId !== agentId);
        }
        writeConfig(config);
        return json(res, 200, { ok: true });
    }

    // ─── MD file read/write ───
    const mdMatch = path.match(/^\/agents\/([^/]+)\/md\/(.+)$/);
    if (mdMatch) {
        const agentId = decodeURIComponent(mdMatch[1]);
        const filename = decodeURIComponent(mdMatch[2]);
        const config = readConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" });

        const workspace = getAgentWorkspace(agent);
        const filePath = join(workspace, filename);
        if (!filePath.startsWith(workspace)) return json(res, 403, { error: "Path traversal" });

        if (method === "GET") {
            if (!existsSync(filePath)) return json(res, 404, { error: "File not found" });
            return json(res, 200, { filename, content: readFileSync(filePath, "utf-8") });
        }
        if (method === "PUT") {
            if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
            const body = await parseBody(req);
            writeFileSync(filePath, body.content ?? "", "utf-8");
            return json(res, 200, { ok: true });
        }
        if (method === "DELETE") {
            if (existsSync(filePath)) unlinkSync(filePath);
            return json(res, 200, { ok: true });
        }
    }

    // ─── Bindings CRUD ───
    if (path === "/bindings" && method === "GET") {
        const config = readConfig();
        return json(res, 200, { bindings: config.bindings || config.routing?.bindings || [] });
    }
    if (path === "/bindings" && method === "PUT") {
        const body = await parseBody(req);
        const config = readConfig();
        config.bindings = body.bindings || [];
        // Clean up old routing key if present
        if (config.routing?.bindings) delete config.routing.bindings;
        writeConfig(config);
        return json(res, 200, { ok: true });
    }

    // ─── Sessions ───
    const sessionMatch = path.match(/^\/sessions(\/(.+))?$/);
    if (sessionMatch) {
        const sub = (sessionMatch[2] ?? "").split("/").filter(Boolean);
        try {
            // GET /sessions — list all sessions
            if (method === "GET" && sub.length === 0) {
                const sessions = scanAllSessions();
                return json(res, 200, { sessions });
            }
            const sessionKey = sub[0];
            const action = sub[1];

            // GET /sessions/{key} — get single session with messages
            if (method === "GET" && sessionKey && !action) {
                // 1. Check dashboard session store first (most likely for dashboard-created sessions)
                let session: any = readDashboardSession(sessionKey);
                // 2. Try CLI (async)
                if (!session) {
                    try {
                        const r = await execAsync(`openclaw sessions get "${sessionKey}" --json`, { timeout: 8000 });
                        try { const p = JSON.parse((r || "{}").trim()); if (p && (p.messages || p.conversation || p.sessionKey)) session = p; } catch { }
                    } catch { }
                }
                // 3. Scan agent state dirs
                if (!session && existsSync(AGENTS_STATE_DIR)) {
                    outer: for (const agentId of readdirSync(AGENTS_STATE_DIR)) {
                        const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
                        if (!existsSync(sessDir)) continue;
                        const indexFile = join(sessDir, "sessions.json");
                        if (existsSync(indexFile)) {
                            try {
                                const idx = JSON.parse(readFileSync(indexFile, "utf-8"));
                                for (const [key, val] of Object.entries(idx)) {
                                    if (key.includes(sessionKey) || sessionKey.includes(key)) {
                                        const sid = (val as any).sessionId;
                                        if (sid) {
                                            const jsonlPath = join(sessDir, sid + ".jsonl");
                                            const jsonPath = join(sessDir, sid + ".json");
                                            if (existsSync(jsonlPath)) {
                                                const parsed = parseSessionJsonl(jsonlPath);
                                                session = { sessionKey, agentId: parsed.agentId || agentId, channel: parsed.channel, messages: parsed.messages, updatedAt: parsed.updatedAt };
                                                break outer;
                                            } else if (existsSync(jsonPath)) {
                                                try { session = JSON.parse(readFileSync(jsonPath, "utf-8")); break outer; } catch { }
                                            }
                                        }
                                    }
                                }
                            } catch { }
                        }
                        for (const f of readdirSync(sessDir)) {
                            const base = f.replace(/\.jsonl?$/, "");
                            if (base === sessionKey) {
                                const fp = join(sessDir, f);
                                if (f.endsWith(".jsonl")) {
                                    const parsed = parseSessionJsonl(fp);
                                    session = { sessionKey, agentId: parsed.agentId || agentId, channel: parsed.channel, messages: parsed.messages, updatedAt: parsed.updatedAt };
                                } else if (f !== "sessions.json") {
                                    try { session = JSON.parse(readFileSync(fp, "utf-8")); } catch { }
                                }
                                break outer;
                            }
                        }
                    }
                }
                return json(res, 200, { session: session || {} });
            }

            // POST /sessions/{key}/message — send a message to an agent
            if (method === "POST" && action === "message") {
                const body = await parseBody(req);
                if (!body.message) return json(res, 400, { error: "message required" });
                const agentId = body.agentId || "";
                const userMessage = body.message;

                // Read or create session in dashboard store
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
                // Add user message
                session.messages.push({ role: "user", content: userMessage });
                session.updatedAt = new Date().toISOString();
                writeDashboardSession(session);

                // Try to get agent response
                let responseText = "";
                let responded = false;

                // Strategy 1: Gateway HTTP API
                try {
                    responseText = await callGatewayChat(agentId, userMessage, sessionKey);
                    responded = true;
                } catch (gwErr: any) {
                    const gwMsg = gwErr?.message || "Gateway unavailable";
                    // Check if this is an auth/limit error — don't fall back to CLI for these
                    const isAuthOrLimit = /usage limit|rate.limit|rate_limit|quota|invalid.*key|invalid.*api|unauthorized|401|403|429|too many requests|failover/i.test(gwMsg);
                    if (isAuthOrLimit) {
                        writeDashboardSession(session);
                        return json(res, 429, {
                            error: gwMsg,
                            errorType: "model_limit",
                            userMessageSaved: true,
                        });
                    }
                    // Strategy 2: CLI fallback (only for connectivity issues)
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
                        // Both failed — store user message anyway, return error
                        writeDashboardSession(session);
                        const cliMsg = cliErr?.message || "CLI unavailable";
                        return json(res, 503, {
                            error: `Could not reach agent. Gateway: ${gwMsg}. CLI: ${cliMsg}. Is the OpenClaw gateway running?`,
                            userMessageSaved: true,
                        });
                    }
                }

                // Store assistant response
                if (responded && responseText) {
                    session.messages.push({ role: "assistant", content: responseText });
                    session.updatedAt = new Date().toISOString();
                    writeDashboardSession(session);
                }

                return json(res, 200, { ok: true, result: responseText, response: responseText });
            }

            // POST /sessions/spawn — create a new session
            if (method === "POST" && (sessionKey === "spawn" || action === "spawn")) {
                const body = await parseBody(req);
                const newKey = body.sessionKey ?? `dashboard-${Date.now()}`;
                const agentId = body.agentId || "";
                // Actually create the session file
                const session = {
                    sessionKey: newKey,
                    agentId,
                    channel: "dashboard",
                    messages: [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                };
                writeDashboardSession(session);
                return json(res, 201, { sessionKey: newKey, ok: true });
            }

            // DELETE /sessions/{key} — terminate a session and clean up all files
            if (method === "DELETE" && sessionKey) {
                let deleted = false;

                // Special: "all:{agentId}" deletes ALL sessions for an agent
                if (sessionKey.startsWith("all:")) {
                    const agentId = sessionKey.slice(4);
                    // Clean dashboard sessions
                    const dashSessions = listDashboardSessions();
                    dashSessions.forEach(s => {
                        if (s.agentId === agentId) { deleteDashboardSession(s.sessionKey); deleted = true; }
                    });
                    // Clean agent session directory
                    const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
                    if (existsSync(sessDir)) {
                        try {
                            for (const f of readdirSync(sessDir)) {
                                try { unlinkSync(join(sessDir, f)); deleted = true; } catch { }
                            }
                        } catch { }
                    }
                    return json(res, 200, { ok: true, deleted, cleanedAll: true });
                }

                // 1. Delete from dashboard store
                deleted = deleteDashboardSession(sessionKey) || deleted;
                // 2. Delete from agent state dirs — clean up ALL matching files
                if (existsSync(AGENTS_STATE_DIR)) {
                    for (const agentId of readdirSync(AGENTS_STATE_DIR)) {
                        const sessDir = join(AGENTS_STATE_DIR, agentId, "sessions");
                        if (!existsSync(sessDir)) continue;
                        // Check sessions.json index
                        const indexFile = join(sessDir, "sessions.json");
                        if (existsSync(indexFile)) {
                            try {
                                const idx = JSON.parse(readFileSync(indexFile, "utf-8"));
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
                        // Direct file match — try multiple patterns
                        for (const ext of [".jsonl", ".json"]) {
                            const fp = join(sessDir, sessionKey + ext);
                            if (existsSync(fp)) { unlinkSync(fp); deleted = true; }
                        }
                        // Also check for files containing the session key in their name
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
                return json(res, 200, { ok: true, deleted });
            }
        } catch (err: any) {
            return json(res, 500, { error: err.message ?? "Session operation failed" });
        }
    }

    // ─── Config read/write ───
    if (path === "/config" && method === "GET") {
        const config = readConfig();
        return json(res, 200, { config, configError: getConfigError() });
    }
    if (path === "/config/raw" && method === "GET") {
        if (!existsSync(CONFIG_PATH)) return json(res, 200, { raw: "{}", configError: null });
        const raw = readFileSync(CONFIG_PATH, "utf-8");
        readConfig(); // trigger parse to populate error
        return json(res, 200, { raw, configError: getConfigError() });
    }
    if (path === "/config" && method === "PUT") {
        const body = await parseBody(req);
        // Support raw text save (for fixing broken JSON)
        if (typeof body.raw === "string") {
            try {
                JSON.parse(body.raw); // validate first
                writeFileSync(CONFIG_PATH, body.raw, "utf-8");
                return json(res, 200, { ok: true });
            } catch (e: any) {
                return json(res, 400, { error: "Invalid JSON: " + e.message });
            }
        }
        if (!body.config) return json(res, 400, { error: "config required" });
        writeConfig(body.config);
        return json(res, 200, { ok: true });
    }
    if (path === "/config/restart" && method === "POST") {
        // Use async exec to avoid blocking the event loop during restart
        try {
            await execAsync("openclaw gateway restart", { timeout: 15000 });
        } catch {
            // Even if the command "fails", the restart may have been initiated
            // (e.g. the process exiting causes execAsync to reject)
        }
        return json(res, 200, { ok: true, warning: "restart signal sent" });
    }

    // ─── POST /api/config/validate — validate config before saving ───
    if (path === "/config/validate" && method === "POST") {
        const body = await parseBody(req);
        if (!body.config) return json(res, 400, { error: "config required" });
        const errors: string[] = [];
        const warnings: string[] = [];
        const cfg = body.config;

        // Structural validation
        if (cfg.agents) {
            if (cfg.agents.list && !Array.isArray(cfg.agents.list)) errors.push("agents.list must be an array");
            if (Array.isArray(cfg.agents.list)) {
                const ids = new Set<string>();
                for (const a of cfg.agents.list) {
                    if (!a.id) errors.push("Every agent in agents.list must have an 'id'");
                    else if (ids.has(a.id)) errors.push(`Duplicate agent id: '${a.id}'`);
                    else ids.add(a.id);
                    if (a.model) {
                        if (a.model.primary && typeof a.model.primary !== "string") errors.push(`Agent '${a.id}': model.primary must be a string`);
                        if (a.model.fallbacks && !Array.isArray(a.model.fallbacks)) errors.push(`Agent '${a.id}': model.fallbacks must be an array`);
                    }
                    if (a.tools?.profile && !["full", "coding", "minimal", "none", "messaging"].includes(a.tools.profile)) {
                        // Only warn for truly unknown profiles — not plugin-registered ones
                        const knownProfiles = ["full", "coding", "minimal", "none", "messaging", "web", "automation", "research", "assistant"];
                        if (!knownProfiles.includes(a.tools.profile)) {
                            warnings.push(`Agent '${a.id}': tools.profile '${a.tools.profile}' is non-standard`);
                        }
                    }
                }
            }
            if (cfg.agents.defaults?.model) {
                if (cfg.agents.defaults.model.primary && typeof cfg.agents.defaults.model.primary !== "string") errors.push("agents.defaults.model.primary must be a string");
            }
        }

        // Channels validation
        if (cfg.channels) {
            for (const [chName, chCfg] of Object.entries(cfg.channels as Record<string, any>)) {
                if (chCfg.accounts) {
                    for (const [accName, accCfg] of Object.entries(chCfg.accounts as Record<string, any>)) {
                        if (chName === "discord" && accName !== "default" && !accCfg.token) {
                            warnings.push(`Channel '${chName}' account '${accName}': missing token`);
                        }
                    }
                }
                if (chCfg.groupPolicy && !["allowlist", "denylist", "open"].includes(chCfg.groupPolicy)) {
                    errors.push(`Channel '${chName}': invalid groupPolicy '${chCfg.groupPolicy}'`);
                }
            }
        }

        // Bindings validation
        if (cfg.bindings) {
            if (!Array.isArray(cfg.bindings)) errors.push("bindings must be an array");
            else {
                const agentIds = new Set((cfg.agents?.list || []).map((a: any) => a.id));
                for (let i = 0; i < cfg.bindings.length; i++) {
                    const b = cfg.bindings[i];
                    if (!b.agentId) errors.push(`bindings[${i}]: missing agentId`);
                    else if (agentIds.size > 0 && !agentIds.has(b.agentId)) warnings.push(`bindings[${i}]: agentId '${b.agentId}' not found in agents.list`);
                    if (!b.match?.channel) warnings.push(`bindings[${i}]: missing match.channel`);
                }
            }
        }

        // Models validation
        if (cfg.models?.providers) {
            for (const [pName, pCfg] of Object.entries(cfg.models.providers as Record<string, any>)) {
                if (!pCfg.baseUrl && !pCfg.api) warnings.push(`models.providers.${pName}: missing baseUrl or api`);
                if (pCfg.models && !Array.isArray(pCfg.models)) errors.push(`models.providers.${pName}: models must be an array`);
            }
        }

        // Gateway validation
        if (cfg.gateway) {
            if (cfg.gateway.port && (typeof cfg.gateway.port !== "number" || cfg.gateway.port < 1 || cfg.gateway.port > 65535)) {
                errors.push("gateway.port must be a number between 1 and 65535");
            }
            if (cfg.gateway.mode && !["local", "remote", "tailscale"].includes(cfg.gateway.mode)) {
                warnings.push(`gateway.mode '${cfg.gateway.mode}' is non-standard`);
            }
        }

        // Try running openclaw config check if available
        let cliValidation: string | null = null;
        try {
            const result = (await execAsync("openclaw config check", { timeout: 10000 })).trim();
            // Only surface meaningful output — suppress "unknown option" or empty results
            if (result && !result.startsWith("error: unknown option")) {
                cliValidation = result;
            }
        } catch { }

        return json(res, 200, { valid: errors.length === 0, errors, warnings, cliValidation });
    }

    // ─── POST /api/agents/{id}/generate-all — generate all workspace MD files from description ───
    const genAllMatch = path.match(/^\/agents\/([^/]+)\/generate-all$/);
    if (genAllMatch && method === "POST") {
        const agentId = decodeURIComponent(genAllMatch[1]);
        const body = await parseBody(req);
        const description = (body.description || "").trim();
        const model = (body.model || "").trim();
        if (!description) return json(res, 400, { error: "description required" });
        const config = readConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" });
        const workspace = getAgentWorkspace(agent);
        if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
        const modelFlag = model ? ` --model "${model}"` : "";
        const results: Record<string, string> = {};
        const filesToGenerate = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md", "BOOTSTRAP.md"];
        const fileDescriptions: Record<string, string> = {
            "SOUL.md": "the agent's core personality, values, communication style, and behavioural guidelines",
            "IDENTITY.md": "the agent's name, role, purpose, and how it introduces itself",
            "AGENTS.md": "instructions about how this agent coordinates with other agents and its place in the system",
            "TOOLS.md": "guidelines for how this agent should use its available tools",
            "BOOTSTRAP.md": "startup instructions and initial context the agent needs when a session begins",
        };
        // Generate files sequentially using async exec to avoid blocking the event loop
        for (const filename of filesToGenerate) {
            const desc = fileDescriptions[filename] || filename;
            const prompt = `You are writing ${filename} for an AI agent. This file contains ${desc}. Based on the agent description below, write a complete, well-structured markdown file. Output ONLY the markdown content, no preamble or explanation.\n\nAgent description:\n${description}`;
            const escaped = prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
            try {
                let result = await execAsync(`openclaw agent --message "${escaped}"${modelFlag} --no-session`, { timeout: 120000 });
                if (!result.trim()) {
                    // Fallback: try without --no-session
                    result = await execAsync(`openclaw agent --message "${escaped}"${modelFlag}`, { timeout: 120000 });
                }
                const content = result.trim();
                writeFileSync(join(workspace, filename), content, "utf-8");
                results[filename] = "ok";
            } catch (err: any) {
                results[filename] = "error: " + err.message;
            }
        }
        return json(res, 200, { ok: true, results });
    }

    // ─── POST /api/agents/{id}/md/{file}/generate — generate MD from notes via model ───
    const mdGenMatch = path.match(/^\/agents\/([^/]+)\/md\/(.+)\/generate$/);
    if (mdGenMatch && method === "POST") {
        const agentId = decodeURIComponent(mdGenMatch[1]);
        const filename = decodeURIComponent(mdGenMatch[2]);
        const body = await parseBody(req);
        const notes = (body.notes || "").trim();
        const model = (body.model || "").trim();
        if (!notes) return json(res, 400, { error: "notes required" });
        const config = readConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" });
        const workspace = getAgentWorkspace(agent);
        const filePath = join(workspace, filename);
        if (!filePath.startsWith(workspace)) return json(res, 403, { error: "Path traversal" });
        // Build prompt and call openclaw agent (async to avoid blocking event loop)
        const prompt = `You are generating a ${filename} file for an AI agent. Based on the following notes, write a complete, well-structured markdown file. Output ONLY the markdown content, no preamble.\n\nNotes:\n${notes}`;
        const escaped = prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
        const modelFlag = model ? ` --model "${model}"` : "";
        try {
            let result = await execAsync(`openclaw agent --message "${escaped}"${modelFlag} --no-session`, { timeout: 120000 });
            if (!result.trim()) {
                // Fallback: try without --no-session
                result = await execAsync(`openclaw agent --message "${escaped}"${modelFlag}`, { timeout: 120000 });
            }
            const content = result.trim();
            if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
            writeFileSync(filePath, content, "utf-8");
            return json(res, 200, { ok: true, content });
        } catch (err: any) {
            return json(res, 500, { error: err.message });
        }
    }

    // ─── DELETE /api/channels/{name} — remove a channel from config ───
    const chDeleteMatch = path.match(/^\/channels\/([^/]+)$/);
    if (chDeleteMatch && method === "DELETE") {
        const chName = decodeURIComponent(chDeleteMatch[1]);
        const config = readConfig();
        if (config.channels && config.channels[chName]) {
            delete config.channels[chName];
            writeConfig(config);
        }
        return json(res, 200, { ok: true });
    }

    // ─── PUT /api/channels/{name} — enable/disable a channel ───
    if (chDeleteMatch && method === "PUT") {
        const chName = decodeURIComponent(chDeleteMatch[1]);
        const body = await parseBody(req);
        const config = readConfig();
        if (!config.channels) config.channels = {};
        if (!config.channels[chName]) config.channels[chName] = {};
        Object.assign(config.channels[chName], body);
        writeConfig(config);
        return json(res, 200, { ok: true });
    }

    // ─── GET /api/tasks — list user-defined recurring tasks + heartbeats separately ───
    if (path === "/tasks" && method === "GET") {
        const config = readConfig();
        const agents = config.agents?.list || [];

        // User-defined tasks from config.tasks array
        const userTasks: any[] = (config.tasks || []).map((t: any) => ({
            ...t,
            source: "config",
            status: t.enabled === false ? "disabled" : "active",
        }));

        // Try CLI for runtime tasks (async to avoid blocking event loop)
        try {
            const r = await execAsync("openclaw tasks list --json", { timeout: 8000 });
            try {
                const cli: any[] = JSON.parse((r || "[]").trim());
                cli.filter((t: any) => t.type !== "heartbeat").forEach((t: any) => {
                    const exists = userTasks.some(x => x.id === t.id);
                    if (!exists) userTasks.push({ ...t, source: "runtime" });
                    else {
                        const ex = userTasks.find(x => x.id === t.id);
                        if (ex) Object.assign(ex, { status: t.status || ex.status, lastRun: t.lastRun, nextRun: t.nextRun });
                    }
                });
            } catch { }
        } catch { }

        // Heartbeats — separate informational list, not in calendar
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

        return json(res, 200, { tasks: userTasks, heartbeats });
    }

    // ─── POST /api/tasks — create a user-defined task ───
    if (path === "/tasks" && method === "POST") {
        const body = await parseBody(req);
        if (!body.name || !body.interval) return json(res, 400, { error: "name and interval required" });
        const config = readConfig();
        if (!config.tasks) config.tasks = [];
        const newTask = {
            id: `task-${Date.now()}`,
            name: body.name,
            description: body.description || "",
            interval: body.interval,
            agentId: body.agentId || null,
            prompt: body.prompt || "",
            enabled: true,
            createdAt: new Date().toISOString(),
        };
        config.tasks.push(newTask);
        writeConfig(config);
        return json(res, 201, { ok: true, task: newTask });
    }

    // ─── DELETE /api/tasks/{id} ───
    if (path.match(/^\/tasks\/[^/]+$/) && method === "DELETE") {
        const taskId = decodeURIComponent(path.split("/").pop()!);
        const config = readConfig();
        if (config.tasks) {
            config.tasks = config.tasks.filter((t: any) => t.id !== taskId);
            writeConfig(config);
        }
        // Fire-and-forget async cancel — don't block the response
        execAsync(`openclaw tasks cancel "${taskId}"`, { timeout: 8000 }).catch(() => { });
        return json(res, 200, { ok: true });
    }

    // ─── POST /api/tasks/{id}/cancel ───
    const taskCancelMatch = path.match(/^\/tasks\/(.+)\/cancel$/);
    if (taskCancelMatch && method === "POST") {
        const taskId = decodeURIComponent(taskCancelMatch[1]);
        const config = readConfig();
        // Disable in config
        if (config.tasks) {
            const t = config.tasks.find((t: any) => t.id === taskId);
            if (t) { t.enabled = false; writeConfig(config); }
        }
        // Heartbeat disable
        const hbMatch = taskId.match(/^heartbeat:(.+)$/);
        if (hbMatch) {
            const agentId = hbMatch[1];
            const agent = (config.agents?.list || []).find((a: any) => a.id === agentId);
            if (agent?.heartbeat) { agent.heartbeat.enabled = false; writeConfig(config); }
        }
        // Fire-and-forget async cancel — don't block the response
        execAsync(`openclaw tasks cancel "${taskId}"`, { timeout: 8000 }).catch(() => { });
        return json(res, 200, { ok: true });
    }

    // ─── GET /api/models/status — query provider APIs for quota/usage ───
    if (path === "/models/status" && method === "GET") {
        // Serve from cache if available; kick off background build if not
        if (!_providerCache) {
            if (!_providerCacheBuilding) {
                buildProviderCache(); // fire-and-forget, don't await
            }
            return json(res, 200, { providers: [], oauth: [], note: "Provider scan in progress — refresh in a few seconds", building: true });
        }
        if (_providerCache) {
            return json(res, 200, _providerCache);
        }
        return json(res, 200, { providers: [], oauth: [], note: "Provider cache not yet built" });
    }

    // ─── POST /api/models/status/refresh — force rebuild the provider cache ───
    if (path === "/models/status/refresh" && method === "POST") {
        _providerCache = null;
        await buildProviderCache();
        return json(res, 200, _providerCache || { providers: [], oauth: [] });
    }

    // ─── GET/PUT /api/dashboard/icons — manage agent icons in extension config ───
    if (path === "/dashboard/icons" && method === "GET") {
        const dashCfg = readDashboardConfig();
        return json(res, 200, { icons: dashCfg.icons || {} });
    }
    if (path === "/dashboard/icons" && method === "PUT") {
        const body = await parseBody(req);
        const dashCfg = readDashboardConfig();
        if (!dashCfg.icons) dashCfg.icons = {};
        if (body.agentId && body.icon) {
            dashCfg.icons[body.agentId] = body.icon;
        } else if (body.agentId && body.icon === null) {
            delete dashCfg.icons[body.agentId];
        }
        writeDashboardConfig(dashCfg);
        return json(res, 200, { ok: true, icons: dashCfg.icons });
    }

    // ─── DELETE /api/auth/profile — remove an auth profile entry from ALL locations ───
    if (path === "/auth/profile" && method === "DELETE") {
        const body = await parseBody(req);
        const profileKey = body.profileKey;
        const source = body.source || "";
        if (!profileKey) return json(res, 400, { error: "profileKey required" });

        let deleted = false;
        const deletedFrom: string[] = [];

        // Build list of ALL auth-profiles.json files to check
        const authFiles: string[] = [
            join(AGENTS_STATE_DIR, "main", "agent", "auth-profiles.json"),
            join(AGENTS_STATE_DIR, "main", "auth-profiles.json"),
            join(OPENCLAW_DIR, "credentials", "oauth.json"),
        ];
        // Also scan all other agent auth-profiles
        if (existsSync(AGENTS_STATE_DIR)) {
            try {
                for (const agentDir of readdirSync(AGENTS_STATE_DIR)) {
                    const agentAuthFile = join(AGENTS_STATE_DIR, agentDir, "agent", "auth-profiles.json");
                    if (!authFiles.includes(agentAuthFile) && existsSync(agentAuthFile)) {
                        authFiles.push(agentAuthFile);
                    }
                }
            } catch { }
        }

        // Remove from all auth-profiles files
        for (const authFile of authFiles) {
            if (!existsSync(authFile)) continue;
            try {
                const raw = JSON.parse(readFileSync(authFile, "utf-8"));
                const profiles = raw.profiles || raw;
                if (profiles && typeof profiles === "object" && !Array.isArray(profiles) && profiles[profileKey]) {
                    delete profiles[profileKey];
                    if (raw.profiles) {
                        raw.profiles = profiles;
                        writeFileSync(authFile, JSON.stringify(raw, null, 2), "utf-8");
                    } else {
                        writeFileSync(authFile, JSON.stringify(profiles, null, 2), "utf-8");
                    }
                    deleted = true;
                    deletedFrom.push(authFile.replace(OPENCLAW_DIR, "~/.openclaw"));
                }
            } catch { }
        }

        // Also remove from openclaw.json auth.profiles
        try {
            const config = readConfig();
            if (config.auth?.profiles?.[profileKey]) {
                delete config.auth.profiles[profileKey];
                writeConfig(config);
                deleted = true;
                deletedFrom.push("openclaw.json (auth.profiles)");
            }
        } catch { }

        // Invalidate the provider cache and rebuild in background
        _providerCache = null;
        setTimeout(() => { buildProviderCache(); }, 100);

        return json(res, 200, { ok: true, deleted, deletedFrom });
    }

    // ─── POST /api/auth/refresh — refresh an OAuth token via CLI ───
    if (path === "/auth/refresh" && method === "POST") {
        const body = await parseBody(req);
        const profileKey = body.profileKey || "";
        const provider = body.provider || "";

        // Try openclaw auth refresh command
        let result = "";
        let success = false;
        try {
            const provFlag = provider ? ` --provider "${provider}"` : "";
            const profileFlag = profileKey ? ` --profile "${profileKey}"` : "";
            result = await execAsync(`openclaw auth refresh${provFlag}${profileFlag}`, { timeout: 30000 });
            success = true;
        } catch (e: any) {
            // Try alternative commands
            try {
                result = await execAsync(`openclaw auth login --provider "${provider || profileKey.split(":")[0]}"`, { timeout: 30000 });
                success = true;
            } catch (e2: any) {
                result = (e.message || "") + "\n" + (e2.message || "");
            }
        }

        return json(res, success ? 200 : 500, { ok: success, result: result.trim(), note: success ? "Token refresh initiated. Check the API Status page to verify." : "Could not refresh token. You may need to run 'openclaw auth login' manually on the server." });
    }

    // ─── GET /api/auth/reveal — reveal the full API key for a given env var ───
    if (path === "/auth/reveal" && method === "POST") {
        const body = await parseBody(req);
        const envVar = body.envVar || "";
        const profileKey = body.profileKey || "";
        const source = body.source || "";

        if (envVar) {
            const env = readEnv();
            const val = env[envVar];
            if (val) return json(res, 200, { key: val });
            return json(res, 404, { error: "Key not found in .env" });
        }

        if (profileKey) {
            // Look up the token from auth-profiles
            const authFiles = [
                join(AGENTS_STATE_DIR, "main", "agent", "auth-profiles.json"),
                join(AGENTS_STATE_DIR, "main", "auth-profiles.json"),
                join(OPENCLAW_DIR, "credentials", "oauth.json"),
            ];
            for (const f of authFiles) {
                if (!existsSync(f)) continue;
                try {
                    const raw = JSON.parse(readFileSync(f, "utf-8"));
                    const profiles = raw.profiles || raw;
                    if (profiles?.[profileKey]) {
                        const p = profiles[profileKey];
                        const token = p.access || p.access_token || p.key || "";
                        return json(res, 200, { key: token });
                    }
                } catch { }
            }
            return json(res, 404, { error: "Profile not found" });
        }

        return json(res, 400, { error: "envVar or profileKey required" });
    }

    // ─── DELETE /api/auth/envkey — remove an API key from .env ───
    if (path === "/auth/envkey" && method === "DELETE") {
        const body = await parseBody(req);
        const envVar = body.envVar || "";
        if (!envVar || !/^[A-Z0-9_]+$/.test(envVar)) return json(res, 400, { error: "Invalid env var name" });

        const envPath = join(OPENCLAW_DIR, ".env");
        if (!existsSync(envPath)) return json(res, 404, { error: ".env file not found" });

        try {
            const content = readFileSync(envPath, "utf-8");
            const lines = content.split("\n");
            const filtered = lines.filter(line => {
                const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
                return !(m && m[1] === envVar);
            });
            writeFileSync(envPath, filtered.join("\n"), "utf-8");
            return json(res, 200, { ok: true });
        } catch (e: any) {
            return json(res, 500, { error: e.message });
        }
    }

    // ─── POST /api/auth/envkey — add or update an API key in .env ───
    if (path === "/auth/envkey" && method === "POST") {
        const body = await parseBody(req);
        const envVar = (body.envVar || "").trim();
        const value = (body.value || "").trim();
        if (!envVar || !/^[A-Z0-9_]+$/.test(envVar)) return json(res, 400, { error: "Invalid env var name. Use uppercase with underscores, e.g. ANTHROPIC_API_KEY" });
        if (!value) return json(res, 400, { error: "Value is required" });

        const envPath = join(OPENCLAW_DIR, ".env");
        try {
            let content = "";
            if (existsSync(envPath)) {
                content = readFileSync(envPath, "utf-8");
            }
            // Check if the key already exists — update it
            const lines = content.split("\n");
            let found = false;
            for (let i = 0; i < lines.length; i++) {
                const m = lines[i].match(/^\s*([A-Z0-9_]+)\s*=/);
                if (m && m[1] === envVar) {
                    lines[i] = `${envVar}="${value}"`;
                    found = true;
                    break;
                }
            }
            if (!found) {
                // Append to end (ensure trailing newline)
                if (content.length > 0 && !content.endsWith("\n")) lines.push("");
                lines.push(`${envVar}="${value}"`);
            }
            writeFileSync(envPath, lines.join("\n"), "utf-8");
            return json(res, 200, { ok: true, updated: found });
        } catch (e: any) {
            return json(res, 500, { error: e.message });
        }
    }

    // ─── GET /api/tools/discover — return cached tool registry (or scan if missing) ───
    if (path === "/tools/discover" && method === "GET") {
        const dashCfg = readDashboardConfig();
        if (dashCfg.toolRegistry && dashCfg.toolRegistry.tools) {
            return json(res, 200, dashCfg.toolRegistry);
        }
        // No cache — do a fresh scan
        const registry = await discoverTools();
        const dashCfg2 = readDashboardConfig();
        dashCfg2.toolRegistry = registry;
        writeDashboardConfig(dashCfg2);
        return json(res, 200, registry);
    }

    // ─── POST /api/tools/discover — force refresh tool registry ───
    if (path === "/tools/discover" && method === "POST") {
        const registry = await discoverTools();
        const dashCfg = readDashboardConfig();
        dashCfg.toolRegistry = registry;
        writeDashboardConfig(dashCfg);
        return json(res, 200, registry);
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
            // Skip non-standard APIs that don't have a /models endpoint (e.g. anthropic-messages on custom hosts)
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
            if (!existsSync(authFile)) continue;
            try {
                const raw = JSON.parse(readFileSync(authFile, "utf-8"));
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
                        // For OAuth with valid JWT + refresh token, skip probing (OAuth tokens often can't list models but work for chat)
                        const hasRefresh = !!(profile.refresh || profile.refresh_token);
                        if (token && hasRefresh) {
                            try {
                                const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
                                if (payload.exp && (payload.exp * 1000) > Date.now()) continue; // JWT valid, skip probe
                            } catch { }
                            // Even if JWT decode fails, if refresh exists, don't flag as invalid
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
        return json(res, 200, { ok: gatewayOk && issues.length === 0, gateway: gatewayOk ? "ok" : "error", issues, checkedAt: new Date().toISOString() });
    }

    return json(res, 404, { error: "Not found" });
}
