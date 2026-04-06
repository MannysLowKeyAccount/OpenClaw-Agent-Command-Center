import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    parseBody,
    readConfig,
    writeConfig,
    readEnv,
    execAsync,
    tryReadFile,
    OPENCLAW_DIR,
    AGENTS_STATE_DIR,
} from "../api-utils.js";
import { invalidateProviderCache } from "./providers.js";

export async function handleAuthProfileRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method || "GET";

    // ─── DELETE /api/auth/profile — remove an auth profile entry from ALL locations ───
    if (path === "/auth/profile" && method === "DELETE") {
        const body = await parseBody(req);
        const profileKey = body.profileKey;
        if (!profileKey) { json(res, 400, { error: "profileKey required" }); return true; }

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
            const authRaw = tryReadFile(authFile);
            if (authRaw === null) continue;
            try {
                const raw = JSON.parse(authRaw);
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
        invalidateProviderCache();

        json(res, 200, { ok: true, deleted, deletedFrom });
        return true;
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

        json(res, success ? 200 : 500, {
            ok: success,
            result: result.trim(),
            note: success
                ? "Token refresh initiated. Check the API Status page to verify."
                : "Could not refresh token. You may need to run 'openclaw auth login' manually on the server.",
        });
        return true;
    }

    // ─── POST /api/auth/reveal — reveal the full API key for a given env var ───
    if (path === "/auth/reveal" && method === "POST") {
        const body = await parseBody(req);
        const envVar = body.envVar || "";
        const profileKey = body.profileKey || "";

        if (envVar) {
            const env = readEnv();
            const val = env[envVar];
            if (val) {
                console.log("[agent-dashboard] API key revealed: envVar=%s at=%s", envVar, new Date().toISOString());
                json(res, 200, { key: val });
                return true;
            }
            json(res, 404, { error: "Key not found in .env" });
            return true;
        }

        if (profileKey) {
            // Look up the token from auth-profiles
            const authFiles = [
                join(AGENTS_STATE_DIR, "main", "agent", "auth-profiles.json"),
                join(AGENTS_STATE_DIR, "main", "auth-profiles.json"),
                join(OPENCLAW_DIR, "credentials", "oauth.json"),
            ];
            for (const f of authFiles) {
                const authRaw = tryReadFile(f);
                if (authRaw === null) continue;
                try {
                    const raw = JSON.parse(authRaw);
                    const profiles = raw.profiles || raw;
                    if (profiles?.[profileKey]) {
                        const p = profiles[profileKey];
                        const token = p.access || p.access_token || p.key || "";
                        console.log("[agent-dashboard] API key revealed: envVar=%s at=%s", profileKey, new Date().toISOString());
                        json(res, 200, { key: token });
                        return true;
                    }
                } catch { }
            }
            json(res, 404, { error: "Profile not found" });
            return true;
        }

        json(res, 400, { error: "envVar or profileKey required" });
        return true;
    }

    // ─── DELETE /api/auth/envkey — remove an API key from .env ───
    if (path === "/auth/envkey" && method === "DELETE") {
        const body = await parseBody(req);
        const envVar = body.envVar || "";
        if (!envVar || !/^[A-Z0-9_]+$/.test(envVar)) { json(res, 400, { error: "Invalid env var name" }); return true; }

        const envPath = join(OPENCLAW_DIR, ".env");
        const envContent = tryReadFile(envPath);
        if (envContent === null) { json(res, 404, { error: ".env file not found" }); return true; }

        try {
            const lines = envContent.split("\n");
            const filtered = lines.filter(line => {
                const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
                return !(m && m[1] === envVar);
            });
            writeFileSync(envPath, filtered.join("\n"), "utf-8");
            json(res, 200, { ok: true });
            return true;
        } catch (e: any) {
            json(res, 500, { error: e.message });
            return true;
        }
    }

    // ─── POST /api/auth/envkey — add or update an API key in .env ───
    if (path === "/auth/envkey" && method === "POST") {
        const body = await parseBody(req);
        const envVar = (body.envVar || "").trim();
        const value = (body.value || "").trim();
        if (!envVar || !/^[A-Z0-9_]+$/.test(envVar)) { json(res, 400, { error: "Invalid env var name. Use uppercase with underscores, e.g. ANTHROPIC_API_KEY" }); return true; }
        if (!value) { json(res, 400, { error: "Value is required" }); return true; }

        const envPath = join(OPENCLAW_DIR, ".env");
        try {
            let content = tryReadFile(envPath) ?? "";
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
            json(res, 200, { ok: true, updated: found });
            return true;
        } catch (e: any) {
            json(res, 500, { error: e.message });
            return true;
        }
    }

    return false;
}
