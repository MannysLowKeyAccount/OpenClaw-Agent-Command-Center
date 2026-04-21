import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Track mutable mock state ───
let mockConfig: any = {};
let mockStagedConfig: any = null;
let mockPendingDestructiveOps: any[] = [];
let mockPendingFileMutations: any[] = [];
let mockFlowDefs: Record<string, string> = {};
let mockFlowStates: Record<string, string> = {};
let mockFlowHistory: Record<string, string> = {};

// ─── Mock api-utils before importing agents ───
vi.mock("../../api-utils.js", () => {
    return {
        json: vi.fn((res: any, status: number, data: any) => {
            res.statusCode = status;
            res._body = data;
        }),
        parseBody: vi.fn(async () => ({})),
        readConfig: vi.fn(() => JSON.parse(JSON.stringify(mockConfig))),
        readEffectiveConfig: vi.fn(() => {
            if (mockStagedConfig) return JSON.parse(JSON.stringify(mockStagedConfig));
            return JSON.parse(JSON.stringify(mockConfig));
        }),
        writeConfig: vi.fn((cfg: any) => {
            mockConfig = JSON.parse(JSON.stringify(cfg));
        }),
        stageConfig: vi.fn((cfg: any, desc?: string) => {
            mockStagedConfig = JSON.parse(JSON.stringify(cfg));
        }),
        stagePendingDestructiveOp: vi.fn((op: any) => { mockPendingDestructiveOps.push(op); }),
        stagePendingFileMutation: vi.fn((op: any) => { mockPendingFileMutations.push(op); }),
        getPendingDestructiveOps: vi.fn(() => JSON.parse(JSON.stringify(mockPendingDestructiveOps))),
        getPendingFileMutationContent: vi.fn(() => undefined),
        hasPendingFileMutation: vi.fn(() => false),
        getConfigError: vi.fn(() => null),
        readDashboardConfig: vi.fn(() => ({})),
        writeDashboardConfig: vi.fn(),
        execAsync: vi.fn(async () => ""),
        execFileAsync: vi.fn(async () => ""),
        resolveHome: vi.fn((p: string) => p.replace("~", "/tmp/fakehome")),
        tryReadFile: vi.fn(() => null),
        getAgentWorkspace: vi.fn((a: any) => `/tmp/ws/${a.id}`),
        getAgentDir: vi.fn((a: any) => `/tmp/agent/${a.id}`),
        getAgentSessionsDir: vi.fn((id: string) => `/tmp/sessions/${id}`),
        AGENTS_STATE_DIR: "/tmp/fake-agents-state",
        DASHBOARD_CONFIG_PATH: "/tmp/fake-dashboard/dashboard-config.json",
        WORKSPACE_MD_FILES: ["SOUL.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md", "BOOTSTRAP.md"],
        DASHBOARD_FLOW_DEFS_DIR: "/tmp/fake-flows/definitions",
        DASHBOARD_FLOW_STATE_DIR: "/tmp/fake-flows/state",
        DASHBOARD_FLOW_HISTORY_DIR: "/tmp/fake-flows/history",
    };
});

