/**
 * Preservation Property Tests — Session CRUD Semantics and API Contracts Unchanged
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.8, 3.10**
 *
 * These tests observe and lock down the current (unfixed) behavior for non-buggy inputs:
 * session CRUD operations, response formats, error handling, and API contracts.
 * They MUST PASS on unfixed code to establish the baseline that the fix must preserve.
 *
 * Observation-first methodology: each test observes the actual behavior of the unfixed code
 * and asserts that the response status codes, body field names/types, and error handling
 * match the observed patterns.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Temp filesystem setup ───
const TEST_ROOT = join(tmpdir(), `sessions-preserve-test-${Date.now()}`);
const FAKE_AGENTS_DIR = join(TEST_ROOT, "agents");
const FAKE_DASHBOARD_DIR = join(TEST_ROOT, "dashboard-sessions");

const AGENT_IDS = ["agent-alpha", "agent-beta"];
const SESSION_KEYS = ["sess-001", "sess-002"];

function buildJsonlContent(agentId: string, sessionKey: string): string {
    const lines = [
        JSON.stringify({ type: "session", agentId, channel: "cli", sessionKey }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" }, timestamp: "2025-01-01T00:00:00Z" }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "hi there" }, timestamp: "2025-01-01T00:01:00Z" }),
    ];
    return lines.join("\n") + "\n";
}

function setupTestFilesystem(): void {
    mkdirSync(FAKE_AGENTS_DIR, { recursive: true });
    mkdirSync(FAKE_DASHBOARD_DIR, { recursive: true });

    for (const agentId of AGENT_IDS) {
        const sessDir = join(FAKE_AGENTS_DIR, agentId, "sessions");
        mkdirSync(sessDir, { recursive: true });

        const sessIndex: Record<string, any> = {};
        for (const sk of SESSION_KEYS) {
            const fullKey = `${agentId}-${sk}`;
            sessIndex[fullKey] = { sessionId: fullKey, agentId, channel: "cli" };
            writeFileSync(join(sessDir, fullKey + ".jsonl"), buildJsonlContent(agentId, fullKey), "utf-8");
        }
        writeFileSync(join(sessDir, "sessions.json"), JSON.stringify(sessIndex, null, 2), "utf-8");
    }
}

function teardownTestFilesystem(): void {
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { }
}

// ─── Mocks ───
// We need to mock api-utils to redirect paths to our temp filesystem,
// but allow the real session route logic to execute against real files.

// Track gateway calls for message forwarding preservation
let lastGatewayCallArgs: { agentId: string; message: string; sessionKey: string } | null = null;
let gatewayBehavior: "success" | "rate_limit" | "auth_error" | "generic_error" = "success";

vi.mock("../../api-utils.js", () => {
    return {
        json: vi.fn((res: any, status: number, data: any) => {
            res.statusCode = status;
            res._body = data;
        }),
        parseBody: vi.fn(async () => ({ message: "test message", agentId: "agent-alpha", sessionKey: "new-session" })),
        readConfig: vi.fn(() => ({
            agents: {
                list: AGENT_IDS.map(id => ({
                    id,
                    subagents: { allowAgents: id === "agent-alpha" ? ["agent-beta"] : [] },
                })),
            },
        })),
        execAsync: vi.fn(async () => {
            throw new Error("CLI not available in test");
        }),
        resolveHome: vi.fn((p: string) => p.replace("~", TEST_ROOT)),
        tryReadFile: vi.fn((path: string) => {
            try {
                const { readFileSync } = require("node:fs");
                return readFileSync(path, "utf-8");
            } catch {
                return null;
            }
        }),
        AGENTS_STATE_DIR: FAKE_AGENTS_DIR,
        DASHBOARD_SESSIONS_DIR: FAKE_DASHBOARD_DIR,
    };
});

// Mock node:child_process — CLI is the primary message sending path
vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        exec: vi.fn((cmd: string, ...rest: any[]) => {
            const cb = rest.find((a: any) => typeof a === "function") || rest[1];
            if (typeof cb === "function") {
                if (gatewayBehavior === "success") {
                    cb(null, "CLI response text", "");
                } else if (gatewayBehavior === "rate_limit") {
                    cb(new Error("rate limit exceeded — 429 too many requests"), "", "");
                } else if (gatewayBehavior === "auth_error") {
                    cb(new Error("unauthorized 401"), "", "");
                } else {
                    cb(new Error("CLI not available in test"), "", "");
                }
            }
        }),
    };
});

// Mock node:http to intercept gateway calls and control behavior
vi.mock("node:http", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:http")>();
    return {
        ...actual,
        request: vi.fn((options: any, callback: any) => {
            // Capture gateway call args from the request body
            const mockRes = {
                statusCode: 200,
                on: vi.fn((event: string, handler: any) => {
                    if (event === "data") {
                        if (gatewayBehavior === "success") {
                            handler(JSON.stringify({
                                choices: [{ message: { content: "gateway response text" } }],
                            }));
                        } else if (gatewayBehavior === "rate_limit") {
                            mockRes.statusCode = 429;
                            handler(JSON.stringify({ error: "rate limit exceeded" }));
                        } else if (gatewayBehavior === "auth_error") {
                            mockRes.statusCode = 401;
                            handler(JSON.stringify({ error: "unauthorized" }));
                        } else {
                            mockRes.statusCode = 500;
                            handler(JSON.stringify({ error: "internal server error" }));
                        }
                    }
                    if (event === "end") {
                        handler();
                    }
                }),
            };
            if (callback) callback(mockRes);
            return {
                on: vi.fn(),
                write: vi.fn((data: string) => {
                    try {
                        const parsed = JSON.parse(data);
                        lastGatewayCallArgs = {
                            agentId: parsed.model || "",
                            message: parsed.messages?.[0]?.content || "",
                            sessionKey: parsed.session_id || "",
                        };
                    } catch { }
                }),
                end: vi.fn(),
                destroy: vi.fn(),
            };
        }),
    };
});

// ─── Helpers ───
function createMockReq(method: string): IncomingMessage {
    return { method, on: vi.fn(), destroy: vi.fn() } as unknown as IncomingMessage;
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
describe("Preservation: Session CRUD Semantics and API Contracts Unchanged", () => {
    let handleSessionRoutes: typeof import("../sessions.js").handleSessionRoutes;

    beforeAll(() => {
        setupTestFilesystem();
    });

    afterAll(() => {
        teardownTestFilesystem();
    });

    beforeEach(async () => {
        vi.resetModules();
        gatewayBehavior = "success";
        lastGatewayCallArgs = null;

        // Re-mock parseBody for each test (default)
        const apiUtils = await import("../../api-utils.js");
        (apiUtils.parseBody as any).mockResolvedValue({ message: "test message", agentId: "agent-alpha", sessionKey: "new-session" });

        const mod = await import("../sessions.js");
        handleSessionRoutes = mod.handleSessionRoutes;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * Observe: POST /sessions/spawn with {sessionKey, agentId} creates a dashboard JSON file
     * and returns {sessionKey, ok: true} with status 201
     *
     * **Validates: Requirements 3.1**
     */
    it("Property 2a: POST /sessions/spawn returns {sessionKey, ok: true} with status 201", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
                fc.constantFrom(...AGENT_IDS),
                async (sessionKeySuffix, agentId) => {
                    vi.resetModules();
                    const apiUtils = await import("../../api-utils.js");
                    const newKey = `spawn-test-${sessionKeySuffix}`;
                    (apiUtils.parseBody as any).mockResolvedValue({ sessionKey: newKey, agentId });

                    const mod = await import("../sessions.js");
                    const handler = mod.handleSessionRoutes;

                    const req = createMockReq("POST");
                    const res = createMockRes();
                    const url = new URL("http://localhost/api/sessions/spawn");

                    const handled = await handler(req, res, url, "/sessions/spawn");

                    // Preservation assertions
                    expect(handled).toBe(true);
                    expect(res.statusCode).toBe(201);
                    expect(res._body).toHaveProperty("sessionKey");
                    expect(res._body).toHaveProperty("ok", true);
                    expect(typeof res._body.sessionKey).toBe("string");
                    expect(res._body.sessionKey).toBe(newKey);

                    // Verify dashboard JSON file was created
                    const fp = join(FAKE_DASHBOARD_DIR, newKey + ".json");
                    expect(existsSync(fp)).toBe(true);

                    // Clean up
                    try { rmSync(fp); } catch { }
                }
            ),
            { numRuns: 10 }
        );
    });

    /**
     * Observe: POST /sessions/{key}/message with {message, agentId} forwards to gateway
     * and returns {ok: true, result, response} with status 200
     *
     * **Validates: Requirements 3.2**
     */
    it("Property 2b: POST /sessions/{key}/message returns {ok: true, result, response} with status 200 on success", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom("test-msg-session-1", "test-msg-session-2"),
                async (sessionKey) => {
                    vi.resetModules();
                    gatewayBehavior = "success";
                    const apiUtils = await import("../../api-utils.js");
                    (apiUtils.parseBody as any).mockResolvedValue({ message: "hello world", agentId: "agent-alpha" });

                    const mod = await import("../sessions.js");
                    const handler = mod.handleSessionRoutes;

                    const req = createMockReq("POST");
                    const res = createMockRes();
                    const url = new URL(`http://localhost/api/sessions/${sessionKey}/message`);

                    const handled = await handler(req, res, url, `/sessions/${sessionKey}/message`);

                    expect(handled).toBe(true);
                    expect(res.statusCode).toBe(200);
                    expect(res._body).toHaveProperty("ok", true);
                    expect(res._body).toHaveProperty("result");
                    expect(res._body).toHaveProperty("response");
                    expect(typeof res._body.result).toBe("string");
                    expect(typeof res._body.response).toBe("string");
                    // result and response should be the same value
                    expect(res._body.result).toBe(res._body.response);
                }
            ),
            { numRuns: 5 }
        );
    });

    /**
     * Observe: DELETE /sessions/{key} removes dashboard JSON + agent state files + sessions.json entry
     * and returns {ok: true, deleted: boolean} with status 200
     *
     * **Validates: Requirements 3.3**
     */
    it("Property 2c: DELETE /sessions/{key} returns {ok: true, deleted: boolean} with status 200", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom("delete-test-session-1", "delete-test-session-2"),
                async (sessionKey) => {
                    vi.resetModules();

                    // Create a dashboard session to delete
                    const dashFp = join(FAKE_DASHBOARD_DIR, sessionKey + ".json");
                    writeFileSync(dashFp, JSON.stringify({ sessionKey, agentId: "agent-alpha", channel: "dashboard", messages: [] }), "utf-8");

                    const mod = await import("../sessions.js");
                    const handler = mod.handleSessionRoutes;

                    const req = createMockReq("DELETE");
                    const res = createMockRes();
                    const url = new URL(`http://localhost/api/sessions/${sessionKey}`);

                    const handled = await handler(req, res, url, `/sessions/${sessionKey}`);

                    expect(handled).toBe(true);
                    expect(res.statusCode).toBe(200);
                    expect(res._body).toHaveProperty("ok", true);
                    expect(res._body).toHaveProperty("deleted");
                    expect(typeof res._body.deleted).toBe("boolean");
                }
            ),
            { numRuns: 5 }
        );
    });

    /**
     * Observe: DELETE /sessions/all:{agentId} removes all sessions for agent and subagents
     * and returns {ok: true, deleted, cleanedAll: true, cleanedAgents: [...]} with status 200
     *
     * **Validates: Requirements 3.4**
     */
    it("Property 2d: DELETE /sessions/all:{agentId} returns {ok: true, deleted, cleanedAll, cleanedAgents} with status 200", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom("agent-alpha"),
                async (agentId) => {
                    vi.resetModules();

                    // Create a dashboard session for this agent
                    const dashKey = `all-delete-test-${agentId}`;
                    const dashFp = join(FAKE_DASHBOARD_DIR, dashKey + ".json");
                    writeFileSync(dashFp, JSON.stringify({ sessionKey: dashKey, agentId, channel: "dashboard", messages: [] }), "utf-8");

                    const mod = await import("../sessions.js");
                    const handler = mod.handleSessionRoutes;

                    const req = createMockReq("DELETE");
                    const res = createMockRes();
                    const url = new URL(`http://localhost/api/sessions/all:${agentId}`);

                    const handled = await handler(req, res, url, `/sessions/all:${agentId}`);

                    expect(handled).toBe(true);
                    expect(res.statusCode).toBe(200);
                    expect(res._body).toHaveProperty("ok", true);
                    expect(res._body).toHaveProperty("deleted");
                    expect(res._body).toHaveProperty("cleanedAll", true);
                    expect(res._body).toHaveProperty("cleanedAgents");
                    expect(Array.isArray(res._body.cleanedAgents)).toBe(true);
                    // cleanedAgents should include the agent and its subagents
                    expect(res._body.cleanedAgents).toContain(agentId);
                    // agent-alpha has agent-beta as subagent per our mock config
                    expect(res._body.cleanedAgents).toContain("agent-beta");
                }
            ),
            { numRuns: 3 }
        );
    });

    /**
     * Observe: Gateway 429/401/403 errors return status 429 with {error, errorType: "model_limit", userMessageSaved: true}
     *
     * **Validates: Requirements 3.8**
     */
    it("Property 2e: Gateway rate limit/auth errors return 429 with {error, errorType: 'model_limit', userMessageSaved: true}", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom("rate_limit", "auth_error") as fc.Arbitrary<"rate_limit" | "auth_error">,
                async (errorType) => {
                    vi.resetModules();
                    gatewayBehavior = errorType;
                    const apiUtils = await import("../../api-utils.js");
                    (apiUtils.parseBody as any).mockResolvedValue({ message: "test", agentId: "agent-alpha" });

                    const mod = await import("../sessions.js");
                    const handler = mod.handleSessionRoutes;

                    const req = createMockReq("POST");
                    const res = createMockRes();
                    const url = new URL("http://localhost/api/sessions/rate-limit-test/message");

                    const handled = await handler(req, res, url, "/sessions/rate-limit-test/message");

                    expect(handled).toBe(true);
                    expect(res.statusCode).toBe(429);
                    expect(res._body).toHaveProperty("error");
                    expect(typeof res._body.error).toBe("string");
                    expect(res._body).toHaveProperty("errorType", "model_limit");
                    expect(res._body).toHaveProperty("userMessageSaved", true);
                }
            ),
            { numRuns: 5 }
        );
    });

    /**
     * Observe: GET /sessions/{key} returns {session: {sessionKey, agentId, channel, messages, updatedAt}} with status 200
     *
     * **Validates: Requirements 3.5, 3.10**
     */
    it("Property 2f: GET /sessions/{key} returns {session} with correct structure and status 200", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...AGENT_IDS),
                fc.constantFrom(...SESSION_KEYS),
                async (agentId, sessKey) => {
                    vi.resetModules();
                    const mod = await import("../sessions.js");
                    const handler = mod.handleSessionRoutes;

                    const fullKey = `${agentId}-${sessKey}`;
                    const req = createMockReq("GET");
                    const res = createMockRes();
                    const url = new URL(`http://localhost/api/sessions/${fullKey}`);

                    const handled = await handler(req, res, url, `/sessions/${fullKey}`);

                    expect(handled).toBe(true);
                    expect(res.statusCode).toBe(200);
                    expect(res._body).toHaveProperty("session");

                    const session = res._body.session;
                    // Session should be an object (may be empty if lookup fails, but should have structure when found)
                    expect(typeof session).toBe("object");

                    // When session is found, verify the contract fields
                    if (session && session.sessionKey) {
                        expect(session).toHaveProperty("sessionKey");
                        expect(typeof session.sessionKey).toBe("string");
                        expect(session).toHaveProperty("agentId");
                        expect(typeof session.agentId).toBe("string");
                        expect(session).toHaveProperty("channel");
                        expect(typeof session.channel).toBe("string");
                        expect(session).toHaveProperty("messages");
                        expect(Array.isArray(session.messages)).toBe(true);
                        // updatedAt can be string or null
                        expect(session).toHaveProperty("updatedAt");
                    }
                }
            ),
            { numRuns: 10 }
        );
    });

    /**
     * Observe: GET /sessions and GET /sessions/agent/{id} return
     * {sessions: [{sessionKey, agentId, channel, messageCount, updatedAt, ...}]}
     *
     * **Validates: Requirements 3.5**
     */
    it("Property 2g: GET /sessions returns {sessions: [...]} with correct item structure and status 200", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constant(null), // no varying input needed
                async () => {
                    vi.resetModules();
                    const mod = await import("../sessions.js");
                    const handler = mod.handleSessionRoutes;

                    const req = createMockReq("GET");
                    const res = createMockRes();
                    const url = new URL("http://localhost/api/sessions");

                    const handled = await handler(req, res, url, "/sessions");

                    expect(handled).toBe(true);
                    expect(res.statusCode).toBe(200);
                    expect(res._body).toHaveProperty("sessions");
                    expect(Array.isArray(res._body.sessions)).toBe(true);

                    // Verify each session item has the expected fields
                    for (const s of res._body.sessions) {
                        expect(s).toHaveProperty("sessionKey");
                        expect(typeof s.sessionKey).toBe("string");
                        expect(s).toHaveProperty("agentId");
                        expect(typeof s.agentId).toBe("string");
                        expect(s).toHaveProperty("channel");
                        expect(typeof s.channel).toBe("string");
                        expect(s).toHaveProperty("messageCount");
                        expect(typeof s.messageCount).toBe("number");
                        // updatedAt can be string or null
                        expect(s).toHaveProperty("updatedAt");
                    }
                }
            ),
            { numRuns: 3 }
        );
    });

    it("Property 2h: GET /sessions/agent/{id} returns {sessions: [...], agentId} with correct item structure and status 200", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...AGENT_IDS),
                async (agentId) => {
                    vi.resetModules();
                    const mod = await import("../sessions.js");
                    const handler = mod.handleSessionRoutes;

                    const req = createMockReq("GET");
                    const res = createMockRes();
                    const url = new URL(`http://localhost/api/sessions/agent/${agentId}`);

                    const handled = await handler(req, res, url, `/sessions/agent/${agentId}`);

                    expect(handled).toBe(true);
                    expect(res.statusCode).toBe(200);
                    expect(res._body).toHaveProperty("sessions");
                    expect(Array.isArray(res._body.sessions)).toBe(true);

                    // Verify each session item has the expected fields
                    for (const s of res._body.sessions) {
                        expect(s).toHaveProperty("sessionKey");
                        expect(typeof s.sessionKey).toBe("string");
                        expect(s).toHaveProperty("agentId");
                        expect(typeof s.agentId).toBe("string");
                        expect(s).toHaveProperty("channel");
                        expect(typeof s.channel).toBe("string");
                        expect(s).toHaveProperty("messageCount");
                        expect(typeof s.messageCount).toBe("number");
                        expect(s).toHaveProperty("updatedAt");
                    }
                }
            ),
            { numRuns: 5 }
        );
    });
});
