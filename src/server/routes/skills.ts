import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    parseBody,
    readConfig,
    writeConfig,
    stageConfig,
    readEffectiveConfig,
    getAgentWorkspace,
    OPENCLAW_DIR,
    stagePendingDestructiveOp,
    getPendingDestructiveOps,
    execAsync,
    execFileAsync,
    shellEsc,
} from "../api-utils.js";

// ─── Skills config — separate from openclaw.json to avoid gateway validation issues ───
// Stored at ~/.openclaw/extensions/openclaw-agent-dashboard/skills-config.json
import { DASHBOARD_CONFIG_DIR } from "../api-utils.js";
const SKILLS_CONFIG_PATH = join(DASHBOARD_CONFIG_DIR, "skills-config.json");
const GLOBAL_MANAGED_SKILLS_KEY = "__globalManagedSkills";

function readSkillsConfig(): any {
    if (!existsSync(SKILLS_CONFIG_PATH)) return {};
    try { return JSON.parse(readFileSync(SKILLS_CONFIG_PATH, "utf-8")); } catch { return {}; }
}

function writeSkillsConfig(cfg: any): void {
    if (!existsSync(DASHBOARD_CONFIG_DIR)) mkdirSync(DASHBOARD_CONFIG_DIR, { recursive: true });
    writeFileSync(SKILLS_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

function getManagedSkillEnabled(skillsCfg: any, agentId: string, dirName: string, tier: string): boolean {
    const agentEntry = skillsCfg?.[agentId]?.[dirName];
    if (agentEntry !== undefined) return agentEntry.enabled !== false;

    if (tier === "managed") {
        const globalEntry = skillsCfg?.[GLOBAL_MANAGED_SKILLS_KEY]?.[dirName];
        if (globalEntry !== undefined) return globalEntry.enabled !== false;
    }

    return true;
}

function setGlobalManagedSkillEnabled(skillsCfg: any, dirName: string, enabled: boolean): void {
    if (!skillsCfg[GLOBAL_MANAGED_SKILLS_KEY]) skillsCfg[GLOBAL_MANAGED_SKILLS_KEY] = {};
    skillsCfg[GLOBAL_MANAGED_SKILLS_KEY][dirName] = { enabled };

    for (const key of Object.keys(skillsCfg)) {
        if (key === GLOBAL_MANAGED_SKILLS_KEY) continue;
        const entries = skillsCfg[key];
        if (!entries || typeof entries !== "object") continue;
        if (entries[dirName] === undefined) continue;
        delete entries[dirName];
        if (Object.keys(entries).length === 0) delete skillsCfg[key];
    }
}

// ─── Sync enabled skills to workspace SKILLS.md ───
// The gateway reads all .md files from the workspace as part of the system prompt.
// This writes a lightweight SKILLS.md index generated from enabled skills.
// The agent uses its `read` tool to load a skill's full instructions on demand.
export function syncSkillsToWorkspace(agentId: string, config?: any): void {
    if (!config) config = readConfig();
    const agentsList = config?.agents?.list || [];
    let agent = agentsList.find((a: any) => a.id === agentId);
    if (!agent && agentId === "main") agent = { id: "main" };
    if (!agent) return;

    const workspace = getAgentWorkspace(agent);
    if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });

    const wsSkillsDir = join(workspace, "skills");
    const managedSkillsDir = join(OPENCLAW_DIR, "skills");
    const skillsCfg = readSkillsConfig();
    const agentEntries = skillsCfg[agentId] || {};
    const pending = getPendingDestructiveOps().filter((op) => op.kind === "skill");

    const seen = new Set<string>();
    const lines: string[] = [];

    for (const base of [wsSkillsDir, managedSkillsDir]) {
        if (!existsSync(base)) continue;
        try {
            for (const entry of readdirSync(base)) {
                if (seen.has(entry)) continue;
                seen.add(entry);
                const tier = base === managedSkillsDir ? "managed" : "workspace";
                if (pending.some((op) => op.dirName === entry && op.scope === tier && (tier === "managed" || op.agentId === agentId || op.agentId === "__global__"))) continue;
                const skillDir = join(base, entry);
                try { if (!statSync(skillDir).isDirectory()) continue; } catch { continue; }
                if (tier === "managed") {
                    const globalEntry = skillsCfg?.[GLOBAL_MANAGED_SKILLS_KEY]?.[entry];
                    if (globalEntry !== undefined && globalEntry.enabled === false) continue;
                }
                const agentEntry = skillsCfg?.[agentId]?.[entry];
                if (agentEntry !== undefined && agentEntry.enabled === false) continue;
                const skillMdPath = join(skillDir, "SKILL.md");
                if (!existsSync(skillMdPath)) continue;
                try {
                    const content = readFileSync(skillMdPath, "utf-8");
                    const parsed = parseSkillMd(content);
                    const relPath = base === wsSkillsDir
                        ? `skills/${entry}/SKILL.md`
                        : `~/.openclaw/skills/${entry}/SKILL.md`;
                    const desc = parsed.description ? ` — ${parsed.description}` : "";
                    lines.push(`- **${parsed.name || entry}**${desc}  \n  → \`${relPath}\``);
                } catch { }
            }
        } catch { }
    }

    const skillsMdPath = join(workspace, "SKILLS.md");
    if (lines.length === 0) {
        try { if (existsSync(skillsMdPath)) rmSync(skillsMdPath); } catch { }
        return;
    }

    const content = `# Active Skills

Read the skill file before acting when a request matches a skill below.

${lines.join("\n")}
`;
    writeFileSync(skillsMdPath, content, "utf-8");
}

