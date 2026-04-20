import { existsSync, readdirSync, realpathSync, statSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    parseBody,
    readConfig,
    readEffectiveConfig,
    writeConfig,
    stageConfig,
    stagePendingDestructiveOp,
    getPendingDestructiveOps,
    resolveHome,
    tryReadFile,
    OPENCLAW_DIR,
    execAsync,
    shellEsc,
} from "../api-utils.js";

// ─── Plugin metadata scan ───

interface PluginInfo {
    name: string;
    version?: string;
    description?: string;
    path: string;
    source: "install" | "loadPath" | "extensionsDir";
    enabled: boolean;
    kind?: string;
    removable: boolean;
    /** Original config key for install-source plugins (may differ from package name). */
    configKey?: string;
}

function readPluginPackageJson(pluginPath: string): { name: string; version?: string; description?: string; openclaw?: any } | null {
    const pkgPath = join(pluginPath, "package.json");
    const raw = tryReadFile(pkgPath);
    if (raw === null) return null;
    try {
        const pkg = JSON.parse(raw);
        return {
            name: pkg.name || "unknown",
            version: pkg.version,
            description: pkg.description,
            openclaw: pkg.openclaw || pkg.openClaw || {},
        };
    } catch { return null; }
}

function isProtectedPlugin(name: string): boolean {
    // Protect the dashboard plugin from accidental removal
    return name === "agent-dashboard" || name === "openclaw-agent-dashboard" || name === "openclaw-agent-command-center";
}

function scanPlugins(): PluginInfo[] {
    const config = readEffectiveConfig();
    const pluginEntries = config.plugins?.entries || {};
    const pluginInstalls = config.plugins?.installs || {};
    const pluginLoadPaths = config.plugins?.load?.paths || [];
    const extensionsDir = join(OPENCLAW_DIR, "extensions");

    const seen = new Set<string>();
    const plugins: PluginInfo[] = [];

    // 1. From config.plugins.installs
    for (const [name, info] of Object.entries(pluginInstalls) as [string, any][]) {
        if (!info.installPath || !existsSync(info.installPath)) continue;
        const pkg = readPluginPackageJson(info.installPath);
        if (!pkg) continue;
        const displayName = pkg.name || name;
        seen.add(info.installPath);
        plugins.push({
            name: displayName,
            version: pkg.version,
            description: pkg.description,
            path: info.installPath,
            source: "install",
            enabled: pluginEntries[name]?.enabled !== false,
            kind: pkg.openclaw?.kind || pkg.openclaw?.tools ? "tools" : undefined,
            removable: !isProtectedPlugin(displayName),
            configKey: name,
        });
    }

    // 2. From config.plugins.load.paths
    for (const lp of pluginLoadPaths) {
        const resolved = resolveHome(lp);
        if (!existsSync(resolved) || seen.has(resolved)) continue;
        const pkg = readPluginPackageJson(resolved);
        if (!pkg) continue;
        seen.add(resolved);
        plugins.push({
            name: pkg.name || resolved.split("/").pop() || "unknown",
            version: pkg.version,
            description: pkg.description,
            path: resolved,
            source: "loadPath",
            enabled: pluginEntries[pkg.name]?.enabled !== false,
            kind: pkg.openclaw?.kind || pkg.openclaw?.tools ? "tools" : undefined,
            removable: !isProtectedPlugin(pkg.name || resolved.split("/").pop() || "unknown"),
        });
    }

    // 3. From extensions directory
    if (existsSync(extensionsDir)) {
        try {
            for (const dir of readdirSync(extensionsDir)) {
                const fullPath = join(extensionsDir, dir);
                try { if (!statSync(fullPath).isDirectory()) continue; } catch { continue; }
                if (seen.has(fullPath)) continue;
                const pkg = readPluginPackageJson(fullPath);
                if (!pkg) continue;
                seen.add(fullPath);
                plugins.push({
                    name: pkg.name || dir,
                    version: pkg.version,
                    description: pkg.description,
                    path: fullPath,
                    source: "extensionsDir",
                    enabled: pluginEntries[pkg.name]?.enabled !== false,
                    kind: pkg.openclaw?.kind || pkg.openclaw?.tools ? "tools" : undefined,
                    removable: !isProtectedPlugin(pkg.name || dir),
                });
            }
        } catch { }
    }

    return plugins;
}

// ─── Identifier validation ───
function isValidPluginIdentifier(id: string): boolean {
    if (!id || typeof id !== "string") return false;
    const trimmed = id.trim();
    if (!trimmed) return false;
    // Local path
    if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("/") || trimmed.startsWith("~")) {
        return /^[\w\-.~\/]+$/.test(trimmed) && !trimmed.includes("..") && !trimmed.includes(";") && !trimmed.includes("&") && !trimmed.includes("|");
    }
    // npm package name (including scoped)
    return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(trimmed);
}

/** Check whether a path is inside a managed directory (safe to delete). */
function isManagedPath(p: string, base: string): boolean {
    try {
        const resolvedPath = realpathSync(p);
        const resolvedBase = realpathSync(base);
        const rel = relative(resolvedBase, resolvedPath);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    } catch {
        return false;
    }
}

