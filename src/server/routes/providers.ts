import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    readConfig,
    readEnv,
    httpsGet,
    OPENCLAW_DIR,
    AGENTS_STATE_DIR,
} from "../api-utils.js";

// ─── Provider status cache — stale-while-revalidate with build deduplication ───
let _providerCache: any = null;
let _providerCachedAt: number = 0;               // Date.now() when cache was last built
let _providerBuildPromise: Promise<any> | null = null; // in-flight build for deduplication
let _providerTimeoutId: ReturnType<typeof setTimeout> | null = null;

/** Default cache TTL in milliseconds (5 minutes). */
const PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;

/** Returns true when the cache exists but is older than the TTL. */
function _isCacheStale(): boolean {
    return _providerCachedAt > 0 && (Date.now() - _providerCachedAt) > PROVIDER_CACHE_TTL_MS;
}

/** Return the current provider cache (may be null if not yet built). */
export function getProviderCache(): any {
    return _providerCache;
}

/** Invalidate the provider cache and trigger a background rebuild after a short delay. */
export function invalidateProviderCache(): void {
    _providerCache = null;
    _providerCachedAt = 0;
    setTimeout(() => { buildProviderCache(); }, 100);
}

// ─── Parameterized provider scanner ───

/** Configuration for a single provider scan. */
export interface ProviderScanConfig {
    name: string;
    envVar: string;
    modelsUrl: string | ((key: string) => string);
    headers: (key: string) => Record<string, string>;
    parseModels?: (body: string) => string[];
    billingFetcher?: (key: string, headers: Record<string, string>, dates: ProviderScanDates) => Promise<any>;
}

/** Date helpers passed to billing fetchers. */
interface ProviderScanDates {
    now: Date;
    startOfMonth: Date;
    startOfLastMonth: Date;
    endOfLastMonth: Date;
    sevenDaysAgo: Date;
    toIso: (d: Date) => string;
}

/** Default model parser: extracts `.data[].id` and takes first 8. */
function defaultParseModels(body: string): string[] {
    try { return JSON.parse(body).data?.map((m: any) => m.id)?.slice(0, 8) || []; } catch { return []; }
}

/**
 * Generic provider scanner. Replaces the 6 near-identical scanXxx() functions.
 * Returns a provider result object or null if the env var is not set.
 */
async function scanProvider(config: ProviderScanConfig, env: Record<string, string>, dates: ProviderScanDates): Promise<any | null> {
    const key = env[config.envVar];
    if (!key) return null;

    const parse = config.parseModels ?? defaultParseModels;
    const hdrs = config.headers(key);
    const modelsUrl = typeof config.modelsUrl === "function" ? config.modelsUrl(key) : config.modelsUrl;

    try {
        const r = await httpsGet(modelsUrl, hdrs);
        const ok = r.status === 200;
        const models = parse(r.body);

        let billing: any = { type: "pay-per-token" };
        if (config.billingFetcher) {
            try { billing = await config.billingFetcher(key, hdrs, dates); } catch { }
        }

        return {
            provider: config.name,
            keyHint: "..." + key.slice(-4),
            status: ok ? "ok" : "error",
            httpStatus: r.status,
            models,
            billing,
            source: "~/.openclaw/.env",
            envVar: config.envVar,
        };
    } catch (e: any) {
        return {
            provider: config.name,
            keyHint: "..." + key.slice(-4),
            status: "error",
            note: e.message,
            source: "~/.openclaw/.env",
            envVar: config.envVar,
        };
    }
}

// ─── Per-provider configurations ───

const ANTHROPIC_CONFIG: ProviderScanConfig = {
    name: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    modelsUrl: "https://api.anthropic.com/v1/models",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }),
    parseModels: (body) => {
        try { return JSON.parse(body).data?.map((m: any) => m.id)?.slice(0, 8) || []; } catch { return []; }
    },
    billingFetcher: async (key, hdrs, dates) => {
        const billing: any = { type: "pay-per-token" };
        try {
            const startTs = Math.floor(dates.startOfMonth.getTime() / 1000);
            const ru = await httpsGet(`https://api.anthropic.com/v1/usage?start_time=${startTs}&granularity=month`, hdrs);
            if (ru.status === 200) {
                const ud = JSON.parse(ru.body);
                const entry = (ud.data || [])[0] || {};
                billing.costThisMonth = entry.total_cost ?? null;
                billing.inputTokens = entry.input_tokens ?? null;
                billing.outputTokens = entry.output_tokens ?? null;
            }
        } catch { }
        return billing;
    },
};

