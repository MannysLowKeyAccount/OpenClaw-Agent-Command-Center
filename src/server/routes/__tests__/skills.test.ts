import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

let mockConfig: any = { agents: { list: [{ id: "main" }] } };
let mockSkillsConfigFile = "{}";
let mockPendingDestructiveOps: any[] = [];
let mockPendingSkillOps: any[] = [];
let mockPendingSkillsConfig: any = null;
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();

function parentDir(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx > 0 ? path.slice(0, idx) : "/";
}

function markDir(path: string): void {
    let cur = path;
    while (cur && cur !== "/") {
        mockDirs.add(cur);
        cur = parentDir(cur);
    }
}

function clearMockFs(): void {
    mockFiles.clear();
    mockDirs.clear();
    markDir("/tmp");
    markDir("/tmp/openclaw");
    markDir("/tmp/openclaw/dashboard");
    markDir("/tmp/openclaw/skills");
}

function removePath(path: string): void {
    mockFiles.delete(path);
    mockDirs.delete(path);
    for (const key of [...mockFiles.keys()]) {
        if (key === path || key.startsWith(path + "/")) mockFiles.delete(key);
    }
    for (const key of [...mockDirs]) {
        if (key === path || key.startsWith(path + "/")) mockDirs.delete(key);
    }
}

function copyPath(src: string, dest: string): void {
    markDir(parentDir(dest));
    if (mockDirs.has(src)) {
        markDir(dest);
        for (const dir of [...mockDirs]) {
            if (dir === src || dir.startsWith(src + "/")) {
                const rel = dir.slice(src.length);
                if (rel) mockDirs.add(dest + rel);
            }
        }
        for (const [file, content] of [...mockFiles.entries()]) {
            if (file === src || file.startsWith(src + "/")) {
                const rel = file.slice(src.length);
                mockFiles.set(dest + rel, content);
            }
        }
    } else if (mockFiles.has(src)) {
        mockFiles.set(dest, mockFiles.get(src)!);
    }
}

vi.mock("../../api-utils.js", () => {
    return {
        json: vi.fn((res: any, status: number, data: any) => {
            res.statusCode = status;
            res._body = data;
        }),
        parseBody: vi.fn(async () => ({})),
        readConfig: vi.fn(() => JSON.parse(JSON.stringify(mockConfig))),
        readEffectiveConfig: vi.fn(() => JSON.parse(JSON.stringify(mockConfig))),
        readEffectiveSkillsConfig: vi.fn(() => JSON.parse(JSON.stringify(mockPendingSkillsConfig ?? JSON.parse(mockSkillsConfigFile)))) ,
        writeConfig: vi.fn(),
        stageConfig: vi.fn(),
        stagePendingSkillsConfig: vi.fn((cfg: any) => { mockPendingSkillsConfig = JSON.parse(JSON.stringify(cfg)); }),
        stagePendingDestructiveOp: vi.fn((op: any) => { mockPendingDestructiveOps.push(op); }),
        getPendingDestructiveOps: vi.fn(() => JSON.parse(JSON.stringify(mockPendingDestructiveOps))),
        stagePendingSkillOp: vi.fn((op: any) => { mockPendingSkillOps.push(op); }),
        getPendingSkillOps: vi.fn(() => JSON.parse(JSON.stringify(mockPendingSkillOps))),
        getAgentWorkspace: vi.fn((a: any) => `/tmp/ws/${a.id}`),
        OPENCLAW_DIR: "/tmp/openclaw",
        DASHBOARD_CONFIG_DIR: "/tmp/openclaw/dashboard",
        execAsync: vi.fn(async () => ""),
        execFileAsync: vi.fn(async () => ""),
        shellEsc: vi.fn((s: string) => s.replace(/"/g, '\\"').replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/`/g, "\\`")),
    };
});

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        existsSync: vi.fn((p: string) => mockFiles.has(p) || mockDirs.has(p) || p === "/tmp/openclaw/dashboard/skills-config.json" || p.endsWith("/SKILL.md") || p.endsWith("/SKILLS.md")),
        readdirSync: vi.fn((p: string) => {
            const entries = new Set<string>();
            for (const dir of mockDirs) {
                if (dir.startsWith(p + "/")) {
                    const rel = dir.slice(p.length + 1);
                    if (rel && !rel.includes("/")) entries.add(rel);
                }
            }
            return [...entries];
        }),
        readFileSync: vi.fn((p: string) => {
            if (p === "/tmp/openclaw/dashboard/skills-config.json") return mockPendingSkillsConfig ? JSON.stringify(mockPendingSkillsConfig, null, 2) : mockSkillsConfigFile;
            return mockFiles.get(p) || "";
        }),
        writeFileSync: vi.fn((p: string, data: any) => {
            if (p === "/tmp/openclaw/dashboard/skills-config.json") {
                mockSkillsConfigFile = String(data);
                mockPendingSkillsConfig = null;
                return;
            }
            mockFiles.set(p, String(data));
            markDir(parentDir(p));
        }),
        mkdirSync: vi.fn((p: string) => markDir(p)),
        rmSync: vi.fn((p: string) => removePath(p)),
        cpSync: vi.fn((src: string, dest: string) => copyPath(src, dest)),
        statSync: vi.fn((p: string) => ({ isDirectory: () => mockDirs.has(p) || (!p.endsWith(".md") && (p.includes("/skills/") || p.includes("/.tmp-skill-") || p.includes("/workspace"))) })),
    };
});

