import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Track mutable mock state ───
let mockConfig: any = {};
let mockPendingDestructiveOps: any[] = [];
let mockFlowDefs: Record<string, string> = {};
let mockFlowStates: Record<string, string> = {};
let mockReadFiles: Record<string, string> = {};
let mockDeletedMarkers: Record<string, string> = {};

// ─── Mock api-utils before importing tasks ───
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
        getConfigError: vi.fn(() => null),
        readDashboardConfig: vi.fn(() => ({})),
        writeDashboardConfig: vi.fn(),
        execAsync: vi.fn(async () => ""),
        execFileAsync: vi.fn(async () => ""),
        resolveHome: vi.fn((p: string) => p.replace("~", "/tmp/fakehome")),
        tryReadFile: vi.fn((p: string) => {
            if (Object.prototype.hasOwnProperty.call(mockReadFiles, p)) return mockReadFiles[p];
            return null;
        }),
        getAgentWorkspace: vi.fn((a: any) => `/tmp/ws/${a.id}`),
        getCachedCli: vi.fn(() => null),
        setCachedCli: vi.fn(),
        deleteCachedCli: vi.fn(),
        shellEsc: vi.fn((s: string) => s),
        AGENTS_STATE_DIR: "/tmp/fake-openclaw/agents",
        OPENCLAW_DIR: "/tmp/fake-openclaw",
        DASHBOARD_FLOW_DEFS_DIR: "/tmp/fake-flows/definitions",
        DASHBOARD_FLOW_STATE_DIR: "/tmp/fake-flows/state",
        DASHBOARD_FLOW_HISTORY_DIR: "/tmp/fake-flows/history",
    };
});

// Mock node:fs to prevent real filesystem access
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        existsSync: vi.fn((p: string) => {
            if (p === "/tmp/fake-flows/definitions") return true;
            if (p === "/tmp/fake-flows/state") return true;
            if (p === "/tmp/fake-flows/history") return true;
            if (Object.prototype.hasOwnProperty.call(mockReadFiles, p)) return true;
            return Object.prototype.hasOwnProperty.call(mockFlowDefs, p)
                || Object.prototype.hasOwnProperty.call(mockFlowStates, p)
                || Object.prototype.hasOwnProperty.call(mockDeletedMarkers, p);
        }),
        readFileSync: vi.fn((p: string, enc: string) => {
            if (Object.prototype.hasOwnProperty.call(mockFlowDefs, p)) return mockFlowDefs[p];
            if (Object.prototype.hasOwnProperty.call(mockFlowStates, p)) return mockFlowStates[p];
            if (Object.prototype.hasOwnProperty.call(mockReadFiles, p)) return mockReadFiles[p];
            throw new Error("ENOENT");
        }),
        writeFileSync: vi.fn((p: string, content: string) => {
            if (p.endsWith(".deleted")) {
                mockDeletedMarkers[p] = content;
                return;
            }
            if (p.startsWith("/tmp/fake-flows/state/")) {
                mockFlowStates[p] = content;
            } else {
                mockFlowDefs[p] = content;
            }
        }),
        mkdirSync: vi.fn(),
        unlinkSync: vi.fn((p: string) => {
            delete mockFlowDefs[p];
            delete mockFlowStates[p];
            delete mockDeletedMarkers[p];
        }),
        readdirSync: vi.fn((p: string) => {
            if (p === "/tmp/fake-flows/definitions") {
                return Object.keys(mockFlowDefs).map((k) => k.replace("/tmp/fake-flows/definitions/", ""));
            }
            if (p === "/tmp/fake-flows/state") {
                return Object.keys(mockFlowStates).map((k) => k.replace("/tmp/fake-flows/state/", ""));
            }
            return [];
        }),
    };
});