export function syncSkillsToAllWorkspaces(config?: any): void {
    if (!config) config = readConfig();
    const agentsList = config?.agents?.list || [];
    const seen = new Set<string>();

    for (const agent of agentsList) {
        if (!agent?.id || seen.has(agent.id)) continue;
        seen.add(agent.id);
        syncSkillsToWorkspace(agent.id, config);
    }

    if (!seen.has("main")) syncSkillsToWorkspace("main", config);
}

// ─── SKILL.md frontmatter parser ───
function parseSkillMd(content: string): { name: string; description: string; metadata: any; body: string } {
    const defaults = { name: "", description: "", metadata: {}, body: content };
    if (!content.startsWith("---")) return defaults;
    const endIdx = content.indexOf("---", 3);
    if (endIdx < 0) return defaults;
    const yaml = content.slice(3, endIdx).trim();
    const body = content.slice(endIdx + 3).trim();
    const result: any = { name: "", description: "", metadata: {}, body };
    for (const line of yaml.split("\n")) {
        const m = line.match(/^(\w[\w-]*):\s*(.+)$/);
        if (!m) continue;
        const [, key, val] = m;
        const cleaned = val.replace(/^["']|["']$/g, "").trim();
        if (key === "name") result.name = cleaned;
        else if (key === "description") result.description = cleaned;
        else if (key === "metadata") {
            try { result.metadata = JSON.parse(cleaned); } catch { }
        }
    }
    return result;
}

// ─── Path safety ───
function isSafeDirName(name: string): boolean {
    return !!name && !/[\/\\]/.test(name) && !name.includes("..") && !name.includes("\0");
}

// ─── Source / identifier validation ───
const VALID_SOURCES = ["clawhub", "skills.sh", "github"] as const;

function isValidSource(s: any): s is typeof VALID_SOURCES[number] {
    return VALID_SOURCES.includes(s);
}

function validateIdentifier(source: string, identifier: string): string | null {
    const id = identifier.trim();
    if (!id) return "identifier required";
    if (source === "clawhub") {
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
            return "clawhub identifier must be a simple slug (alphanumeric, hyphens, underscores)";
        }
    } else if (source === "skills.sh") {
        if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(id)) {
            return "skills.sh identifier must be owner/repo";
        }
    } else if (source === "github") {
        if (!/^https?:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+/.test(id)) {
            return "github identifier must be a full GitHub URL (https://github.com/owner/repo)";
        }
    }
    return null;
}