import { handleSkillRoutes } from "../skills.js";

function mockReq(method: string): IncomingMessage {
    return { method } as IncomingMessage;
}

function mockRes(): ServerResponse & { _body: any } {
    return { statusCode: 0, _body: null } as unknown as ServerResponse & { _body: any };
}

describe("skills routes — install validation", () => {
    beforeEach(() => {
        mockConfig = { agents: { list: [{ id: "main" }] } };
        mockSkillsConfigFile = "{}";
        mockPendingDestructiveOps = [];
        mockPendingSkillOps = [];
        mockPendingSkillsConfig = null;
        clearMockFs();
        vi.clearAllMocks();
    });

    async function postInstall(body: any) {
        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue(body);
        const req = mockReq("POST");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/main/install"), "/skills/main/install");
        return { handled, res };
    }

    it("rejects invalid source", async () => {
        const { handled, res } = await postInstall({ source: "bad", identifier: "foo" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
        expect(res._body.error).toContain("source must be");
    });

    it("rejects empty identifier", async () => {
        const { handled, res } = await postInstall({ source: "clawhub", identifier: "   " });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
        expect(res._body.error).toContain("identifier required");
    });

    it("rejects clawhub identifier with path traversal", async () => {
        const { handled, res } = await postInstall({ source: "clawhub", identifier: "../foo" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
        expect(res._body.error).toContain("slug");
    });

    it("rejects skills.sh identifier not in owner/repo form", async () => {
        const { handled, res } = await postInstall({ source: "skills.sh", identifier: "just-owner" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
        expect(res._body.error).toContain("owner/repo");
    });

    it("rejects github identifier without https and github.com", async () => {
        const { handled, res } = await postInstall({ source: "github", identifier: "owner/repo" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
        expect(res._body.error).toContain("GitHub URL");
    });

    it("accepts valid clawhub slug", async () => {
        const { execAsync } = await import("../../api-utils.js");
        const { handled, res } = await postInstall({ source: "clawhub", identifier: "my-skill_123" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(execAsync).toHaveBeenCalled();
    });

    it("accepts valid skills.sh owner/repo", async () => {
        const { execFileAsync } = await import("../../api-utils.js");
        const { handled, res } = await postInstall({ source: "skills.sh", identifier: "owner/repo-name" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(execFileAsync).toHaveBeenCalledWith("npx", expect.arrayContaining(["skills", "add", "owner/repo-name"]), expect.anything());
    });

    it("accepts valid github https URL", async () => {
        const { execFileAsync } = await import("../../api-utils.js");
        const { handled, res } = await postInstall({ source: "github", identifier: "https://github.com/owner/repo" });
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(execFileAsync).toHaveBeenCalledWith("npx", expect.arrayContaining(["skills", "add", "https://github.com/owner/repo"]), expect.anything());
    });
});

describe("skills routes — global list", () => {
    async function mockManagedSkillFiles() {
        const { readdirSync, readFileSync } = await import("node:fs");
        (readdirSync as any).mockImplementation((p: string) => {
            if (p === "/tmp/openclaw/skills") return ["shared-skill"];
            return [];
        });
        (readFileSync as any).mockImplementation((p: string) => {
            if (p === "/tmp/openclaw/skills/shared-skill/SKILL.md") {
                return "---\nname: Shared Skill\ndescription: shared\n---\n\nbody";
            }
            return "";
        });
    }

    it("returns managed skills without agent context", async () => {
        const { readdirSync, readFileSync } = await import("node:fs");
        (readdirSync as any).mockReturnValue(["my-skill"]);
        (readFileSync as any).mockReturnValue("---\nname: My Skill\ndescription: test\n---\n\nbody");
        const req = mockReq("GET");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills"), "/skills");
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.skills).toHaveLength(1);
        expect(res._body.skills[0].name).toBe("My Skill");
        expect(res._body.skills[0].tier).toBe("managed");
        expect(res._body.skills[0].enabled).toBe(false);
        expect(res._body.skills[0].enabledState).toBe("disabled");
        expect(res._body.skills[0].agentEnabledCount).toBe(0);
    });

    it("marks managed skills as partially enabled when only some agents have them on", async () => {
        mockConfig = {
            agents: { list: [{ id: "main" }, { id: "alpha" }] },
        };
        mockSkillsConfigFile = JSON.stringify({
            alpha: {
                "shared-skill": { enabled: true },
            },
        });

        const { readdirSync, readFileSync } = await import("node:fs");
        (readdirSync as any).mockReturnValue(["shared-skill"]);
        (readFileSync as any).mockImplementation((p: string) => {
            if (p === "/tmp/openclaw/skills/shared-skill/SKILL.md") {
                return "---\nname: Shared Skill\ndescription: shared\n---\n\nbody";
            }
            if (p === "/tmp/openclaw/dashboard/skills-config.json") {
                return mockSkillsConfigFile;
            }
            return "";
        });

        const req = mockReq("GET");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills"), "/skills");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.skills[0].enabled).toBe(false);
        expect(res._body.skills[0].enabledState).toBe("partial");
        expect(res._body.skills[0].agentEnabledCount).toBe(1);
    });

    it("refreshes every agent workspace when a managed skill is installed", async () => {
        mockConfig = {
            agents: { list: [{ id: "main" }, { id: "alpha" }, { id: "beta" }] },
        };
        mockSkillsConfigFile = JSON.stringify({
            __globalManagedSkills: {
                "shared-skill": { enabled: true },
            },
        });

        const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
        (readdirSync as any).mockImplementation((p: string) => {
            if (p === "/tmp/openclaw/skills") return ["shared-skill"];
            return [];
        });
        (readFileSync as any).mockImplementation((p: string) => {
            if (p === "/tmp/openclaw/dashboard/skills-config.json") {
                return mockSkillsConfigFile;
            }
            if (p === "/tmp/openclaw/skills/shared-skill/SKILL.md") {
                return "---\nname: Shared Skill\ndescription: shared\n---\n\nbody";
            }
            return "";
        });

        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ source: "clawhub", identifier: "shared-skill", scope: "managed" });

        const req = mockReq("POST");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/main/install"), "/skills/main/install");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        const skillMdWrites = (writeFileSync as any).mock.calls
            .map((call: any[]) => call[0])
            .filter((p: string) => p.endsWith("/SKILLS.md"));
        expect(skillMdWrites).toEqual(expect.arrayContaining([
            "/tmp/ws/main/SKILLS.md",
            "/tmp/ws/alpha/SKILLS.md",
            "/tmp/ws/beta/SKILLS.md",
        ]));
    });

    it("fans out managed skill edits to every workspace", async () => {
        mockConfig = {
            agents: { list: [{ id: "main" }, { id: "alpha" }, { id: "beta" }] },
        };
        mockSkillsConfigFile = JSON.stringify({
            __globalManagedSkills: {
                "shared-skill": { enabled: true },
            },
        });
        const { readFileSync, writeFileSync } = await import("node:fs");
        (readFileSync as any).mockImplementation((p: string) => {
            if (p === "/tmp/openclaw/dashboard/skills-config.json") {
                return mockSkillsConfigFile;
            }
            if (p === "/tmp/openclaw/skills/shared-skill/SKILL.md") {
                return "---\nname: Shared Skill\ndescription: shared\n---\n\nbody";
            }
            return "";
        });

        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ scope: "managed", content: "---\nname: Shared Skill\ndescription: shared\n---\n\nupdated" });

        const req = mockReq("PUT");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/main/shared-skill"), "/skills/main/shared-skill");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        const skillMdWrites = (writeFileSync as any).mock.calls
            .map((call: any[]) => call[0])
            .filter((p: string) => p.endsWith("/SKILLS.md"));
        expect(skillMdWrites).toEqual(expect.arrayContaining([
            "/tmp/ws/main/SKILLS.md",
            "/tmp/ws/alpha/SKILLS.md",
            "/tmp/ws/beta/SKILLS.md",
        ]));
    });

    it("stores managed toggles globally and propagates to every workspace", async () => {
        mockConfig = {
            agents: { list: [{ id: "main" }, { id: "alpha" }, { id: "beta" }] },
        };
        let persistedSkillsConfig = "{}";
        const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
        (readdirSync as any).mockImplementation((p: string) => {
            if (p === "/tmp/openclaw/skills") return ["shared-skill"];
            if (p.endsWith("/skills")) return [];
            return [];
        });
        (readFileSync as any).mockImplementation((p: string) => {
            if (p === "/tmp/openclaw/skills/shared-skill/SKILL.md") {
                return "---\nname: Shared Skill\ndescription: shared\n---\n\nbody";
            }
            if (p === "/tmp/openclaw/dashboard/skills-config.json") {
                return persistedSkillsConfig;
            }
            return "";
        });
        (writeFileSync as any).mockImplementation((p: string, data: any) => {
            if (p === "/tmp/openclaw/dashboard/skills-config.json") {
                persistedSkillsConfig = String(data);
                mockSkillsConfigFile = String(data);
            }
        });
        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ scope: "managed", enabled: false });

        const req = mockReq("PATCH");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/main/shared-skill"), "/skills/main/shared-skill");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(persistedSkillsConfig)).toEqual({
            __globalManagedSkills: {
                "shared-skill": { enabled: false },
            },
        });
        const skillMdWrites = (writeFileSync as any).mock.calls
            .map((call: any[]) => call[0])
            .filter((p: string) => p.endsWith("/SKILLS.md"));
        expect(skillMdWrites).toEqual(expect.arrayContaining([
            "/tmp/ws/main/SKILLS.md",
            "/tmp/ws/alpha/SKILLS.md",
            "/tmp/ws/beta/SKILLS.md",
        ]));

        const alphaReq = mockReq("GET");
        const alphaRes = mockRes();
        const alphaHandled = await handleSkillRoutes(alphaReq, alphaRes, new URL("http://localhost/api/skills/alpha"), "/skills/alpha");
        expect(alphaHandled).toBe(true);
        expect(alphaRes._body.skills.find((s: any) => s.dirName === "shared-skill")?.enabled).toBe(false);

        const globalReq = mockReq("GET");
        const globalRes = mockRes();
        const globalHandled = await handleSkillRoutes(globalReq, globalRes, new URL("http://localhost/api/skills"), "/skills");
        expect(globalHandled).toBe(true);
        expect(globalRes._body.skills.find((s: any) => s.dirName === "shared-skill")?.enabled).toBe(false);
    });

    it("keeps agent-scoped toggles per-agent when scope is omitted", async () => {
        mockConfig = {
            agents: { list: [{ id: "main" }, { id: "alpha" }] },
        };
        let persistedSkillsConfig = "{}";
        const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
        (readdirSync as any).mockImplementation((p: string) => {
            if (p === "/tmp/openclaw/skills") return ["shared-skill"];
            if (p.endsWith("/skills")) return [];
            return [];
        });
        (readFileSync as any).mockImplementation((p: string) => {
            if (p === "/tmp/openclaw/skills/shared-skill/SKILL.md") {
                return "---\nname: Shared Skill\ndescription: shared\n---\n\nbody";
            }
            if (p === "/tmp/openclaw/dashboard/skills-config.json") {
                return persistedSkillsConfig;
            }
            return "";
        });
        (writeFileSync as any).mockImplementation((p: string, data: any) => {
            if (p === "/tmp/openclaw/dashboard/skills-config.json") {
                persistedSkillsConfig = String(data);
                mockSkillsConfigFile = String(data);
            }
        });
        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ enabled: true });

        const req = mockReq("PATCH");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/alpha/shared-skill"), "/skills/alpha/shared-skill");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(persistedSkillsConfig).alpha).toEqual({
            "shared-skill": { enabled: true },
        });
    });
});