// Mock orchestrator codegen and utils
vi.mock("../../../orchestrator/codegen.js", () => ({
    parseFlowDefinitionFile: vi.fn((content: string) => {
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

vi.mock("../../../orchestrator/utils.js", () => ({
    validateFlowDefinition: vi.fn(() => ({ valid: true })),
    deriveFileNames: vi.fn((name: string) => ({ flowFile: `${name}.flow.ts`, toolFile: `${name}.tool.ts` })),
    TASK_FLOW_TOOL_ID: "run_task_flow",
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

// ─── Tests ───
describe("GET /api/tasks/flows/pending", () => {
    let handleTaskRoutes: typeof import("../tasks.js").handleTaskRoutes;

    beforeEach(async () => {
        vi.resetModules();
        mockConfig = {
            agents: {
                list: [
                    { id: "alpha", name: "Alpha" },
                    { id: "beta", name: "Beta" },
                ],
            },
        };
        mockPendingDestructiveOps = [];
        mockFlowDefs = {};
        mockFlowStates = {};
        mockReadFiles = {};
        mockDeletedMarkers = {};

        const mod = await import("../tasks.js");
        handleTaskRoutes = mod.handleTaskRoutes;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns active flows for existing agents", async () => {
        mockFlowStates["/tmp/fake-flows/state/flow_alpha.json"] = JSON.stringify({
            token: "flow_alpha",
            flowName: "alpha_pipeline",
            agentId: "alpha",
            status: "running",
            nextStepIndex: 1,
            completedStepIds: ["step1"],
            createdAt: new Date().toISOString(),
        });

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks/flows/pending");

        const handled = await handleTaskRoutes(req, res, url, "/tasks/flows/pending");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.pending.length).toBe(1);
        expect(res._body.pending[0].token).toBe("flow_alpha");
    });

    it("marks orphaned active flows instead of hiding them", async () => {
        mockFlowStates["/tmp/fake-flows/state/flow_gamma.json"] = JSON.stringify({
            token: "flow_gamma",
            flowName: "gamma_pipeline",
            agentId: "gamma",
            status: "running",
            nextStepIndex: 0,
            completedStepIds: [],
            createdAt: new Date().toISOString(),
        });

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks/flows/pending");

        const handled = await handleTaskRoutes(req, res, url, "/tasks/flows/pending");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.pending.length).toBe(1);
        expect(res._body.pending[0].token).toBe("flow_gamma");
        expect(res._body.pending[0].orphaned).toBe(true);
    });

    it("keeps active flows for the implicit main agent", async () => {
        mockFlowStates["/tmp/fake-flows/state/flow_main.json"] = JSON.stringify({
            token: "flow_main",
            flowName: "main_pipeline",
            agentId: "main",
            status: "running",
            nextStepIndex: 0,
            completedStepIds: [],
            createdAt: new Date().toISOString(),
        });

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks/flows/pending");

        const handled = await handleTaskRoutes(req, res, url, "/tasks/flows/pending");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.pending.length).toBe(1);
        expect(res._body.pending[0].agentId).toBe("main");
    });

    it("marks active flow orphaned when a step agent is deleted", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/orphan_step.flow.ts"] =
            `// controllerId: "alpha/start_orphan_step"
flow.runTask<{ status: string }>({ id: "step1", agentId: "alpha", input: {} });
flow.runTask<{ status: string }>({ id: "step2", agentId: "deleted-step-agent", input: {} });
`;
        mockFlowStates["/tmp/fake-flows/state/flow_orphan_step.json"] = JSON.stringify({
            token: "flow_orphan_step",
            flowName: "orphan_step",
            agentId: "alpha",
            status: "running",
            nextStepIndex: 1,
            completedStepIds: ["step1"],
            createdAt: new Date().toISOString(),
        });

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks/flows/pending");

        const handled = await handleTaskRoutes(req, res, url, "/tasks/flows/pending");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.pending.length).toBe(1);
        expect(res._body.pending[0].token).toBe("flow_orphan_step");
        expect(res._body.pending[0].orphaned).toBe(true);
    });
});

describe("GET /api/tasks normalized run visibility", () => {
    let handleTaskRoutes: typeof import("../tasks.js").handleTaskRoutes;

    beforeEach(async () => {
        vi.resetModules();
        mockConfig = {
            agents: {
                list: [{ id: "alpha", name: "Alpha" }],
            },
        };
        mockPendingDestructiveOps = [];
        mockFlowDefs = {};
        mockFlowStates = {};
        mockReadFiles = {
            "/tmp/fake-openclaw/cron/jobs.json": JSON.stringify({
                jobs: [
                    {
                        id: "nightly-gmail-triage",
                        name: "Nightly Gmail Triage",
                        enabled: true,
                        schedule: { kind: "cron", expr: "0 7 * * *" },
                    },
                ],
            }),
            "/tmp/fake-openclaw/cron/runs/nightly-gmail-triage.jsonl": [
                JSON.stringify({
                    id: "run-123",
                    status: "completed",
                    startedAt: "2026-04-20T07:00:00.000Z",
                    completedAt: "2026-04-20T07:05:00.000Z",
                    summary: "Triaged 12 messages",
                    sessionId: "session-123",
                    agentId: "alpha",
                }),
            ].join("\n"),
            "/tmp/fake-openclaw/agents/alpha/sessions/session-123.jsonl": [
                JSON.stringify({ type: "session", agentId: "alpha", channel: "cron" }),
                JSON.stringify({ type: "message", timestamp: "2026-04-20T07:04:30.000Z", message: { role: "assistant", content: "Progress: reviewing unread threads" } }),
                JSON.stringify({ type: "message", timestamp: "2026-04-20T07:04:59.000Z", message: { role: "assistant", content: "Decision: send follow-ups to the finance queue" } }),
            ].join("\n"),
        };

        const mod = await import("../tasks.js");
        handleTaskRoutes = mod.handleTaskRoutes;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("normalizes the latest run and enriches it with transcript progress", async () => {
        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks");

        const handled = await handleTaskRoutes(req, res, url, "/tasks");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.tasks[0].latestRun.status).toBe("completed");
        expect(res._body.tasks[0].latestRun.sessionId).toBe("session-123");
        expect(res._body.tasks[0].latestRun.latestProgress).toContain("Progress: reviewing unread threads");
    });

    it("returns run details with transcript snippets", async () => {
        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks/nightly-gmail-triage/runs/run-123");

        const handled = await handleTaskRoutes(req, res, url, "/tasks/nightly-gmail-triage/runs/run-123");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.run.status).toBe("completed");
        expect(res._body.run.raw.transcript.decisionSnippet).toContain("Decision: send follow-ups");
    });
});

describe("GET /api/tasks/flows/definitions", () => {
    let handleTaskRoutes: typeof import("../tasks.js").handleTaskRoutes;

    beforeEach(async () => {
        vi.resetModules();
        mockConfig = {
            agents: {
                list: [
                    { id: "alpha", name: "Alpha" },
                    { id: "beta", name: "Beta" },
                ],
            },
        };
        mockFlowDefs = {};
        mockFlowStates = {};

        const mod = await import("../tasks.js");
        handleTaskRoutes = mod.handleTaskRoutes;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns flow definitions for existing agents", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/alpha_flow.flow.ts"] =
            `// controllerId: "alpha/start_alpha_flow"
flow.runTask<{ status: string }>({ id: "step1", agentId: "alpha", input: {} });
`;

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks/flows/definitions");

        const handled = await handleTaskRoutes(req, res, url, "/tasks/flows/definitions");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.flows.length).toBe(1);
        expect(res._body.flows[0].name).toBe("alpha_flow");
        expect(res._body.flows[0].file).toBe("alpha_flow.flow.ts");
    });

    it("marks orphaned flow definitions instead of hiding them", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/gamma_flow.flow.ts"] =
            `// controllerId: "gamma/start_gamma_flow"
flow.runTask<{ status: string }>({ id: "step1", agentId: "gamma", input: {} });
`;

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks/flows/definitions");

        const handled = await handleTaskRoutes(req, res, url, "/tasks/flows/definitions");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.flows.length).toBe(1);
        expect(res._body.flows[0].name).toBe("gamma_flow");
        expect(res._body.flows[0].orphaned).toBe(true);
    });

    it("keeps flow definitions for the implicit main agent", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/main_flow.flow.ts"] =
            `// controllerId: "main/start_main_flow"
flow.runTask<{ status: string }>({ id: "step1", agentId: "main", input: {} });
`;

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks/flows/definitions");

        const handled = await handleTaskRoutes(req, res, url, "/tasks/flows/definitions");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.flows.length).toBe(1);
        expect(res._body.flows[0].agentId).toBe("main");
    });

    it("marks flow definition orphaned when a step agent is deleted", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/orphan_step.flow.ts"] =
            `// controllerId: "alpha/start_orphan_step"
flow.runTask<{ status: string }>({ id: "step1", agentId: "alpha", input: {} });
flow.runTask<{ status: string }>({ id: "step2", agentId: "deleted-step-agent", input: {} });
`;

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks/flows/definitions");

        const handled = await handleTaskRoutes(req, res, url, "/tasks/flows/definitions");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.flows.length).toBe(1);
        expect(res._body.flows[0].name).toBe("orphan_step");
        expect(res._body.flows[0].orphaned).toBe(true);
    });
});

