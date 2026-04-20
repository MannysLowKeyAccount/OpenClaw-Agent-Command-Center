import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

let mockConfig: any = { agents: { list: [{ id: "main" }] } };
let mockPendingConfig: any = null;
let mockPendingDestructiveOps: any[] = [];
let mockRaw = "{\n  \"agents\": {\n    \"list\": []\n  }\n}";

vi.mock("../../api-utils.js", () => ({
    json: vi.fn((res: any, status: number, data: any) => {
        res.statusCode = status;
        res._body = data;
    }),
    readConfig: vi.fn(() => JSON.parse(JSON.stringify(mockConfig))),
    readEffectiveConfig: vi.fn(() => JSON.parse(JSON.stringify(mockConfig))),
    writeConfig: vi.fn(),
    stageConfig: vi.fn(),
    commitPendingChanges: vi.fn(),
    discardPendingChanges: vi.fn(),
    getPendingConfig: vi.fn(() => mockPendingConfig ? JSON.parse(JSON.stringify(mockPendingConfig)) : null),
    getPendingDestructiveOps: vi.fn(() => JSON.parse(JSON.stringify(mockPendingDestructiveOps))),
    getPendingChangeCount: vi.fn(() => (mockPendingConfig ? 1 : 0) + mockPendingDestructiveOps.length),
    getPendingChangeDescriptions: vi.fn(() => ["staged config", ...mockPendingDestructiveOps.map((op) => op.description)]),
    getConfigError: vi.fn(() => null),
    parseBody: vi.fn(async () => ({})),
    execAsync: vi.fn(async () => ""),
    tryReadFile: vi.fn(() => mockRaw),
    CONFIG_PATH: "/tmp/openclaw/openclaw.json",
}));

vi.mock("../skills.js", () => ({
    syncSkillsToAllWorkspaces: vi.fn(),
}));

import { handleConfigRoutes } from "../config.js";
import { syncSkillsToAllWorkspaces } from "../skills.js";

function mockReq(method: string): IncomingMessage {
    return { method } as IncomingMessage;
}

function mockRes(): ServerResponse & { _body: any } {
    return { statusCode: 0, _body: null } as unknown as ServerResponse & { _body: any };
}

describe("config routes", () => {
    beforeEach(() => {
        mockConfig = { agents: { list: [{ id: "main" }] } };
        mockPendingConfig = null;
        mockPendingDestructiveOps = [];
        mockRaw = "{\n  \"agents\": {\n    \"list\": []\n  }\n}";
        vi.clearAllMocks();
    });

    it("marks /config/raw as pending when destructive ops are staged", async () => {
        mockPendingDestructiveOps = [{ kind: "skill", description: "Delete skill: helper" }];

        const req = mockReq("GET");
        const res = mockRes();
        const handled = await handleConfigRoutes(req, res, new URL("http://localhost/api/config/raw"), "/config/raw");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.raw).toBe(mockRaw);
        expect(res._body.hasPending).toBe(true);
    });

    it("rebuilds skill indexes when discarding pending skill deletes", async () => {
        mockPendingDestructiveOps = [{ kind: "skill", description: "Delete skill: helper" }];

        const req = mockReq("DELETE");
        const res = mockRes();
        const handled = await handleConfigRoutes(req, res, new URL("http://localhost/api/config/pending"), "/config/pending");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(syncSkillsToAllWorkspaces).toHaveBeenCalledWith(expect.objectContaining(mockConfig));
    });
});