// Mock node:fs to prevent real filesystem access and track flow defs / states
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        existsSync: vi.fn((p: string) => {
            if (p === "/tmp/fake-flows/definitions") return true;
            if (p === "/tmp/fake-flows/state") return true;
            if (p === "/tmp/fake-flows/history") return true;
            return Object.prototype.hasOwnProperty.call(mockFlowDefs, p)
                || Object.prototype.hasOwnProperty.call(mockFlowStates, p)
                || Object.prototype.hasOwnProperty.call(mockFlowHistory, p);
        }),
        readFileSync: vi.fn((p: string, enc: string) => {
            if (Object.prototype.hasOwnProperty.call(mockFlowDefs, p)) return mockFlowDefs[p];
            if (Object.prototype.hasOwnProperty.call(mockFlowStates, p)) return mockFlowStates[p];
            if (Object.prototype.hasOwnProperty.call(mockFlowHistory, p)) return mockFlowHistory[p];
            throw new Error("ENOENT");
        }),
        writeFileSync: vi.fn((p: string, content: string) => {
            if (p.startsWith("/tmp/fake-flows/state/")) {
                mockFlowStates[p] = content;
            } else if (p.startsWith("/tmp/fake-flows/history/")) {
                mockFlowHistory[p] = content;
            } else {
                mockFlowDefs[p] = content;
            }
        }),
        mkdirSync: vi.fn(),
        unlinkSync: vi.fn((p: string) => {
            delete mockFlowDefs[p];
            delete mockFlowStates[p];
            delete mockFlowHistory[p];
        }),
        readdirSync: vi.fn((p: string) => {
            if (p === "/tmp/fake-flows/definitions") {
                return Object.keys(mockFlowDefs).map((k) => k.replace("/tmp/fake-flows/definitions/", ""));
            }
            if (p === "/tmp/fake-flows/state") {
                return Object.keys(mockFlowStates).map((k) => k.replace("/tmp/fake-flows/state/", ""));
            }
            if (p === "/tmp/fake-flows/history") {
                return Object.keys(mockFlowHistory).map((k) => k.replace("/tmp/fake-flows/history/", ""));
            }
            return [];
        }),
        statSync: vi.fn(() => { throw new Error("ENOENT"); }),
    };
});

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
    stat: vi.fn(async () => { throw new Error("ENOENT"); }),
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => { throw new Error("ENOENT"); }),
}));

// Mock orchestrator codegen
vi.mock("../../../orchestrator/codegen.js", () => ({
    parseFlowDefinitionFile: vi.fn((content: string) => {
        // Simple parser for test fixtures
        const controllerMatch = content.match(/controllerId:\s*"([^"]+)"/);
        if (!controllerMatch) return null;
        const [, controllerId] = controllerMatch;
        const parts = controllerId.match(/^(.+)\/start_(.+)$/);
        if (!parts) return null;
        const [, agentId, name] = parts;

        const steps: any[] = [];
        const runTaskRegex = /flow\.runTask<[^>]*>\(\{([\s\S]*?)\}\);/g;
        let m: RegExpExecArray | null;
        while ((m = runTaskRegex.exec(content)) !== null) {
            const block = m[1];
            const idMatch = block.match(/id:\s*"([^"]+)"/);
            const agentIdMatch = block.match(/agentId:\s*"([^"]+)"/);
            if (idMatch && agentIdMatch) {
                steps.push({ id: idMatch[1], agentId: agentIdMatch[1], description: "", humanIntervention: false });
            }
        }
        if (steps.length === 0) return null;
        return { name, description: "", agentId, steps };
    }),
    generateFlowDefinitionFile: vi.fn((flow: any) => {
        return `// controllerId: "${flow.agentId}/start_${flow.name}"
${flow.steps.map((s: any) => `flow.runTask<{ status: string }>({ id: "${s.id}", agentId: "${s.agentId}", input: {} });`).join("\n")}
`;
    }),
    generateAgentsMdSnippet: vi.fn(() => ""),
}));

// ─── Helpers ───
function createMockReq(method: string, body?: any): IncomingMessage {
    const req = { method } as unknown as IncomingMessage;
    if (body) {
        (req as any)._body = JSON.stringify(body);
    }
    return req;
}

function createMockRes(): ServerResponse & { _body: any } {
    return {
        statusCode: 0,
        _body: undefined,
        setHeader: vi.fn(),
        end: vi.fn(),
    } as unknown as ServerResponse & { _body: any };
}

async function parseBodyMock(req: IncomingMessage): Promise<any> {
    const body = (req as any)._body;
    return body ? JSON.parse(body) : {};
}