// ─── Scan a skills directory for skill folders ───
function scanSkillsDir(dir: string, tier: string, agentId?: string): any[] {
    if (!existsSync(dir)) return [];
    const skills: any[] = [];
    const pending = getPendingDestructiveOps().filter((op) => op.kind === "skill");
    try {
        for (const entry of readdirSync(dir)) {
            if (pending.some((op) => op.dirName === entry && op.scope === tier && (tier === "managed" || op.agentId === agentId || op.agentId === "__global__"))) continue;
            const skillDir = join(dir, entry);
            try { if (!statSync(skillDir).isDirectory()) continue; } catch { continue; }
            const skillMdPath = join(skillDir, "SKILL.md");
            let parsed = { name: "", description: "", metadata: {} as any, body: "" };
            let hasValidSkillMd = false;
            if (existsSync(skillMdPath)) {
                try {
                    const content = readFileSync(skillMdPath, "utf-8");
                    parsed = parseSkillMd(content);
                    hasValidSkillMd = !!parsed.name;
                } catch { }
            }
            const ocMeta = parsed.metadata?.openclaw || {};
            skills.push({
                dirName: entry,
                name: parsed.name || entry,
                description: parsed.description || "",
                emoji: ocMeta.emoji || "",
                tier,
                hasValidSkillMd,
                requires: {
                    bins: ocMeta.requires?.bins || [],
                    env: ocMeta.requires?.env || [],
                },
            });
        }
    } catch { }
    return skills;
}