const OPENAI_CONFIG: ProviderScanConfig = {
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    modelsUrl: "https://api.openai.com/v1/models",
    headers: (key) => ({ "Authorization": "Bearer " + key }),
    parseModels: (body) => {
        try {
            return JSON.parse(body).data?.map((m: any) => m.id)
                .filter((id: string) => id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4"))
                .slice(0, 8) || [];
        } catch { return []; }
    },
    billingFetcher: async (key, hdrs, dates) => {
        const billing: any = { type: "pay-per-token" };
        try {
            const r7 = await httpsGet(`https://api.openai.com/v1/organization/costs?start_time=${Math.floor(dates.sevenDaysAgo.getTime() / 1000)}&bucket_width=1d`, hdrs);
            if (r7.status === 200) { const d7 = JSON.parse(r7.body); billing.costLast7d = (d7.data || []).reduce((s: number, b: any) => s + (b.results?.[0]?.amount?.value ?? 0), 0); }
            const rm = await httpsGet(`https://api.openai.com/v1/organization/costs?start_time=${Math.floor(dates.startOfMonth.getTime() / 1000)}&bucket_width=1d`, hdrs);
            if (rm.status === 200) { const dm = JSON.parse(rm.body); billing.costThisMonth = (dm.data || []).reduce((s: number, b: any) => s + (b.results?.[0]?.amount?.value ?? 0), 0); }
            const rl = await httpsGet(`https://api.openai.com/v1/organization/costs?start_time=${Math.floor(dates.startOfLastMonth.getTime() / 1000)}&end_time=${Math.floor(dates.endOfLastMonth.getTime() / 1000)}&bucket_width=1d`, hdrs);
            if (rl.status === 200) { const dl = JSON.parse(rl.body); billing.costLastMonth = (dl.data || []).reduce((s: number, b: any) => s + (b.results?.[0]?.amount?.value ?? 0), 0); }
        } catch { }
        return billing;
    },
};

const GOOGLE_CONFIG: ProviderScanConfig = {
    name: "Google",
    envVar: "GEMINI_API_KEY",
    modelsUrl: (key) => `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
    headers: () => ({}),
    parseModels: (body) => {
        try { return JSON.parse(body).models?.map((m: any) => m.name?.replace("models/", "")).filter(Boolean).slice(0, 8) || []; } catch { return []; }
    },
};

const GROQ_CONFIG: ProviderScanConfig = {
    name: "Groq",
    envVar: "GROQ_API_KEY",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    headers: (key) => ({ "Authorization": "Bearer " + key }),
    billingFetcher: async (key, hdrs, dates) => {
        const billing: any = { type: "rate-limited-free", renewalNote: "Rate limits reset daily/minutely" };
        try {
            const ru = await httpsGet(`https://api.groq.com/openai/v1/usage?start_date=${dates.toIso(dates.startOfMonth)}&end_date=${dates.toIso(dates.now)}`, hdrs);
            if (ru.status === 200) {
                const ud = JSON.parse(ru.body);
                billing.inputTokens = ud.prompt_tokens ?? ud.input_tokens ?? null;
                billing.outputTokens = ud.completion_tokens ?? ud.output_tokens ?? null;
                billing.totalTokens = ud.total_tokens ?? null;
            }
        } catch { }
        return billing;
    },
};

const MISTRAL_CONFIG: ProviderScanConfig = {
    name: "Mistral",
    envVar: "MISTRAL_API_KEY",
    modelsUrl: "https://api.mistral.ai/v1/models",
    headers: (key) => ({ "Authorization": "Bearer " + key }),
    billingFetcher: async (_key, hdrs, dates) => {
        const billing: any = { type: "pay-per-token" };
        try {
            const monthStr = `${dates.now.getFullYear()}-${String(dates.now.getMonth() + 1).padStart(2, "0")}`;
            const ru = await httpsGet(`https://api.mistral.ai/v1/usage?month=${monthStr}`, hdrs);
            if (ru.status === 200) {
                const ud = JSON.parse(ru.body);
                billing.costThisMonth = ud.total_cost ?? ud.cost ?? null;
                billing.inputTokens = ud.prompt_tokens ?? null;
                billing.outputTokens = ud.completion_tokens ?? null;
            }
        } catch { }
        return billing;
    },
};

/**
 * OpenRouter is special: it uses auth/key + credits endpoints instead of a models list.
 * We keep it as a standalone scan function since its shape differs from the standard pattern.
 */
async function scanOpenRouter(env: Record<string, string>): Promise<any | null> {
    if (!env.OPENROUTER_API_KEY) return null;
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
        return { provider: "OpenRouter", keyHint: "..." + env.OPENROUTER_API_KEY.slice(-4), status: ok ? "ok" : "error", httpStatus: rKey.status, models: [], billing, source: "~/.openclaw/.env", envVar: "OPENROUTER_API_KEY" };
    } catch (e: any) {
        return { provider: "OpenRouter", keyHint: "..." + env.OPENROUTER_API_KEY.slice(-4), status: "error", note: e.message, source: "~/.openclaw/.env", envVar: "OPENROUTER_API_KEY" };
    }
}

