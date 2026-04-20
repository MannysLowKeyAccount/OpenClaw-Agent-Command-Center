import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoots: string[] = [];
var rootOpenclaw = "";
var rootDashboard = "";
let mockPendingDestructiveOps: any[] = [];

vi.mock("../../api-utils.js", () => {
        return {
            json: vi.fn(),
            parseBody: vi.fn(async () => ({})),
            readConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
            readEffectiveConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
            writeConfig: vi.fn(),
            stageConfig: vi.fn(),
            stagePendingDestructiveOp: vi.fn((op: any) => { mockPendingDestructiveOps.push(op); }),
            getPendingDestructiveOps: vi.fn(() => JSON.parse(JSON.stringify(mockPendingDestructiveOps))),
            getAgentWorkspace: vi.fn((a: any) => a.workspace),
            get OPENCLAW_DIR() { return rootOpenclaw; },
            get DASHBOARD_CONFIG_DIR() { return rootDashboard; },
            execAsync: vi.fn(async () => ""),
            execFileAsync: vi.fn(async () => ""),
            shellEsc: vi.fn((s: string) => s),
        };
    });

describe("syncSkillsToWorkspace", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "openclaw-skills-"));
        tempRoots.push(root);
        mockPendingDestructiveOps = [];

        const workspace = join(root, "workspace");
        const dashboard = join(root, "dashboard");
        const openclaw = join(root, "openclaw");
        mkdirSync(join(workspace, "main", "skills", "local-skill"), { recursive: true });
        mkdirSync(join(openclaw, "skills", "shared-skill"), { recursive: true });
        mkdirSync(dashboard, { recursive: true });
        rootOpenclaw = openclaw;
        rootDashboard = dashboard;

        writeFileSync(join(workspace, "main", "skills", "local-skill", "SKILL.md"), "---\nname: Local Skill\ndescription: local\n---\n\nbody", "utf-8");
        writeFileSync(join(openclaw, "skills", "shared-skill", "SKILL.md"), "---\nname: Shared Skill\ndescription: shared\n---\n\nbody", "utf-8");
        writeFileSync(join(dashboard, "skills-config.json"), JSON.stringify({ __globalManagedSkills: { "shared-skill": { enabled: false } } }), "utf-8");
    });

    afterEach(() => {
        while (tempRoots.length) {
            const dir = tempRoots.pop();
            if (dir) rmSync(dir, { recursive: true, force: true });
        }
    });

    it("omits disabled managed skills from workspace SKILLS.md", async () => {
        const { syncSkillsToWorkspace } = await import("../skills.js");
        syncSkillsToWorkspace("main", { agents: { list: [{ id: "main", workspace: join(root, "workspace", "main") }] } });

        const skillsMd = readFileSync(join(root, "workspace", "main", "SKILLS.md"), "utf-8");
        expect(skillsMd).toContain("Local Skill");
        expect(skillsMd).not.toContain("Shared Skill");
    });
});