// ─── Tests ───
describe("DELETE /api/agents/{id}", () => {
    let handleAgentRoutes: typeof import("../agents.js").handleAgentRoutes;

    beforeEach(async () => {
        vi.resetModules();
        mockConfig = {
            agents: {
                list: [
                    { id: "alpha", name: "Alpha" },
                    { id: "beta", name: "Beta", subagents: { allowAgents: ["alpha", "gamma"] } },
                    { id: "gamma", name: "Gamma", subagents: { allowAgents: ["alpha"] } },
                ],
            },
            bindings: [
                { agentId: "alpha", match: { channel: "discord" } },
                { agentId: "beta", match: { channel: "slack" } },
            ],
            routing: {
                bindings: [
                    { agentId: "alpha", match: { channel: "email" } },
                    { agentId: "gamma", match: { channel: "web" } },
                ],
            },
            tools: {
                agentToAgent: { allow: ["alpha", "beta"] },
            },
        };
        mockStagedConfig = null;
        mockPendingDestructiveOps = [];
        mockPendingFileMutations = [];
        mockFlowDefs = {};
        mockFlowStates = {};
        mockFlowHistory = {};

        const mod = await import("../agents.js");
        handleAgentRoutes = mod.handleAgentRoutes;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("removes the agent from agents.list and bindings", async () => {
        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        const handled = await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.ok).toBe(true);
        expect(mockConfig.agents.list.some((a: any) => a.id === "alpha")).toBe(false);
        expect(mockConfig.bindings.some((b: any) => b.agentId === "alpha")).toBe(false);
        expect(mockConfig.routing.bindings.some((b: any) => b.agentId === "alpha")).toBe(false);
    });

    it("removes deleted agent from other agents' subagents.allowAgents", async () => {
        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        const beta = mockConfig.agents.list.find((a: any) => a.id === "beta");
        expect(beta.subagents.allowAgents).toEqual(["gamma"]);

        const gamma = mockConfig.agents.list.find((a: any) => a.id === "gamma");
        expect(gamma.subagents).toBeUndefined();
    });

    it("removes deleted agent from tools.agentToAgent.allow", async () => {
        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(mockConfig.tools.agentToAgent.allow).toEqual(["beta"]);
    });

    it("cleans up tools.agentToAgent entirely when allow becomes empty", async () => {
        mockConfig.tools.agentToAgent.allow = ["alpha"];
        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(mockConfig.tools).toBeUndefined();
    });

    it("stages config when defer=1 without mutating flow definitions", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/deferred.flow.ts"] =
            `// controllerId: "beta/start_deferred"\n` +
            `flow.runTask<{ status: string }>({ id: "step1", agentId: "alpha", input: {} });\n`;
        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha?defer=1");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(res.statusCode).toBe(200);
        expect(res._body.deferred).toBe(true);
        expect(mockStagedConfig).not.toBeNull();
        expect(mockStagedConfig.agents.list.some((a: any) => a.id === "alpha")).toBe(false);
        expect(mockFlowDefs["/tmp/fake-flows/definitions/deferred.flow.ts"]).toContain('agentId: "alpha"');
        expect(res._body.warnings.some((w: string) => w.includes("Apply & Restart"))).toBe(true);
        expect(mockPendingDestructiveOps.some((op: any) => op.kind === "agent" && op.agentId === "alpha")).toBe(true);
    });

    it("stages workspace scaffolding when creating an agent with defer=1", async () => {
        const { parseBody } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ id: "delta", name: "Delta" });

        const req = createMockReq("POST");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents?defer=1");

        await handleAgentRoutes(req, res, url, "/agents");

        expect(res.statusCode).toBe(201);
        expect(res._body.deferred).toBe(true);
        expect(mockFlowDefs).toEqual({});
        expect(mockPendingFileMutations).toHaveLength(5);
        expect(mockPendingFileMutations.every((op: any) => op.kind === "workspace-file")).toBe(true);
        expect(mockPendingFileMutations.some((op: any) => op.content.includes("# SOUL"))).toBe(true);
    });

    it("auto-stages discord allowed channels for exact bindings and preserves manual entries", async () => {
        mockConfig = {
            channels: {
                discord: {
                    accounts: {
                        default: {
                            guilds: {
                                guild1: {
                                    channels: {
                                        manual: { enabled: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            bindings: [],
        };
        const { parseBody } = await import("../../api-utils.js");
        const req = createMockReq("PUT");
        const res = createMockRes();
        const url = new URL("http://localhost/api/bindings?defer=1");

        (parseBody as any).mockResolvedValue({
            bindings: [
                { agentId: "alpha", match: { channel: "discord", accountId: "default", guildId: "guild1", peer: { kind: "channel", id: "chan1" } } },
                { agentId: "beta", match: { channel: "discord", accountId: "*", guildId: "guild1", peer: { kind: "channel", id: "chan2" } } },
                { agentId: "gamma", match: { channel: "discord", accountId: "default", peer: { kind: "channel", id: "chan3" } } },
            ],
        });

        await handleAgentRoutes(req, res, url, "/bindings");

        expect(res.statusCode).toBe(200);
        expect(res._body.deferred).toBe(true);
        expect(mockStagedConfig.channels.discord.accounts.default.guilds.guild1.channels.chan1).toEqual({ enabled: true });
        expect(mockStagedConfig.channels.discord.accounts.default.guilds.guild1.channels.manual).toEqual({ enabled: true });
        expect(mockStagedConfig.channels.discord.accounts.default.guilds.guild1.bindingAllowedChannels).toEqual({ chan1: 1 });
        expect(mockStagedConfig.channels.discord.accounts.default.guilds.guild1.channels).not.toHaveProperty("chan2");
        expect(mockStagedConfig.channels.discord.accounts.default.guilds.guild1.channels).not.toHaveProperty("chan3");

        (parseBody as any).mockResolvedValue({ bindings: [] });
        const res2 = createMockRes();
        await handleAgentRoutes(createMockReq("PUT"), res2, url, "/bindings");

        expect(mockStagedConfig.channels.discord.accounts.default.guilds.guild1.channels).toEqual({ manual: { enabled: true } });
        expect(mockStagedConfig.channels.discord.accounts.default.guilds.guild1.bindingAllowedChannels).toBeUndefined();
    });

    it("stages dashboard icon updates when defer=1", async () => {
        const { parseBody, stagePendingFileMutation } = await import("../../api-utils.js");
        (parseBody as any).mockResolvedValue({ name: "Alpha", icon: "🦞" });

        const req = createMockReq("PUT");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha?defer=1");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(res.statusCode).toBe(200);
        expect(res._body.deferred).toBe(true);
        expect(stagePendingFileMutation).toHaveBeenCalledWith(expect.objectContaining({
            path: "/tmp/fake-dashboard/dashboard-config.json",
            kind: "dashboard-config",
        }));
        expect(mockPendingFileMutations.some((op: any) => op.path === "/tmp/fake-dashboard/dashboard-config.json")).toBe(true);
    });

    it("returns warnings when dependencies are cleaned", async () => {
        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(res._body.warnings).toBeDefined();
        expect(res._body.warnings.length).toBeGreaterThan(0);
        expect(res._body.warnings.some((w: string) => w.includes("beta") && w.includes("subagents"))).toBe(true);
        expect(res._body.warnings.some((w: string) => w.includes("tools.agentToAgent"))).toBe(true);
    });

    it("cleans flow definitions referencing the deleted agent", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/my_flow.flow.ts"] =
            `// controllerId: "beta/start_my_flow"\n` +
            `flow.runTask<{ status: string }>({ id: "step1", agentId: "alpha", input: {} });\n` +
            `flow.runTask<{ status: string }>({ id: "step2", agentId: "beta", input: {} });\n`;

        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(res._body.warnings.some((w: string) => w.includes("my_flow"))).toBe(true);
        const updated = mockFlowDefs["/tmp/fake-flows/definitions/my_flow.flow.ts"];
        expect(updated).toBeDefined();
        expect(updated).not.toContain('agentId: "alpha"');
        expect(updated).toContain('agentId: "beta"');
    });

    it("deletes flow definitions when all steps reference the deleted agent", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/only_alpha.flow.ts"] =
            `// controllerId: "alpha/start_only_alpha"\n` +
            `flow.runTask<{ status: string }>({ id: "step1", agentId: "alpha", input: {} });\n`;

        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(res._body.warnings.some((w: string) => w.includes("only_alpha") && w.includes("Deleted"))).toBe(true);
        expect(mockFlowDefs["/tmp/fake-flows/definitions/only_alpha.flow.ts"]).toBeUndefined();
    });

    it("deletes flow definitions controlled by the deleted agent", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/controller_alpha.flow.ts"] =
            `// controllerId: "alpha/start_controller_alpha"\n` +
            `flow.runTask<{ status: string }>({ id: "step1", agentId: "beta", input: {} });\n`;

        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(res._body.warnings.some((w: string) => w.includes("controller_alpha") && w.includes("controller alpha"))).toBe(true);
        expect(mockFlowDefs["/tmp/fake-flows/definitions/controller_alpha.flow.ts"]).toBeUndefined();
    });

    it("returns 404 when no agents list exists", async () => {
        mockConfig.agents = undefined;
        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        const handled = await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(404);
    });

    it("cancels active flow runtime state for the deleted agent", async () => {
        mockFlowStates["/tmp/fake-flows/state/flow_alpha_123.json"] = JSON.stringify({
            token: "flow_alpha_123",
            flowName: "alpha_pipeline",
            agentId: "alpha",
            status: "running",
            nextStepIndex: 1,
            completedStepIds: ["step1"],
            createdAt: new Date().toISOString(),
        });

        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(res._body.warnings.some((w: string) => w.includes("alpha_pipeline") && w.includes("Cancelled"))).toBe(true);
        expect(mockFlowStates["/tmp/fake-flows/state/flow_alpha_123.json"]).toBeUndefined();
        const historyRecord = mockFlowHistory["/tmp/fake-flows/history/flow_alpha_123.json"];
        expect(historyRecord).toBeDefined();
        const parsed = JSON.parse(historyRecord);
        expect(parsed.status).toBe("cancelled");
        expect(parsed.completedAt).toBeDefined();
    });

    it("does not cancel flow runtime state for other agents", async () => {
        mockFlowStates["/tmp/fake-flows/state/flow_beta_456.json"] = JSON.stringify({
            token: "flow_beta_456",
            flowName: "beta_pipeline",
            agentId: "beta",
            status: "running",
            nextStepIndex: 0,
            completedStepIds: [],
            createdAt: new Date().toISOString(),
        });

        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(mockFlowStates["/tmp/fake-flows/state/flow_beta_456.json"]).toBeDefined();
        expect(mockFlowHistory["/tmp/fake-flows/history/flow_beta_456.json"]).toBeUndefined();
    });

    it("cancels active shared flows that reference the deleted agent", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/shared_beta.flow.ts"] =
            `// controllerId: "beta/start_shared_beta"\n`
            + `flow.runTask<{ status: string }>({ id: "step1", agentId: "alpha", input: {} });\n`
            + `flow.runTask<{ status: string }>({ id: "step2", agentId: "beta", input: {} });\n`;
        mockFlowStates["/tmp/fake-flows/state/shared_beta_123.json"] = JSON.stringify({
            token: "shared_beta_123",
            flowName: "shared_beta",
            agentId: "beta",
            status: "running",
            nextStepIndex: 1,
            completedStepIds: ["step1"],
            createdAt: new Date().toISOString(),
        });

        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(res._body.warnings.some((w: string) => w.includes("shared_beta") && w.includes("Cancelled"))).toBe(true);
        expect(mockFlowStates["/tmp/fake-flows/state/shared_beta_123.json"]).toBeUndefined();
        const historyRecord = mockFlowHistory["/tmp/fake-flows/history/shared_beta_123.json"];
        expect(historyRecord).toBeDefined();
        const parsed = JSON.parse(historyRecord);
        expect(parsed.status).toBe("cancelled");
    });

    it("defers active flow runtime cleanup until apply", async () => {
        mockFlowStates["/tmp/fake-flows/state/flow_alpha_789.json"] = JSON.stringify({
            token: "flow_alpha_789",
            flowName: "alpha_pipeline",
            agentId: "alpha",
            status: "waiting_for_approval",
            nextStepIndex: 1,
            completedStepIds: ["step1"],
            waitingAtStepId: "step2",
            createdAt: new Date().toISOString(),
        });

        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/agents/alpha?defer=1");

        await handleAgentRoutes(req, res, url, "/agents/alpha");

        expect(res._body.deferred).toBe(true);
        expect(mockFlowStates["/tmp/fake-flows/state/flow_alpha_789.json"]).toBeDefined();
        expect(mockFlowHistory["/tmp/fake-flows/history/flow_alpha_789.json"]).toBeUndefined();
        expect(mockPendingDestructiveOps.some((op: any) => op.kind === "agent" && op.agentId === "alpha")).toBe(true);
    });
});
