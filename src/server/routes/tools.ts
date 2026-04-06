import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    readConfig,
    readDashboardConfig,
    writeDashboardConfig,
    resolveHome,
    tryReadFile,
    OPENCLAW_DIR,
} from "../api-utils.js";

// ─── Tool Discovery — scan config + extensions for available tools ───
async function discoverTools(): Promise<any> {
    const config = readConfig();
    const EXTENSIONS_DIR = join(OPENCLAW_DIR, "extensions");

    // 1. Query gateway for actual registered tools (if CLI available)
    const builtinTools: any[] = [];
    try {
        const r = await new Promise<string>((resolve) => {
            exec("openclaw tools list --json", { encoding: "utf-8", timeout: 8000 }, (_err, stdout) => {
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
    if (config.browser?.enabled !== false && !builtinTools.some((t: any) => t.id === "browser")) {
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
            const pkgRaw = tryReadFile(pkgPath);
            if (pkgRaw !== null) {
                try {
                    const pkg = JSON.parse(pkgRaw);
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
        const pkgRaw = tryReadFile(pkgPath);
        if (pkgRaw === null) continue;

        try {
            const pkg = JSON.parse(pkgRaw);
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

// ─── Route handler ───
export async function handleToolRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method || "GET";

    // GET /api/tools/discover — return cached tool registry (or scan if missing)
    if (path === "/tools/discover" && method === "GET") {
        const dashCfg = readDashboardConfig();
        if (dashCfg.toolRegistry && dashCfg.toolRegistry.tools) {
            json(res, 200, dashCfg.toolRegistry);
            return true;
        }
        // No cache — do a fresh scan
        const registry = await discoverTools();
        const dashCfg2 = readDashboardConfig();
        dashCfg2.toolRegistry = registry;
        writeDashboardConfig(dashCfg2);
        json(res, 200, registry);
        return true;
    }

    // POST /api/tools/discover — force refresh tool registry
    if (path === "/tools/discover" && method === "POST") {
        const registry = await discoverTools();
        const dashCfg = readDashboardConfig();
        dashCfg.toolRegistry = registry;
        writeDashboardConfig(dashCfg);
        json(res, 200, registry);
        return true;
    }

    return false;
}
