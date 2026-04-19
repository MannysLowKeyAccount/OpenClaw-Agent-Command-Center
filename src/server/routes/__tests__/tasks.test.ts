import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Track mutable mock state ───
let mockConfig: any = {};
let mockFlowDefs: Record<string, string> = {};
let mockFlowStates: Record<string, string> = {};

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
        getConfigError: vi.fn(() => null),
        readDashboardConfig: vi.fn(() => ({})),
        writeDashboardConfig: vi.fn(),
        execAsync: vi.fn(async () => ""),
        execFileAsync: vi.fn(async () => ""),
        resolveHome: vi.fn((p: string) => p.replace("~", "/tmp/fakehome")),
        tryReadFile: vi.fn(() => null),
        getAgentWorkspace: vi.fn((a: any) => `/tmp/ws/${a.id}`),
        getCachedCli: vi.fn(() => null),
        setCachedCli: vi.fn(),
        deleteCachedCli: vi.fn(),
        shellEsc: vi.fn((s: string) => s),
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
            return Object.prototype.hasOwnProperty.call(mockFlowDefs, p)
                || Object.prototype.hasOwnProperty.call(mockFlowStates, p);
        }),
        readFileSync: vi.fn((p: string, enc: string) => {
            if (Object.prototype.hasOwnProperty.call(mockFlowDefs, p)) return mockFlowDefs[p];
            if (Object.prototype.hasOwnProperty.call(mockFlowStates, p)) return mockFlowStates[p];
            throw new Error("ENOENT");
        }),
        writeFileSync: vi.fn((p: string, content: string) => {
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
        mockFlowDefs = {};
        mockFlowStates = {};

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
