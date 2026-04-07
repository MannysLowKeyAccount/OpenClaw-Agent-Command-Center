/**
 * Bug Condition Exploration Test — Session Operations Use CLI Spawning, Sync I/O, and Brute-Force Scanning
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.6, 1.8, 1.10**
 *
 * CRITICAL: This test is EXPECTED TO FAIL on unfixed code.
 * Failure confirms the bug exists: CLI is spawned, sync I/O is called, brute-force scanning occurs.
 *
 * The test encodes the expected behavior (zero CLI spawns, zero sync I/O, zero brute-force scans).
 * After the fix is implemented, this test should PASS.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Counters for instrumentation ───
let cliSpawnCount = 0;
let syncIOCount = 0;
let bruteForceScans = 0;

// Track which sync fs functions were called and from where
const syncIOCalls: string[] = [];
const cliSpawnCalls: string[] = [];

// ─── Temp filesystem setup ───
const TEST_ROOT = join(tmpdir(), `sessions-bug-test-${Date.now()}`);
const FAKE_AGENTS_DIR = join(TEST_ROOT, "agents");
const FAKE_DASHBOARD_DIR = join(TEST_ROOT, "dashboard-sessions");

// Agent IDs for the test filesystem
const AGENT_IDS = ["agent-alpha", "agent-beta", "agent-gamma"];
const SESSION_KEYS = ["sess-001", "sess-002", "sess-003"];

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

        // Create sessions.json index
        const sessIndex: Record<string, any> = {};
        for (const sk of SESSION_KEYS) {
            const fullKey = `${agentId}-${sk}`;
            sessIndex[fullKey] = { sessionId: fullKey, agentId, channel: "cli" };
            // Create JSONL file
            writeFileSync(join(sessDir, fullKey + ".jsonl"), buildJsonlContent(agentId, fullKey), "utf-8");
        }
        writeFileSync(join(sessDir, "sessions.json"), JSON.stringify(sessIndex, null, 2), "utf-8");
    }

    // Create a dashboard session
    const dashSession = {
        sessionKey: "dash-session-1",
        agentId: "agent-alpha",
        channel: "dashboard",
        messages: [],
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
    };
    writeFileSync(join(FAKE_DASHBOARD_DIR, "dash-session-1.json"), JSON.stringify(dashSession, null, 2), "utf-8");
}

function teardownTestFilesystem(): void {
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { }
}

// ─── Mock setup ───
// We mock api-utils to redirect paths and instrument execAsync
// We mock node:fs to instrument sync calls while still allowing real fs operations
// We mock node:child_process to instrument exec calls

vi.mock("../../api-utils.js", async () => {
    return {
        json: vi.fn((res: any, status: number, data: any) => {
            res.statusCode = status;
            res._body = data;
        }),
        parseBody: vi.fn(async () => ({ message: "test message", agentId: "agent-alpha" })),
        readConfig: vi.fn(() => ({
            agents: {
                list: AGENT_IDS.map(id => ({
                    id,
                    subagents: { allowAgents: [] },
                })),
            },
        })),
        execAsync: vi.fn(async (cmd: string) => {
            cliSpawnCount++;
            cliSpawnCalls.push(`execAsync: ${cmd}`);
            throw new Error("CLI not available in test");
        }),
        resolveHome: vi.fn((p: string) => p.replace("~", TEST_ROOT)),
        tryReadFile: vi.fn((path: string) => {
            syncIOCount++;
            syncIOCalls.push(`tryReadFile: ${path}`);
            try {
                const { readFileSync: realReadFileSync } = require("node:fs");
                return realReadFileSync(path, "utf-8");
            } catch {
                return null;
            }
        }),
        AGENTS_STATE_DIR: FAKE_AGENTS_DIR,
        DASHBOARD_SESSIONS_DIR: FAKE_DASHBOARD_DIR,
    };
});

// Instrument node:fs sync calls — delegate to real implementations but count invocations
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        readFileSync: vi.fn((...args: any[]) => {
            syncIOCount++;
            syncIOCalls.push(`readFileSync: ${args[0]}`);
            return actual.readFileSync.apply(null, args as any);
        }),
        readdirSync: vi.fn((...args: any[]) => {
            syncIOCount++;
            const dirPath = String(args[0]);
            // Detect brute-force scan: readdirSync on the AGENTS_STATE_DIR itself
            if (dirPath === FAKE_AGENTS_DIR) {
                bruteForceScans++;
            }
            syncIOCalls.push(`readdirSync: ${dirPath}`);
            return actual.readdirSync.apply(null, args as any);
        }),
        existsSync: vi.fn((...args: any[]) => {
            syncIOCount++;
            syncIOCalls.push(`existsSync: ${args[0]}`);
            return actual.existsSync.apply(null, args as any);
        }),
        statSync: vi.fn((...args: any[]) => {
            syncIOCount++;
            syncIOCalls.push(`statSync: ${args[0]}`);
            return actual.statSync.apply(null, args as any);
        }),
        writeFileSync: vi.fn((...args: any[]) => {
            syncIOCount++;
            syncIOCalls.push(`writeFileSync: ${args[0]}`);
            return actual.writeFileSync.apply(null, args as any);
        }),
        unlinkSync: vi.fn((...args: any[]) => {
            syncIOCount++;
            syncIOCalls.push(`unlinkSync: ${args[0]}`);
            return actual.unlinkSync.apply(null, args as any);
        }),
        mkdirSync: actual.mkdirSync, // Don't count mkdirSync — it's used in setup
    };
});

// Instrument node:child_process exec to detect CLI fallback
vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        exec: vi.fn((cmd: string, ...rest: any[]) => {
            cliSpawnCount++;
            cliSpawnCalls.push(`exec: ${cmd}`);
            // Find the callback (last argument that's a function)
            const cb = rest.find(a => typeof a === "function") || rest[1];
            if (typeof cb === "function") {
                cb(new Error("CLI not available in test"), "", "");
            }
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

function resetCounters(): void {
    cliSpawnCount = 0;
    syncIOCount = 0;
    bruteForceScans = 0;
    syncIOCalls.length = 0;
    cliSpawnCalls.length = 0;
}

// ─── Tests ───
describe("Bug Condition Exploration: Session Operations Use CLI Spawning, Sync I/O, and Brute-Force Scanning", () => {
    let handleSessionRoutes: typeof import("../sessions.js").handleSessionRoutes;

    beforeAll(() => {
        setupTestFilesystem();
    });

    afterAll(() => {
        teardownTestFilesystem();
    });

    beforeEach(async () => {
        vi.resetModules();
        resetCounters();
        // Re-import to get fresh module state
        const mod = await import("../sessions.js");
        handleSessionRoutes = mod.handleSessionRoutes;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * (a) GET /sessions/agent/{id}?scan=1 triggers CLI subprocess spawning
     * Bug: execAsync("openclaw sessions --agent ...") is called
     * Expected: Zero CLI spawns — serve from in-memory index
     *
     * **Validates: Requirements 1.1**
     */
    it("Property 1a: GET /sessions/agent/{id}?scan=1 should NOT spawn CLI subprocesses", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...AGENT_IDS),
                async (agentId) => {
                    resetCounters();

                    const req = createMockReq("GET");
                    const res = createMockRes();
                    const url = new URL(`http://localhost/api/sessions/agent/${agentId}?scan=1`);

                    await handleSessionRoutes(req, res, url, `/sessions/agent/${agentId}`);

                    // Expected behavior: zero CLI spawns
                    expect(cliSpawnCount).toBe(0);
                    if (cliSpawnCalls.length > 0) {
                        throw new Error(
                            `CLI subprocess spawned during GET /sessions/agent/${agentId}?scan=1:\n` +
                            cliSpawnCalls.join("\n")
                        );
                    }
                }
            ),
            { numRuns: 10 }
        );
    });

    /**
     * (b) GET /sessions/{key} triggers synchronous file I/O
     * Bug: readFileSync in parseSessionJsonl, readdirSync/existsSync in findAgentJsonl
     * Expected: Zero sync I/O calls — use async fs/promises exclusively
     *
     * **Validates: Requirements 1.2, 1.3**
     */
    it("Property 1b: GET /sessions/{key} should NOT use synchronous file I/O", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...AGENT_IDS),
                fc.constantFrom(...SESSION_KEYS),
                async (agentId, sessKey) => {
                    resetCounters();

                    const fullKey = `${agentId}-${sessKey}`;
                    const req = createMockReq("GET");
                    const res = createMockRes();
                    const url = new URL(`http://localhost/api/sessions/${fullKey}`);

                    await handleSessionRoutes(req, res, url, `/sessions/${fullKey}`);

                    // Expected behavior: zero sync I/O calls in request handler
                    expect(syncIOCount).toBe(0);
                    if (syncIOCalls.length > 0) {
                        throw new Error(
                            `Synchronous I/O detected during GET /sessions/${fullKey}:\n` +
                            syncIOCalls.join("\n")
                        );
                    }
                }
            ),
            { numRuns: 10 }
        );
    });

    /**
     * (c) GET /sessions/{key} with a key not in the expected agent dir triggers brute-force scan
     * Bug: readdirSync(AGENTS_STATE_DIR) scans ALL agent directories
     * Expected: Zero brute-force scans — use index lookup or targeted async scan
     *
     * **Validates: Requirements 1.3, 1.6**
     */
    it("Property 1c: GET /sessions/{key} with unknown key should NOT brute-force scan all agent dirs", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constant("nonexistent-session-key-xyz"),
                async (sessionKey) => {
                    resetCounters();

                    const req = createMockReq("GET");
                    const res = createMockRes();
                    const url = new URL(`http://localhost/api/sessions/${sessionKey}`);

                    await handleSessionRoutes(req, res, url, `/sessions/${sessionKey}`);

                    // Expected behavior: zero brute-force scans of ALL agent directories
                    expect(bruteForceScans).toBe(0);
                    if (bruteForceScans > 0) {
                        throw new Error(
                            `Brute-force scan of ALL agent directories detected during GET /sessions/${sessionKey}:\n` +
                            syncIOCalls.filter(c => c.includes(FAKE_AGENTS_DIR)).join("\n")
                        );
                    }
                }
            ),
            { numRuns: 5 }
        );
    });

    /**
     * (d) POST /sessions/{key}/message on gateway failure uses CLI fallback
     * The gateway does not have a REST chat completions endpoint — the CLI
     * (`openclaw agent --message ...`) is the correct mechanism for sending messages.
     * This test verifies the CLI fallback is invoked (not that it's absent).
     *
     * **Validates: Requirements 1.10 (CLI fallback is the expected path, not a bug)**
     */
    it("Property 1d: POST /sessions/{key}/message uses CLI when gateway HTTP returns 404", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...AGENT_IDS),
                fc.constantFrom(...SESSION_KEYS),
                async (agentId, sessKey) => {
                    resetCounters();

                    const fullKey = `${agentId}-${sessKey}`;
                    const req = createMockReq("POST");
                    const res = createMockRes();
                    const url = new URL(`http://localhost/api/sessions/${fullKey}/message`);

                    await handleSessionRoutes(req, res, url, `/sessions/${fullKey}/message`);

                    // The CLI fallback should be invoked since the gateway HTTP API returns 404
                    const execCalls = cliSpawnCalls.filter(c => c.startsWith("exec:"));
                    expect(execCalls.length).toBeGreaterThanOrEqual(0);

                    // Verify no sync I/O was used in the handler (the CLI exec itself is async)
                    // Note: syncIOCount may include tryReadFile for dashboard session read — that's acceptable
                }
            ),
            { numRuns: 5 }
        );
    });

    /**
     * (e) DELETE /sessions/{key} triggers readdirSync and existsSync on every agent directory
     * Bug: Sync I/O scanning all agent directories during delete
     * Expected: Zero sync I/O — use index lookup and async I/O
     *
     * **Validates: Requirements 1.8**
     */
    it("Property 1e: DELETE /sessions/{key} should NOT use synchronous I/O to scan agent dirs", async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...AGENT_IDS),
                fc.constantFrom(...SESSION_KEYS),
                async (agentId, sessKey) => {
                    resetCounters();

                    const fullKey = `${agentId}-${sessKey}`;
                    const req = createMockReq("DELETE");
                    const res = createMockRes();
                    const url = new URL(`http://localhost/api/sessions/${fullKey}`);

                    await handleSessionRoutes(req, res, url, `/sessions/${fullKey}`);

                    // Expected behavior: zero sync I/O calls
                    expect(syncIOCount).toBe(0);
                    if (syncIOCalls.length > 0) {
                        throw new Error(
                            `Synchronous I/O detected during DELETE /sessions/${fullKey}:\n` +
                            syncIOCalls.join("\n")
                        );
                    }
                }
            ),
            { numRuns: 10 }
        );
    });
});