/** Remove plugin name from agent tool allow/deny lists. */
function cleanAgentToolRefs(config: any, pluginName: string): void {
    const agents = config.agents?.list;
    if (!Array.isArray(agents)) return;
    for (const agent of agents) {
        if (!agent.tools) continue;
        const lists = ["alsoAllow", "allow", "deny"];
        for (const key of lists) {
            const arr = agent.tools[key];
            if (!Array.isArray(arr)) continue;
            // Remove exact plugin-name matches and plugin-prefixed tool IDs
            agent.tools[key] = arr.filter((id: string) => {
                if (id === pluginName) return false;
                if (id.startsWith(pluginName + "_") || id.startsWith(pluginName + "/")) return false;
                return true;
            });
            if (agent.tools[key].length === 0) {
                delete agent.tools[key];
            }
        }
    }
}

/** Remove plugin from config and return filesystem paths that should be deleted on apply. */
function removePluginFromConfig(config: any, plugin: PluginInfo): { deletedPaths: string[] } {
    const deletedPaths: string[] = [];
    const name = plugin.name;

    // Clean slots
    const slots = config.plugins?.slots || {};
    for (const [slotName, pluginId] of Object.entries(slots)) {
        if (pluginId === name) {
            delete slots[slotName];
        }
    }

    // Clean agents' tool references
    cleanAgentToolRefs(config, name);

    if (plugin.source === "install") {
        const installs = config.plugins?.installs || {};
        const installKey = plugin.configKey || name;
        const installPath = installs[installKey]?.installPath;
        if (installPath) deletedPaths.push(installPath);
        delete installs[installKey];
    }

    if (plugin.source === "loadPath") {
        const paths: string[] = config.plugins?.load?.paths || [];
        const resolvedPluginPath = resolveHome(plugin.path);
        config.plugins.load.paths = paths.filter((p: string) => {
            const rp = resolveHome(p);
            return rp !== resolvedPluginPath && rp !== plugin.path;
        });
        // Do NOT delete arbitrary external folders
    }

    if (plugin.source === "extensionsDir") {
        const extensionsDir = join(OPENCLAW_DIR, "extensions");
        if (isManagedPath(plugin.path, extensionsDir)) deletedPaths.push(plugin.path);
    }

    // Always remove the plugin entry
    const entries = config.plugins?.entries || {};
    delete entries[name];

    return { deletedPaths };
}

// ─── Route handler ───
export async function handlePluginRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method || "GET";

    // ─── GET /api/plugins — list installed plugins ───
    if (path === "/plugins" && method === "GET") {
        const pending = getPendingDestructiveOps().filter((op) => op.kind === "plugin");
        const plugins = scanPlugins().filter((plugin) => !pending.some((op) => {
            if (op.name === plugin.name) return true;
            if (op.path === plugin.path) return true;
            return op.configKey !== undefined && plugin.configKey !== undefined && op.configKey === plugin.configKey;
        }));
        json(res, 200, { plugins });
        return true;
    }

    // ─── POST /api/plugins/install — install a plugin ───
    if (path === "/plugins/install" && method === "POST") {
        const body = await parseBody(req);
        const identifier = (body.identifier || "").trim();
        if (!identifier) {
            return json(res, 400, { error: "identifier required" }), true;
        }
        if (!isValidPluginIdentifier(identifier)) {
            return json(res, 400, { error: "invalid plugin identifier" }), true;
        }

        try {
            const cmd = `openclaw plugins install "${shellEsc(identifier)}"`;
            await execAsync(cmd, { timeout: 120000 });
            json(res, 200, { ok: true });
        } catch (err: any) {
            json(res, 500, { error: err.message || "Install failed" });
        }
        return true;
    }

    // ─── POST /api/plugins/remove — remove a plugin ───
    if (path === "/plugins/remove" && method === "POST") {
        const body = await parseBody(req);
        const name = (body.name || "").trim();
        if (!name) {
            return json(res, 400, { error: "name required" }), true;
        }

        const plugins = scanPlugins();
        const plugin = plugins.find((p) => p.name === name);
        if (!plugin) {
            return json(res, 404, { error: "plugin not found" }), true;
        }
        if (!plugin.removable) {
            return json(res, 403, { error: "plugin is protected and cannot be removed" }), true;
        }

        const defer = _url.searchParams?.get("defer") === "1";
        const config = defer ? readEffectiveConfig() : readConfig();

        const { deletedPaths } = removePluginFromConfig(config, plugin);
        const applyRemoval = () => {
            for (const deletedPath of deletedPaths) {
                const managedExtensionsDir = join(OPENCLAW_DIR, "extensions");
                if (!isManagedPath(deletedPath, managedExtensionsDir)) continue;
                try {
                    if (existsSync(deletedPath)) {
                        rmSync(deletedPath, { recursive: true, force: true });
                    }
                } catch { /* ignore deletion errors */ }
            }
        };

        if (defer) {
            const pluginKey = `plugin:${plugin.configKey || plugin.name}`;
            stagePendingDestructiveOp({
                kind: "plugin",
                key: pluginKey,
                name: plugin.name,
                configKey: plugin.configKey,
                path: plugin.path,
                description: `Remove plugin: ${name}`,
                apply: applyRemoval,
            });
            stageConfig(config, "Remove plugin: " + name);
            json(res, 200, { ok: true, deferred: true, deletedPaths });
        } else {
            writeConfig(config);
            applyRemoval();
            json(res, 200, { ok: true, deletedPaths });
        }
        return true;
    }

    return false;
}