// ─── Route handler ───
export async function handleSkillRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method || "GET";

    // ─── GET /api/skills — list global (managed) skills only ───
    if (path === "/skills" && method === "GET") {
        const managedSkillsDir = join(OPENCLAW_DIR, "skills");
        const skills = scanSkillsDir(managedSkillsDir, "managed", "__global__");
        const skillsCfg = readSkillsConfig();
        for (const s of skills) {
            s.enabled = getManagedSkillEnabled(skillsCfg, "__global__", s.dirName, s.tier);
        }
        json(res, 200, { skills });
        return true;
    }

    // ─── GET /api/skills/:agentId — list all skills ───
    const listMatch = path.match(/^\/skills\/([^/]+)$/);
    if (listMatch && method === "GET") {
        const agentId = decodeURIComponent(listMatch[1]);
        const config = readEffectiveConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;

        const workspace = getAgentWorkspace(agent);
        const wsSkillsDir = join(workspace, "skills");
        const managedSkillsDir = join(OPENCLAW_DIR, "skills");

        const wsSkills = scanSkillsDir(wsSkillsDir, "workspace", agentId);
        const managedSkills = scanSkillsDir(managedSkillsDir, "managed", agentId);

        // Apply precedence: mark managed skills as shadowed if workspace has same dirName
        const wsNames = new Set(wsSkills.map((s: any) => s.dirName));
        for (const s of managedSkills) {
            if (wsNames.has(s.dirName)) {
                s.shadowed = true;
                s.shadowedBy = "workspace";
            } else {
                s.shadowed = false;
                s.shadowedBy = null;
            }
        }
        for (const s of wsSkills) {
            s.shadowed = false;
            s.shadowedBy = null;
        }

        // Merge enabled/disabled from skills config — per-agent
        const skillsCfg = readSkillsConfig();
        const agentEntries = skillsCfg[agentId] || {};
        const allSkills = [...wsSkills, ...managedSkills];
        for (const s of allSkills) {
            s.enabled = getManagedSkillEnabled(skillsCfg, agentId, s.dirName, s.tier);
        }

        json(res, 200, { skills: allSkills });
        return true;
    }

    // ─── POST /api/skills/:agentId/install — install from registry ───
    const installMatch = path.match(/^\/skills\/([^/]+)\/install$/);
    if (installMatch && method === "POST") {
        const agentId = decodeURIComponent(installMatch[1]);
        const body = await parseBody(req);
        const { source, identifier, scope } = body;

        if (!isValidSource(source)) {
            return json(res, 400, { error: "source must be clawhub, skills.sh, or github" }), true;
        }
        const id = identifier?.trim();
        if (!id) return json(res, 400, { error: "identifier required" }), true;
        const validationError = validateIdentifier(source, id);
        if (validationError) return json(res, 400, { error: validationError }), true;

        const config = readEffectiveConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;

        const workspace = getAgentWorkspace(agent);
        const targetDir = scope === "managed" ? join(OPENCLAW_DIR, "skills") : join(workspace, "skills");
        if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

        let tmpBase: string | undefined;
        try {
            if (source === "clawhub") {
                const cmd = `clawhub install "${shellEsc(id)}" --workdir "${shellEsc(targetDir)}"`;
                await execAsync(cmd, { timeout: 120000 });
            } else {
                // skills.sh or github direct
                // The skills CLI installs to <cwd>/<agent>/skills/ in project scope.
                // "openclaw" is the recognized agent name in the skills CLI ecosystem.
                // We use a temp working dir, then move results to the target.
                tmpBase = join(OPENCLAW_DIR, ".tmp-skill-install");
                if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });
                mkdirSync(tmpBase, { recursive: true });
                await execFileAsync("npx", ["-y", "skills", "add", id, "--skill", "*", "--agent", "openclaw", "--copy", "-y"], { timeout: 120000, cwd: tmpBase });

                // Recursively find all SKILL.md files in the temp dir
                const findSkills = (dir: string): string[] => {
                    const results: string[] = [];
                    try {
                        for (const entry of readdirSync(dir)) {
                            const full = join(dir, entry);
                            try {
                                if (statSync(full).isDirectory()) {
                                    if (existsSync(join(full, "SKILL.md"))) {
                                        results.push(full);
                                    } else {
                                        results.push(...findSkills(full));
                                    }
                                }
                            } catch { }
                        }
                    } catch { }
                    return results;
                };
                const skillDirs = findSkills(tmpBase);
                for (const skillPath of skillDirs) {
                    const skillName = basename(skillPath);
                    if (!isSafeDirName(skillName)) continue;
                    const dest = join(targetDir, skillName);
                    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
                    await execFileAsync("cp", ["-r", skillPath, dest], { timeout: 10000 });
                }
            }
            if (scope === "managed") syncSkillsToAllWorkspaces(config);
            else syncSkillsToWorkspace(agentId, config);
            json(res, 200, { ok: true });
        } catch (err: any) {
            json(res, 500, { error: err.message || "Install failed" });
        } finally {
            if (tmpBase && existsSync(tmpBase)) {
                try { rmSync(tmpBase, { recursive: true, force: true }); } catch { }
            }
        }
        return true;
    }

    // ─── GET /api/skills/:agentId/:dirName — read skill ───
    const readMatch = path.match(/^\/skills\/([^/]+)\/([^/]+)$/);
    if (readMatch && method === "GET") {
        const agentId = decodeURIComponent(readMatch[1]);
        const dirName = decodeURIComponent(readMatch[2]);
        if (!isSafeDirName(dirName)) return json(res, 403, { error: "Invalid skill name" }), true;

        const scope = _url.searchParams?.get("scope") || "workspace";
        const config = readEffectiveConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;

        const skillDir = resolveSkillDir(agent, dirName, scope);
        const skillMdPath = join(skillDir, "SKILL.md");
        const pending = getPendingDestructiveOps().some((op) => op.kind === "skill" && op.dirName === dirName && op.scope === scope && (scope === "managed" || op.agentId === agentId || op.agentId === "__global__"));
        if (pending) return json(res, 404, { error: "Skill not found" }), true;
        if (!existsSync(skillMdPath)) return json(res, 404, { error: "Skill not found" }), true;

        const content = readFileSync(skillMdPath, "utf-8");
        json(res, 200, { dirName, scope, content });
        return true;
    }

    // ─── PUT /api/skills/:agentId/:dirName — create/update skill ───
    if (readMatch && method === "PUT") {
        const agentId = decodeURIComponent(readMatch[1]);
        const dirName = decodeURIComponent(readMatch[2]);
        if (!isSafeDirName(dirName)) return json(res, 403, { error: "Invalid skill name" }), true;

        const body = await parseBody(req);
        const scope = body.scope || "workspace";
        if (scope === "bundled") return json(res, 403, { error: "Cannot modify bundled skills" }), true;

        const config = readEffectiveConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;

        const skillDir = resolveSkillDir(agent, dirName, scope);
        if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });

        // Build SKILL.md content
        let content: string;
        if (body.content !== undefined) {
            // Raw content provided (edit mode)
            content = body.content;
        } else {
            // Create mode: build from name + description + body
            const name = body.name || dirName;
            const desc = body.description || "";
            const instrBody = body.body || "";
            content = `---\nname: ${name}\ndescription: ${desc}\n---\n\n${instrBody}`;
        }

        writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");

        // New skill is enabled by default — ensure read_file is available
        await ensureReadFileAllowed(config, agentId);

        // Sync SKILLS.md before writing config (writeConfig triggers gateway restart)
        if (scope === "managed") syncSkillsToAllWorkspaces(config);
        else syncSkillsToWorkspace(agentId, config);
        const defer = _url.searchParams?.get("defer") === "1";
        if (defer) {
            stageConfig(config, "Update skill: " + dirName);
            json(res, 200, { ok: true, deferred: true });
        } else {
            writeConfig(config);
            json(res, 200, { ok: true });
        }
        return true;
    }

    // ─── DELETE /api/skills/:agentId/:dirName — delete skill ───
    const deleteMatch = path.match(/^\/skills\/([^/]+)\/([^/]+)$/);
    if (deleteMatch && method === "DELETE") {
        const agentId = decodeURIComponent(deleteMatch[1]);
        const dirName = decodeURIComponent(deleteMatch[2]);
        if (!isSafeDirName(dirName)) return json(res, 403, { error: "Invalid skill name" }), true;

        const scope = _url.searchParams?.get("scope") || "workspace";
        if (scope === "bundled") return json(res, 403, { error: "Cannot delete bundled skills" }), true;

        const config = readEffectiveConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;

        const skillDir = resolveSkillDir(agent, dirName, scope);
        if (!existsSync(skillDir)) return json(res, 404, { error: "Skill not found" }), true;

        const skillKey = `skill:${scope}:${scope === "managed" ? "__global__" : agentId}:${dirName}`;
        const applyRemoval = () => {
            try { rmSync(skillDir, { recursive: true, force: true }); } catch { }
            if (scope === "managed") syncSkillsToAllWorkspaces(config);
            else syncSkillsToWorkspace(agentId, config);
        };

        if (_url.searchParams?.get("defer") === "1") {
            stagePendingDestructiveOp({
                kind: "skill",
                key: skillKey,
                agentId: scope === "managed" ? "__global__" : agentId,
                dirName,
                scope,
                path: skillDir,
                description: `Delete skill: ${dirName}`,
                apply: applyRemoval,
            });
            if (scope === "managed") syncSkillsToAllWorkspaces(config);
            else syncSkillsToWorkspace(agentId, config);
            json(res, 200, { ok: true, deferred: true });
        } else {
            applyRemoval();
            json(res, 200, { ok: true });
        }
        return true;
    }

    // ─── PATCH /api/skills/:agentId/:dirName — toggle enabled ───
    const patchMatch = path.match(/^\/skills\/([^/]+)\/([^/]+)$/);
    if (patchMatch && method === "PATCH") {
        const agentId = decodeURIComponent(patchMatch[1]);
        const dirName = decodeURIComponent(patchMatch[2]);
        if (!isSafeDirName(dirName)) return json(res, 403, { error: "Invalid skill name" }), true;

        const body = await parseBody(req);
        const skillsCfg = readSkillsConfig();
        const isGlobalManagedToggle = body.scope === "managed";
        if (isGlobalManagedToggle) {
            setGlobalManagedSkillEnabled(skillsCfg, dirName, !!body.enabled);
        } else {
            if (!skillsCfg[agentId]) skillsCfg[agentId] = {};
            skillsCfg[agentId][dirName] = { enabled: !!body.enabled };
        }
        writeSkillsConfig(skillsCfg);

        // When enabling a skill, ensure read tool is available for the agent
        const config = readEffectiveConfig();
        if (body.enabled) {
            if (isGlobalManagedToggle) {
                const agentsList = config.agents?.list || [];
                const seenAgents = new Set<string>();
                for (const agent of agentsList) {
                    if (!agent?.id || seenAgents.has(agent.id)) continue;
                    seenAgents.add(agent.id);
                    await ensureReadFileAllowed(config, agent.id);
                }
                if (!seenAgents.has("main")) await ensureReadFileAllowed(config, "main");
            } else {
                await ensureReadFileAllowed(config, agentId);
            }
            const defer = _url.searchParams?.get("defer") === "1";
            if (defer) {
                stageConfig(config, (body.enabled ? "Enable" : "Disable") + " skill: " + dirName);
            } else {
                writeConfig(config);
            }
        }

        // Sync SKILLS.md
        if (isGlobalManagedToggle) syncSkillsToAllWorkspaces(config);
        else syncSkillsToWorkspace(agentId, config);
        json(res, 200, { ok: true, deferred: body.enabled && _url.searchParams?.get("defer") === "1" });
        return true;
    }

    return false;
}

