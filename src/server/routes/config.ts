import { writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    parseBody,
    readConfig,
    getConfigError,
    writeConfig,
    stageConfig,
    commitPendingChanges,
    discardPendingChanges,
    getPendingConfig,
    getPendingDestructiveOps,
    getPendingChangeCount,
    getPendingChangeDescriptions,
    readEffectiveConfig,
    execAsync,
    tryReadFile,
    CONFIG_PATH,
} from "../api-utils.js";
import { syncSkillsToAllWorkspaces } from "./skills.js";

// ─── Route handler ───
export async function handleConfigRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method ?? "GET";

    // ─── Config read/write ───
    if (path === "/config" && method === "GET") {
        const pending = getPendingConfig();
        const config = pending ? pending.config : readConfig();
        json(res, 200, { config, configError: getConfigError(), hasPending: getPendingChangeCount() > 0 });
        return true;
    }
    if (path === "/config/raw" && method === "GET") {
        // If there are pending staged changes, return those as the raw JSON
        // so the editor shows what the user has been working on, not the stale disk version.
        const pending = getPendingConfig();
        const hasPending = getPendingChangeCount() > 0;
        if (pending) {
            const raw = JSON.stringify(pending.config, null, 2);
            json(res, 200, { raw, configError: null, hasPending });
            return true;
        }
        const raw = tryReadFile(CONFIG_PATH);
        if (raw === null) { json(res, 200, { raw: "{}", configError: null, hasPending }); return true; }
        readConfig(); // trigger parse to populate error
        json(res, 200, { raw, configError: getConfigError(), hasPending });
        return true;
    }
    if (path === "/config" && method === "PUT") {
        const body = await parseBody(req);
        const defer = url.searchParams?.get("defer") === "1";
        // Support raw text save (for fixing broken JSON)
        if (typeof body.raw === "string") {
            try {
                JSON.parse(body.raw); // validate first
                if (defer) {
                    stageConfig(JSON.parse(body.raw), body.description || "Raw config edit");
                    json(res, 200, { ok: true, deferred: true });
                } else {
                    writeFileSync(CONFIG_PATH, body.raw, "utf-8");
                    json(res, 200, { ok: true });
                }
                return true;
            } catch (e: any) {
                json(res, 400, { error: "Invalid JSON: " + e.message });
                return true;
            }
        }
        if (!body.config) { json(res, 400, { error: "config required" }); return true; }
        if (defer) {
            stageConfig(body.config, body.description || "Config update");
            json(res, 200, { ok: true, deferred: true });
        } else {
            writeConfig(body.config);
            json(res, 200, { ok: true });
        }
        return true;
    }
    if (path === "/config/restart" && method === "POST") {
        // Use async exec to avoid blocking the event loop during restart
        try {
            await execAsync("openclaw gateway restart", { timeout: 15000 });
        } catch {
            // Even if the command "fails", the restart may have been initiated
            // (e.g. the process exiting causes execAsync to reject)
        }
        json(res, 200, { ok: true, warning: "restart signal sent" });
        return true;
    }

    // ─── GET /api/config/pending — check for staged changes ───
    if (path === "/config/pending" && method === "GET") {
        const pending = getPendingConfig();
        const hasPending = getPendingChangeCount() > 0;
        json(res, 200, {
            hasPending,
            changeCount: getPendingChangeCount(),
            descriptions: pending ? [...pending.descriptions, ...getPendingDestructiveOps().map((op) => op.description)] : getPendingChangeDescriptions(),
        });
        return true;
    }

    // ─── POST /api/config/commit — write staged config to disk and restart ───
    if (path === "/config/commit" && method === "POST") {
        const committed = commitPendingChanges();
        if (!committed) {
            json(res, 200, { ok: false, error: "No pending changes to commit" });
            return true;
        }
        json(res, 200, { ok: true });
        return true;
    }

    // ─── DELETE /api/config/pending — discard staged changes ───
    if (path === "/config/pending" && method === "DELETE") {
        const pendingDestructiveOps = getPendingDestructiveOps();
        discardPendingChanges();
        if (pendingDestructiveOps.some((op) => op.kind === "skill")) {
            syncSkillsToAllWorkspaces(readConfig());
        }
        json(res, 200, { ok: true });
        return true;
    }

    // ─── POST /api/config/validate — validate config before saving ───
    if (path === "/config/validate" && method === "POST") {
        const body = await parseBody(req);
        if (!body.config) { json(res, 400, { error: "config required" }); return true; }
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

        json(res, 200, { valid: errors.length === 0, errors, warnings, cliValidation });
        return true;
    }

    // ─── DELETE /api/channels/{name} — remove a channel from config ───
    const chMatch = path.match(/^\/channels\/([^/]+)$/);
    if (chMatch && method === "DELETE") {
        const chName = decodeURIComponent(chMatch[1]);
        const defer = url.searchParams?.get("defer") === "1";
        const config = defer ? readEffectiveConfig() : readConfig();
        if (config.channels && config.channels[chName]) {
            delete config.channels[chName];
            if (defer) {
                stageConfig(config, "Remove channel: " + chName);
                json(res, 200, { ok: true, deferred: true });
            } else {
                writeConfig(config);
                json(res, 200, { ok: true });
            }
        } else {
            json(res, 200, { ok: true });
        }
        return true;
    }

    // ─── PUT /api/channels/{name} — enable/disable a channel ───
    if (chMatch && method === "PUT") {
        const chName = decodeURIComponent(chMatch[1]);
        const body = await parseBody(req);
        const defer = url.searchParams?.get("defer") === "1";
        const config = defer ? readEffectiveConfig() : readConfig();
        if (!config.channels) config.channels = {};
        if (!config.channels[chName]) config.channels[chName] = {};
        Object.assign(config.channels[chName], body);
        if (defer) {
            stageConfig(config, "Update channel: " + chName);
            json(res, 200, { ok: true, deferred: true });
        } else {
            writeConfig(config);
            json(res, 200, { ok: true });
        }
        return true;
    }

    return false;
}