describe("skills routes — deferred managed enable cache", () => {
    it("resolves the read tool name once while enabling a managed skill for many agents", async () => {
        mockConfig = {
            agents: { list: [{ id: "main" }, { id: "alpha" }, { id: "beta" }] },
        };

        const { execAsync, parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ enabled: true, scope: "managed" });

        const req = mockReq("PATCH");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/main/shared-skill?defer=1"), "/skills/main/shared-skill");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body).toEqual({ ok: true, deferred: true });
        expect((execAsync as any).mock.calls.filter((call: any[]) => String(call[0]).includes("openclaw tools list --json"))).toHaveLength(1);
    });
});

describe("skills routes — deferred staged changes", () => {
    beforeEach(() => {
        mockConfig = { agents: { list: [{ id: "main" }] } };
        mockSkillsConfigFile = "{}";
        mockPendingDestructiveOps = [];
        mockPendingSkillOps = [];
        mockPendingSkillsConfig = null;
        clearMockFs();
        vi.clearAllMocks();
    });

    it("stages toggles without writing live files and reads staged state", async () => {
        mockSkillsConfigFile = JSON.stringify({
            __globalManagedSkills: {
                "shared-skill": { enabled: true },
            },
        });
        markDir("/tmp/openclaw/skills/shared-skill");
        mockFiles.set("/tmp/openclaw/skills/shared-skill/SKILL.md", "---\nname: Shared Skill\n---\n\nbody");

        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ scope: "managed", enabled: false });

        const req = mockReq("PATCH");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/main/shared-skill?defer=1"), "/skills/main/shared-skill");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mockSkillsConfigFile).toContain('"enabled":true');
        expect(mockPendingSkillsConfig).toEqual({
            __globalManagedSkills: {
                "shared-skill": { enabled: false },
            },
        });
        expect(mockPendingSkillOps).toEqual(expect.arrayContaining([
            expect.objectContaining({
                action: "toggle",
                agentId: "__global__",
                dirName: "shared-skill",
                scope: "managed",
            }),
        ]));

        const listReq = mockReq("GET");
        const listRes = mockRes();
        await handleSkillRoutes(listReq, listRes, new URL("http://localhost/api/skills"), "/skills");
        expect(listRes._body.skills.find((s: any) => s.dirName === "shared-skill")?.enabled).toBe(false);
        expect(listRes._body.skills.find((s: any) => s.dirName === "shared-skill")?.pending).toBe(true);
        expect(listRes._body.skills.find((s: any) => s.dirName === "shared-skill")?.pendingAction).toBe("toggle");
    });

    it("stages agent-scoped toggles only for that agent", async () => {
        mockSkillsConfigFile = JSON.stringify({
            alpha: {
                "shared-skill": { enabled: false },
            },
        });
        markDir("/tmp/openclaw/skills/shared-skill");
        mockFiles.set("/tmp/openclaw/skills/shared-skill/SKILL.md", "---\nname: Shared Skill\n---\n\nbody");

        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ enabled: true });

        const req = mockReq("PATCH");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/alpha/shared-skill?defer=1"), "/skills/alpha/shared-skill");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mockPendingSkillsConfig).toEqual({
            alpha: {
                "shared-skill": { enabled: true },
            },
        });
        expect(mockPendingSkillOps).toEqual(expect.arrayContaining([
            expect.objectContaining({
                action: "toggle",
                agentId: "alpha",
                dirName: "shared-skill",
                scope: "workspace",
            }),
        ]));
    });

    it("stages installs without writing live files and exposes staged reads", async () => {
        const stageRoot = "/tmp/openclaw/.tmp-skill-install";
        markDir(stageRoot);
        markDir(`${stageRoot}/new-skill`);
        mockFiles.set(`${stageRoot}/new-skill/SKILL.md`, "---\nname: New Skill\ndescription: staged\n---\n\nbody");

        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ source: "clawhub", identifier: "new-skill", scope: "managed" });

        const req = mockReq("POST");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/main/install?defer=1"), "/skills/main/install");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mockFiles.has("/tmp/openclaw/skills/new-skill/SKILL.md")).toBe(false);
    });

    it("stages deletes without removing live files or rewriting SKILLS.md", async () => {
        markDir("/tmp/ws/main/skills/helper");
        mockFiles.set("/tmp/ws/main/skills/helper/SKILL.md", "---\nname: Helper\n---\n\nbody");
        mockFiles.set("/tmp/ws/main/SKILLS.md", "# Active Skills\n\n- helper");

        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({});

        const req = mockReq("DELETE");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/main/helper?scope=workspace&defer=1"), "/skills/main/helper");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mockFiles.has("/tmp/ws/main/skills/helper/SKILL.md")).toBe(true);
        expect(mockFiles.get("/tmp/ws/main/SKILLS.md")).toBe("# Active Skills\n\n- helper");

        const readReq = mockReq("GET");
        const readRes = mockRes();
        await handleSkillRoutes(readReq, readRes, new URL("http://localhost/api/skills/main/helper?scope=workspace"), "/skills/main/helper");
        expect(readRes.statusCode).toBe(404);
    });

});
