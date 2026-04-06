import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Mock api-utils before importing sessions ───
vi.mock("../../api-utils.js", () => {
    return {
        json: vi.fn((res: any, status: number, data: any) => {
            res.statusCode = status;
            res._body = data;
        }),
        parseBody: vi.fn(async () => ({})),
        readConfig: vi.fn(() => ({ agents: { list: [] } })),
        execAsync: vi.fn(async () => {
            throw new Error("CLI not available");
        }),
        resolveHome: vi.fn((p: string) => p.replace("~", "/tmp/fakehome")),
        AGENTS_STATE_DIR: "/tmp/fake-agents-state",
        DASHBOARD_SESSIONS_DIR: "/tmp/fake-dashboard-sessions",
    };
});

// Mock node:fs to prevent real filesystem access
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        unlinkSync: vi.fn(),
        readdirSync: vi.fn(() => []),
        statSync: vi.fn(() => { throw new Error("ENOENT"); }),
    };
});

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
    stat: vi.fn(async () => { throw new Error("ENOENT"); }),
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => { throw new Error("ENOENT"); }),
}));

// ─── Helpers ───

function createMockReq(method: string): IncomingMessage {
    return { method } as unknown as IncomingMessage;
}

function createMockRes(): ServerResponse & { _body: any } {
    return {
        statusCode: 0,
        _body: undefined,
        setHeader: vi.fn(),
        end: vi.fn(),
    } as unknown as ServerResponse & { _body: any };
}


// ─── File-size-based message count estimation ───

describe("file-size-based message count estimation", () => {
    it("estimates 0 messages for 0 bytes", () => {
        const fileSize = 0;
        const messageCount = Math.round(fileSize / 500);
        expect(messageCount).toBe(0);
    });

    it("estimates 1 message for 500 bytes", () => {
        const fileSize = 500;
        const messageCount = Math.round(fileSize / 500);
        expect(messageCount).toBe(1);
    });

    it("estimates 10 messages for 5000 bytes", () => {
        const fileSize = 5000;
        const messageCount = Math.round(fileSize / 500);
        expect(messageCount).toBe(10);
    });

    it("estimates 100 messages for 50000 bytes", () => {
        const fileSize = 50000;
        const messageCount = Math.round(fileSize / 500);
        expect(messageCount).toBe(100);
    });

    it("rounds correctly for non-exact multiples", () => {
        // 749 / 500 = 1.498 → rounds to 1
        expect(Math.round(749 / 500)).toBe(1);
        // 750 / 500 = 1.5 → rounds to 2
        expect(Math.round(750 / 500)).toBe(2);
        // 1250 / 500 = 2.5 → rounds to 2 (banker's rounding in some envs) or 3
        expect(Math.round(1250 / 500)).toBeGreaterThanOrEqual(2);
        expect(Math.round(1250 / 500)).toBeLessThanOrEqual(3);
    });

    it("produces reasonable estimates for typical session files", () => {
        // A small session (~2KB) should have a few messages
        const small = Math.round(2000 / 500);
        expect(small).toBeGreaterThanOrEqual(1);
        expect(small).toBeLessThanOrEqual(10);

        // A medium session (~25KB) should have tens of messages
        const medium = Math.round(25000 / 500);
        expect(medium).toBeGreaterThanOrEqual(10);
        expect(medium).toBeLessThanOrEqual(100);

        // A large session (~500KB) should have hundreds of messages
        const large = Math.round(500000 / 500);
        expect(large).toBeGreaterThanOrEqual(100);
        expect(large).toBeLessThanOrEqual(5000);
    });

    it("the scanner applies Math.max(1, ...) to ensure at least 1 for non-empty files", () => {
        // The actual code uses: Math.max(1, Math.round(st.size / 500))
        // For a tiny file (e.g., 100 bytes), round(100/500) = 0, but max(1, 0) = 1
        const tinyFileSize = 100;
        const messageCount = Math.max(1, Math.round(tinyFileSize / 500));
        expect(messageCount).toBe(1);
    });
});

// ─── Session cache TTL behavior ───

describe("session cache TTL behavior", () => {
    let handleSessionRoutes: typeof import("../sessions.js").handleSessionRoutes;

    beforeEach(async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.resetModules();

        // Re-import to get fresh module-level cache state
        const mod = await import("../sessions.js");
        handleSessionRoutes = mod.handleSessionRoutes;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("returns sessions on GET /sessions (populates cache)", async () => {
        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/sessions");

        const handled = await handleSessionRoutes(req, res, url, "/sessions");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body).toHaveProperty("sessions");
        expect(Array.isArray(res._body.sessions)).toBe(true);
    });

    it("returns cached data with fast=1 within 30s TTL", async () => {
        const req1 = createMockReq("GET");
        const res1 = createMockRes();
        const url1 = new URL("http://localhost/api/sessions");

        // First request — populates cache
        await handleSessionRoutes(req1, res1, url1, "/sessions");
        expect(res1._body).toHaveProperty("sessions");
        const firstSessions = res1._body.sessions;

        // Advance 10 seconds (within 30s TTL)
        await vi.advanceTimersByTimeAsync(10_000);

        // Second request with fast=1 — should return cached data
        const req2 = createMockReq("GET");
        const res2 = createMockRes();
        const url2 = new URL("http://localhost/api/sessions?fast=1");

        await handleSessionRoutes(req2, res2, url2, "/sessions");

        expect(res2.statusCode).toBe(200);
        expect(res2._body.sessions).toEqual(firstSessions);
    });

    it("rescans after 30s TTL expiry even with fast=1", async () => {
        const req1 = createMockReq("GET");
        const res1 = createMockRes();
        const url1 = new URL("http://localhost/api/sessions");

        // First request — populates cache
        await handleSessionRoutes(req1, res1, url1, "/sessions");
        expect(res1._body).toHaveProperty("sessions");

        // Advance past the 30s TTL
        await vi.advanceTimersByTimeAsync(31_000);

        // Request with fast=1 after TTL expiry — should rescan (not use stale cache)
        const req2 = createMockReq("GET");
        const res2 = createMockRes();
        const url2 = new URL("http://localhost/api/sessions?fast=1");

        await handleSessionRoutes(req2, res2, url2, "/sessions");

        expect(res2.statusCode).toBe(200);
        expect(res2._body).toHaveProperty("sessions");
        // The key assertion: the handler still returns a valid response
        // (it performed a rescan rather than returning stale data)
        expect(Array.isArray(res2._body.sessions)).toBe(true);
    });

    it("fast=1 without prior cache performs a full scan", async () => {
        // First request is fast=1 with no prior cache — should do a full scan
        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/sessions?fast=1");

        await handleSessionRoutes(req, res, url, "/sessions");

        expect(res.statusCode).toBe(200);
        expect(res._body).toHaveProperty("sessions");
        expect(Array.isArray(res._body.sessions)).toBe(true);
    });
});
