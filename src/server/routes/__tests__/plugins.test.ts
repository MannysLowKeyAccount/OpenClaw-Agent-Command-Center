import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

let mockConfig: any = { agents: { list: [{ id: "main" }] } };

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
        resolveHome: vi.fn((p: string) => p.replace(/^~\//, "/home/user/")),
        tryReadFile: vi.fn(() => null),
        OPENCLAW_DIR: "/tmp/openclaw",
        execAsync: vi.fn(async () => ""),
        shellEsc: vi.fn((s: string) => s.replace(/"/g, '\\"').replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/`/g, "\\`")),
    };
});

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        existsSync: vi.fn(() => true),
        readdirSync: vi.fn(() => []),
        statSync: vi.fn(() => ({ isDirectory: () => true })),
        realpathSync: vi.fn((p: string) => p),
        readFileSync: vi.fn(() => ""),
        rmSync: vi.fn(),
    };
});

import { handlePluginRoutes } from "../plugins.js";

function mockReq(method: string): IncomingMessage {
    return { method } as IncomingMessage;
}

function mockRes(): ServerResponse & { _body: any } {
    return { statusCode: 0, _body: null } as unknown as ServerResponse & { _body: any };
}

describe("plugins routes", () => {
    beforeEach(() => {
        mockConfig = { agents: { list: [{ id: "main" }] } };
        vi.clearAllMocks();
    });

    describe("GET /api/plugins", () => {
        it("returns empty array when no plugins configured", async () => {
            const { readdirSync } = await import("node:fs");
            (readdirSync as any).mockReturnValue([]);
            const req = mockReq("GET");
            const res = mockRes();
            const handled = await handlePluginRoutes(req, res, new URL("http://localhost/api/plugins"), "/plugins");
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(res._body.plugins).toEqual([]);
        });

        it("returns plugins from installs config", async () => {
            const { tryReadFile } = await import("../../api-utils.js");
            mockConfig = {
                plugins: {
                    installs: {
                        "test-plugin": { installPath: "/tmp/openclaw/extensions/test-plugin" }
                    },
                    entries: { "test-plugin": { enabled: true } }
                }
            };
            (tryReadFile as any).mockImplementation((p: string) => {
                if (p.includes("package.json")) {
                    return JSON.stringify({ name: "test-plugin", version: "1.0.0", description: "A test plugin" });
                }
                return null;
            });
            const req = mockReq("GET");
            const res = mockRes();
            const handled = await handlePluginRoutes(req, res, new URL("http://localhost/api/plugins"), "/plugins");
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(res._body.plugins).toHaveLength(1);
            expect(res._body.plugins[0].name).toBe("test-plugin");
            expect(res._body.plugins[0].enabled).toBe(true);
        });
    });

    describe("GET /api/plugins — removable flag", () => {
        it("marks regular plugins as removable", async () => {
            const { tryReadFile } = await import("../../api-utils.js");
            mockConfig = {
                plugins: {
                    installs: {
                        "test-plugin": { installPath: "/tmp/openclaw/extensions/test-plugin" }
                    },
                    entries: { "test-plugin": { enabled: true } }
                }
            };
            (tryReadFile as any).mockImplementation((p: string) => {
                if (p.includes("package.json")) {
                    return JSON.stringify({ name: "test-plugin", version: "1.0.0" });
                }
                return null;
            });
            const req = mockReq("GET");
            const res = mockRes();
            const handled = await handlePluginRoutes(req, res, new URL("http://localhost/api/plugins"), "/plugins");
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(res._body.plugins[0].removable).toBe(true);
        });

        it("protects the dashboard plugin from removal", async () => {
            const { tryReadFile } = await import("../../api-utils.js");
            mockConfig = {
                plugins: {
                    installs: {
                        "agent-dashboard": { installPath: "/tmp/openclaw/extensions/agent-dashboard" }
                    },
                    entries: { "agent-dashboard": { enabled: true } }
                }
            };
            (tryReadFile as any).mockImplementation((p: string) => {
                if (p.includes("package.json")) {
                    return JSON.stringify({ name: "agent-dashboard", version: "1.0.0" });
                }
                return null;
            });
            const req = mockReq("GET");
            const res = mockRes();
            const handled = await handlePluginRoutes(req, res, new URL("http://localhost/api/plugins"), "/plugins");
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(res._body.plugins[0].removable).toBe(false);
        });
    });

    describe("POST /api/plugins/install", () => {
        async function postInstall(body: any) {
            const { parseBody } = await import("../../api-utils.js");
            (parseBody as any).mockResolvedValue(body);
            const req = mockReq("POST");
            const res = mockRes();
            const handled = await handlePluginRoutes(req, res, new URL("http://localhost/api/plugins/install"), "/plugins/install");
            return { handled, res };
        }

        it("rejects empty identifier", async () => {
            const { handled, res } = await postInstall({ identifier: "   " });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(400);
            expect(res._body.error).toContain("identifier required");
        });

        it("rejects invalid identifier characters", async () => {
            const { handled, res } = await postInstall({ identifier: "foo;rm -rf" });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(400);
            expect(res._body.error).toContain("invalid plugin identifier");
        });

        it("accepts scoped npm package", async () => {
            const { execAsync } = await import("../../api-utils.js");
            const { handled, res } = await postInstall({ identifier: "@openclaw/test" });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(execAsync).toHaveBeenCalled();
        });

        it("accepts local path", async () => {
            const { execAsync } = await import("../../api-utils.js");
            const { handled, res } = await postInstall({ identifier: "./extensions/my-plugin" });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(execAsync).toHaveBeenCalled();
        });
    });

    describe("POST /api/plugins/remove", () => {
        async function postRemove(body: any, search = "") {
            const { parseBody } = await import("../../api-utils.js");
            (parseBody as any).mockResolvedValue(body);
            const req = mockReq("POST");
            const res = mockRes();
            const url = new URL("http://localhost/api/plugins/remove" + search);
            const handled = await handlePluginRoutes(req, res, url, "/plugins/remove");
            return { handled, res };
        }

        it("rejects empty name", async () => {
            const { handled, res } = await postRemove({ name: "   " });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(400);
            expect(res._body.error).toContain("name required");
        });

        it("returns 404 for unknown plugin", async () => {
            const { handled, res } = await postRemove({ name: "missing-plugin" });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(404);
            expect(res._body.error).toContain("not found");
        });

        it("rejects removal of protected plugin", async () => {
            const { tryReadFile } = await import("../../api-utils.js");
            mockConfig = {
                plugins: {
                    installs: {
                        "agent-dashboard": { installPath: "/tmp/openclaw/extensions/agent-dashboard" }
                    },
                    entries: { "agent-dashboard": { enabled: true } }
                }
            };
            (tryReadFile as any).mockImplementation((p: string) => {
                if (p.includes("package.json")) {
                    return JSON.stringify({ name: "agent-dashboard", version: "1.0.0" });
                }
                return null;
            });
            const { handled, res } = await postRemove({ name: "agent-dashboard" });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(403);
            expect(res._body.error).toContain("protected");
        });

        it("removes install-source plugin and deletes managed dir", async () => {
            const { tryReadFile, writeConfig } = await import("../../api-utils.js");
            const { rmSync } = await import("node:fs");
            mockConfig = {
                plugins: {
                    installs: {
                        "test-plugin": { installPath: "/tmp/openclaw/extensions/test-plugin" }
                    },
                    entries: { "test-plugin": { enabled: true } },
                    slots: { memory: "test-plugin" }
                },
                agents: {
                    list: [{ id: "main", tools: { alsoAllow: ["test-plugin", "test-plugin_foo"], deny: ["other"] } }]
                }
            };
            (tryReadFile as any).mockImplementation((p: string) => {
                if (p.includes("package.json")) {
                    return JSON.stringify({ name: "test-plugin", version: "1.0.0" });
                }
                return null;
            });
            const { handled, res } = await postRemove({ name: "test-plugin" });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(res._body.ok).toBe(true);
            expect(rmSync).toHaveBeenCalledWith("/tmp/openclaw/extensions/test-plugin", { recursive: true, force: true });
            expect(writeConfig).toHaveBeenCalled();
            const written = (writeConfig as any).mock.calls[0][0];
            expect(written.plugins.installs["test-plugin"]).toBeUndefined();
            expect(written.plugins.entries["test-plugin"]).toBeUndefined();
            expect(written.plugins.slots.memory).toBeUndefined();
            expect(written.agents.list[0].tools.alsoAllow).toBeUndefined();
            expect(written.agents.list[0].tools.deny).toEqual(["other"]);
        });

        it("does not delete install-source plugins outside the managed extensions area", async () => {
            const { tryReadFile, writeConfig } = await import("../../api-utils.js");
            const { realpathSync, rmSync } = await import("node:fs");
            mockConfig = {
                plugins: {
                    installs: {
                        "escape-plugin": { installPath: "/tmp/openclaw/extensions/../escape/escape-plugin" }
                    },
                    entries: { "escape-plugin": { enabled: true } }
                }
            };
            (realpathSync as any).mockImplementation((p: string) => {
                if (p === "/tmp/openclaw/extensions") return "/tmp/openclaw/extensions";
                if (p === "/tmp/openclaw/extensions/../escape/escape-plugin") return "/tmp/openclaw/escape/escape-plugin";
                return p;
            });
            (tryReadFile as any).mockImplementation((p: string) => {
                if (p.includes("package.json")) {
                    return JSON.stringify({ name: "escape-plugin", version: "1.0.0" });
                }
                return null;
            });
            const { handled, res } = await postRemove({ name: "escape-plugin" });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(rmSync).not.toHaveBeenCalled();
            expect(writeConfig).toHaveBeenCalled();
            const written = (writeConfig as any).mock.calls[0][0];
            expect(written.plugins.installs["escape-plugin"]).toBeUndefined();
            expect(written.plugins.entries["escape-plugin"]).toBeUndefined();
        });

        it("removes loadPath-source plugin without deleting external dir", async () => {
            const { tryReadFile, writeConfig } = await import("../../api-utils.js");
            const { rmSync } = await import("node:fs");
            mockConfig = {
                plugins: {
                    load: { paths: ["/home/user/custom-plugin"] },
                    entries: { "custom-plugin": { enabled: true } }
                }
            };
            (tryReadFile as any).mockImplementation((p: string) => {
                if (p.includes("package.json")) {
                    return JSON.stringify({ name: "custom-plugin", version: "1.0.0" });
                }
                return null;
            });
            const { handled, res } = await postRemove({ name: "custom-plugin" });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(rmSync).not.toHaveBeenCalled();
            expect(writeConfig).toHaveBeenCalled();
            const written = (writeConfig as any).mock.calls[0][0];
            expect(written.plugins.load.paths).toEqual([]);
            expect(written.plugins.entries["custom-plugin"]).toBeUndefined();
        });

        it("removes extensionsDir-source plugin and deletes managed dir", async () => {
            const { rmSync, readdirSync } = await import("node:fs");
            const { tryReadFile: tryReadFileUtils, writeConfig } = await import("../../api-utils.js");
            mockConfig = {
                plugins: {
                    entries: { "ext-plugin": { enabled: true } }
                }
            };
            (readdirSync as any).mockReturnValue(["ext-plugin"]);
            (tryReadFileUtils as any).mockImplementation((p: string) => {
                if (p.includes("package.json")) {
                    return JSON.stringify({ name: "ext-plugin", version: "1.0.0" });
                }
                return null;
            });
            const { handled, res } = await postRemove({ name: "ext-plugin" });
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(rmSync).toHaveBeenCalledWith("/tmp/openclaw/extensions/ext-plugin", { recursive: true, force: true });
            expect(writeConfig).toHaveBeenCalled();
            const written = (writeConfig as any).mock.calls[0][0];
            expect(written.plugins.entries["ext-plugin"]).toBeUndefined();
        });

        it("supports deferred removal", async () => {
            const { tryReadFile, stageConfig } = await import("../../api-utils.js");
            mockConfig = {
                plugins: {
                    installs: {
                        "test-plugin": { installPath: "/tmp/openclaw/extensions/test-plugin" }
                    },
                    entries: { "test-plugin": { enabled: true } }
                }
            };
            (tryReadFile as any).mockImplementation((p: string) => {
                if (p.includes("package.json")) {
                    return JSON.stringify({ name: "test-plugin", version: "1.0.0" });
                }
                return null;
            });
            const { handled, res } = await postRemove({ name: "test-plugin" }, "?defer=1");
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(res._body.deferred).toBe(true);
            expect(stageConfig).toHaveBeenCalled();
        });
    });
});