// ─── Helper: resolve skill directory path ───
function resolveSkillDir(agent: any, dirName: string, scope: string): string {
    if (scope === "managed") return join(OPENCLAW_DIR, "skills", dirName);
    // Default: workspace
    const workspace = getAgentWorkspace(agent);
    return join(workspace, "skills", dirName);
}

// ─── Helper: ensure the read tool is available for an agent ───
// Skills require the read tool so the LLM can load SKILL.md files.
// We query the gateway CLI to discover the actual tool name rather than
// hardcoding it, since the gateway's internal name may differ across versions.
async function resolveReadToolName(): Promise<string> {
    try {
        const out = await execAsync("openclaw tools list --json", { timeout: 8000 });
        const tools = JSON.parse(out.trim());
        if (Array.isArray(tools)) {
            for (const t of tools) {
                const id = typeof t === "string" ? t : (t.id || t.name || "");
                // The pi-coding-agent built-in read tool
                if (id === "read") return "read";
            }
        }
    } catch { }
    // Default fallback — "read" is the pi-coding-agent built-in name
    return "read";
}

async function ensureReadFileAllowed(config: any, agentId: string): Promise<void> {
    const agents = config.agents?.list || [];
    const agent = agents.find((a: any) => a.id === agentId);
    if (!agent) return;
    if (!agent.tools) agent.tools = {};

    const readTool = await resolveReadToolName();

    // Remove from deny list if present (check both correct and legacy names)
    const deny: string[] = agent.tools.deny || [];
    const denyFiltered = deny.filter((t: string) => t !== readTool && t !== "read_file");
    if (denyFiltered.length !== deny.length) agent.tools.deny = denyFiltered;

    // Add to alsoAllow if not already present
    const also: string[] = agent.tools.alsoAllow || agent.tools.allow || [];
    if (!also.includes(readTool)) {
        // Also remove any legacy "read_file" entry while we're at it
        const cleaned = also.filter((t: string) => t !== "read_file");
        agent.tools.alsoAllow = [...cleaned, readTool];
    }
}
