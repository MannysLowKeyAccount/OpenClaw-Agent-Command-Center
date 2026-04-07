import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    parseBody,
    readConfig,
    writeConfig,
    getAgentWorkspace,
    OPENCLAW_DIR,
    execAsync,
} from "../api-utils.js";

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

// ─── Scan a skills directory for skill folders ───
function scanSkillsDir(dir: string, tier: string): any[] {
    if (!existsSync(dir)) return [];
    const skills: any[] = [];
    try {
        for (const entry of readdirSync(dir)) {
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

    // ─── GET /api/skills/:agentId — list all skills ───
    const listMatch = path.match(/^\/skills\/([^/]+)$/);
    if (listMatch && method === "GET") {
        const agentId = decodeURIComponent(listMatch[1]);
        const config = readConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;

        const workspace = getAgentWorkspace(agent);
        const wsSkillsDir = join(workspace, "skills");
        const managedSkillsDir = join(OPENCLAW_DIR, "skills");

        const wsSkills = scanSkillsDir(wsSkillsDir, "workspace");
        const managedSkills = scanSkillsDir(managedSkillsDir, "managed");

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

        // Merge enabled/disabled from config
        const entries = config.skills?.entries || {};
        const allSkills = [...wsSkills, ...managedSkills];
        for (const s of allSkills) {
            const entry = entries[s.dirName];
            s.enabled = entry?.enabled !== false; // default true
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
        if (!identifier?.trim()) return json(res, 400, { error: "identifier required" }), true;

        const config = readConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;

        const workspace = getAgentWorkspace(agent);
        let cmd: string;
        if (source === "clawhub") {
            const targetDir = scope === "managed" ? join(OPENCLAW_DIR, "skills") : join(workspace, "skills");
            if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
            cmd = `clawhub install ${identifier.trim()} --workdir "${targetDir}"`;
        } else {
            // skills.sh or github direct
            const globalFlag = scope === "managed" ? " --global" : "";
            cmd = `npx skills add ${identifier.trim()} --agent openclaw${globalFlag} -y`;
        }

        try {
            await execAsync(cmd, { timeout: 60000 });
            json(res, 200, { ok: true });
        } catch (err: any) {
            json(res, 500, { error: err.message || "Install failed" });
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
        const config = readConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;

        const skillDir = resolveSkillDir(agent, dirName, scope);
        const skillMdPath = join(skillDir, "SKILL.md");
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

        const config = readConfig();
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
        writeConfig(config);

        json(res, 200, { ok: true });
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

        const config = readConfig();
        const agentsList = config.agents?.list || [];
        let agent = agentsList.find((a: any) => a.id === agentId);
        if (!agent && agentId === "main") agent = { id: "main" };
        if (!agent) return json(res, 404, { error: "Agent not found" }), true;

        const skillDir = resolveSkillDir(agent, dirName, scope);
        if (!existsSync(skillDir)) return json(res, 404, { error: "Skill not found" }), true;

        rmSync(skillDir, { recursive: true, force: true });
        json(res, 200, { ok: true });
        return true;
    }

    // ─── PATCH /api/skills/:agentId/:dirName — toggle enabled ───
    const patchMatch = path.match(/^\/skills\/([^/]+)\/([^/]+)$/);
    if (patchMatch && method === "PATCH") {
        const agentId = decodeURIComponent(patchMatch[1]);
        const dirName = decodeURIComponent(patchMatch[2]);
        if (!isSafeDirName(dirName)) return json(res, 403, { error: "Invalid skill name" }), true;

        const body = await parseBody(req);
        const config = readConfig();
        if (!config.skills) config.skills = {};
        if (!config.skills.entries) config.skills.entries = {};
        if (!config.skills.entries[dirName]) config.skills.entries[dirName] = {};
        config.skills.entries[dirName].enabled = !!body.enabled;

        // When enabling a skill, ensure read_file is available for the agent
        // (skills require the read tool to be loaded by the LLM)
        if (body.enabled) {
            await ensureReadFileAllowed(config, agentId);
        }

        writeConfig(config);
        json(res, 200, { ok: true });
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