/**
 * Google has a special case: it checks GEMINI_API_KEY first, then falls back to GOOGLE_API_KEY.
 * We wrap the parameterized scanner to handle this fallback + correct envVar reporting.
 */
async function scanGoogle(env: Record<string, string>, dates: ProviderScanDates): Promise<any | null> {
    const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (!geminiKey) return null;

    // Build a temporary env with the resolved key under GEMINI_API_KEY for the generic scanner
    const envWithKey = { ...env, GEMINI_API_KEY: geminiKey };
    const result = await scanProvider(GOOGLE_CONFIG, envWithKey, dates);
    if (result) {
        // Fix the envVar to reflect which key was actually used
        result.envVar = env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY";
        // Google has no billing API
        result.billing = { type: "pay-per-token", renewalNote: "No billing API available" };
    }
    return result;
}

// ─── Scan all providers: API keys from .env + OAuth/auth profiles ───
async function _scanAllProviders(): Promise<{ providers: any[]; oauth: any[]; note?: string }> {
    const env = readEnv();
    const results: any[] = [];

    const now = new Date();
    const dates: ProviderScanDates = {
        now,
        startOfMonth: new Date(now.getFullYear(), now.getMonth(), 1),
        startOfLastMonth: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        endOfLastMonth: new Date(now.getFullYear(), now.getMonth(), 0),
        sevenDaysAgo: new Date(now.getTime() - 7 * 86400e3),
        toIso: (d: Date) => d.toISOString().split("T")[0],
    };

    // ─── Per-provider timeout helper (10 seconds) ───
    function withProviderTimeout<T>(promise: Promise<T>, providerName: string): Promise<T> {
        return Promise.race([
            promise,
            new Promise<T>((_, reject) =>
                setTimeout(() => reject(new Error(`Provider scan timed out after 10s: ${providerName}`)), 10000)
            ),
        ]);
    }

    // ─── Run all provider scans in parallel with per-provider 10s timeouts ───
    const providerSettled = await Promise.allSettled([
        withProviderTimeout(scanProvider(ANTHROPIC_CONFIG, env, dates), "Anthropic"),
        withProviderTimeout(scanProvider(OPENAI_CONFIG, env, dates), "OpenAI"),
        withProviderTimeout(scanGoogle(env, dates), "Google"),
        withProviderTimeout(scanProvider(GROQ_CONFIG, env, dates), "Groq"),
        withProviderTimeout(scanProvider(MISTRAL_CONFIG, env, dates), "Mistral"),
        withProviderTimeout(scanOpenRouter(env), "OpenRouter"),
    ]);

    for (const settled of providerSettled) {
        if (settled.status === "fulfilled" && settled.value !== null) {
            results.push(settled.value);
        } else if (settled.status === "rejected") {
            // Timeout or unexpected error — log but don't crash the whole scan
            console.warn("[agent-dashboard] Provider scan failed:", settled.reason?.message || settled.reason);
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
    // Deduplicate: if a build is already in-flight, return its promise
    if (_providerBuildPromise) return _providerBuildPromise;

    _providerBuildPromise = (async () => {
        try {
            const result = await _scanAllProviders();
            _providerCache = { ...result, cachedAt: new Date().toISOString() };
            _providerCachedAt = Date.now();
        } catch (e: any) {
            console.error("[agent-dashboard] Provider cache build error:", e.message);
        }
        _providerBuildPromise = null;
        return _providerCache;
    })();

    return _providerBuildPromise;
}

// Kick off cache build after a short delay (let gateway finish starting)
if (_providerTimeoutId) clearTimeout(_providerTimeoutId);
_providerTimeoutId = setTimeout(() => { buildProviderCache(); }, 3000);

// ─── Route handler ───
export async function handleProviderRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method ?? "GET";

    // ─── GET /api/models/status — query provider APIs for quota/usage ───
    if (path === "/models/status" && method === "GET") {
        // Stale-while-revalidate: serve existing cache immediately, refresh in background if stale
        if (_providerCache) {
            if (_isCacheStale() && !_providerBuildPromise) {
                // Trigger background refresh — don't await
                buildProviderCache();
            }
            json(res, 200, _providerCache);
            return true;
        }

        // No cache at all — wait for the in-flight build or start one
        if (_providerBuildPromise) {
            await _providerBuildPromise;
        } else {
            await buildProviderCache();
        }

        if (_providerCache) {
            json(res, 200, _providerCache);
            return true;
        }

        json(res, 200, { providers: [], oauth: [], note: "Provider cache not yet built" });
        return true;
    }

    // ─── POST /api/models/status/refresh — force rebuild the provider cache ───
    if (path === "/models/status/refresh" && method === "POST") {
        _providerCache = null;
        _providerCachedAt = 0;
        _providerBuildPromise = null; // discard any stale in-flight build
        await buildProviderCache();
        json(res, 200, _providerCache || { providers: [], oauth: [] });
        return true;
    }

    return false;
}