describe("DELETE /api/tasks/flows/definition/:agentId/:flowName", () => {
    let handleTaskRoutes: typeof import("../tasks.js").handleTaskRoutes;

    beforeEach(async () => {
        vi.resetModules();
        mockConfig = {
            agents: {
                list: [
                    { id: "alpha", name: "Alpha", tools: { alsoAllow: ["read", "run_task_flow"] } },
                ],
            },
        };
        mockPendingDestructiveOps = [];
        mockFlowDefs = {};
        mockFlowStates = {};

        const mod = await import("../tasks.js");
        handleTaskRoutes = mod.handleTaskRoutes;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("disables run_task_flow when deleting the last flow for an agent", async () => {
        mockFlowDefs["/tmp/fake-flows/definitions/solo.flow.ts"] =
            `// controllerId: "alpha/start_solo"\n` +
            `flow.runTask<{ status: string }>({ id: "step1", agentId: "alpha", input: {} });\n`;

        const req = createMockReq("DELETE");
        const res = createMockRes();
        const url = new URL("http://localhost/api/tasks/flows/definition/alpha/solo?defer=1");

        const handled = await handleTaskRoutes(req, res, url, "/tasks/flows/definition/alpha/solo");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.toolDisabled).toBe(true);
        const { stageConfig } = await import("../../api-utils.js");
        expect(stageConfig).toHaveBeenCalled();
        const stagedConfig = (stageConfig as any).mock.calls.at(-1)[0];
        expect(stagedConfig.agents.list[0].tools.alsoAllow).not.toContain("run_task_flow");
    });

    it("keeps deleted flow definitions hidden even when AGENTS.md can rebuild them", async () => {
        const flowFilePath = "/tmp/fake-flows/definitions/solo.flow.ts";
        const tombstonePath = `${flowFilePath}.deleted`;
        const agentsMdPath = "/tmp/ws/alpha/AGENTS.md";

        mockFlowDefs[flowFilePath] =
            `// controllerId: "alpha/start_solo"\n` +
            `flow.runTask<{ status: string }>({ id: "step1", agentId: "alpha", input: {} });\n`;
        mockReadFiles[agentsMdPath] = [
            "## Workflow policy",
            "",
            "Coordinate the solo flow.",
            "",
            "### Execution policy",
            "1. **step1** (agent: alpha) — do the thing",
            "",
            "# Invoke",
            "flowName: \"solo\"",
        ].join("\n");

        const deleteReq = createMockReq("DELETE");
        const deleteRes = createMockRes();
        const deleteUrl = new URL("http://localhost/api/tasks/flows/definition/alpha/solo");

        const deleteHandled = await handleTaskRoutes(deleteReq, deleteRes, deleteUrl, "/tasks/flows/definition/alpha/solo");

        expect(deleteHandled).toBe(true);
        expect(deleteRes.statusCode).toBe(200);
        expect(Object.prototype.hasOwnProperty.call(mockDeletedMarkers, tombstonePath)).toBe(true);

        const getReq = createMockReq("GET");
        const getRes = createMockRes();
        const getUrl = new URL("http://localhost/api/tasks/flows/definition/alpha");

        const getHandled = await handleTaskRoutes(getReq, getRes, getUrl, "/tasks/flows/definition/alpha");

        expect(getHandled).toBe(true);
        expect(getRes.statusCode).toBe(404);
        expect(getRes._body.error).toBe("Flow definition not found");
    });
});
