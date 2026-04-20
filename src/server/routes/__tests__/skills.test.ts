import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

let mockConfig: any = { agents: { list: [{ id: "main" }] } };
let mockSkillsConfigFile = "{}";
let mockPendingDestructiveOps: any[] = [];

vi.mock("../../api-utils.js", () => {
    return {
        json: vi.fn((res: any, status: number, data: any) => {
            res.statusCode = status;
            res._body = data;
        }),
        parseBody: vi.fn(async () => ({})),
        readConfig: vi.fn(() => JSON.parse(JSON.stringify(mockConfig))),
        readEffectiveConfig: vi.fn(() => JSON.parse(JSON.stringify(mockConfig))),
        writeConfig: vi.fn(),
        stageConfig: vi.fn(),
        stagePendingDestructiveOp: vi.fn((op: any) => { mockPendingDestructiveOps.push(op); }),
        getPendingDestructiveOps: vi.fn(() => JSON.parse(JSON.stringify(mockPendingDestructiveOps))),
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
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => []),
        readFileSync: vi.fn((p: string) => {
            if (p === "/tmp/openclaw/dashboard/skills-config.json") return mockSkillsConfigFile;
            return "";
        }),
        writeFileSync: vi.fn((p: string, data: any) => {
            if (p === "/tmp/openclaw/dashboard/skills-config.json") {
                mockSkillsConfigFile = String(data);
            }
        }),
        mkdirSync: vi.fn(),
        rmSync: vi.fn(),
        statSync: vi.fn(() => ({ isDirectory: () => true })),
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
    });

    it("refreshes every agent workspace when a managed skill is installed", async () => {
        mockConfig = {
            agents: { list: [{ id: "main" }, { id: "alpha" }, { id: "beta" }] },
        };

        const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
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
        const { readFileSync, writeFileSync } = await import("node:fs");
        (readFileSync as any).mockImplementation((p: string) => {
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
            }
        });
        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ enabled: true });

        const req = mockReq("PATCH");
        const res = mockRes();
        const handled = await handleSkillRoutes(req, res, new URL("http://localhost/api/skills/alpha/shared-skill"), "/skills/alpha/shared-skill");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(persistedSkillsConfig)).toEqual({
            alpha: {
                "shared-skill": { enabled: true },
            },
        });
    });
});
