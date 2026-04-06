import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Mock api-utils before importing providers ───
vi.mock("../../api-utils.js", () => {
    return {
        json: vi.fn((res: any, status: number, data: any) => {
            res.statusCode = status;
            res._body = data;
        }),
        readConfig: vi.fn(() => ({})),
        readEnv: vi.fn(() => ({
            ANTHROPIC_API_KEY: "sk-ant-test1234",
        })),
        httpsGet: vi.fn(async () => ({
            status: 200,
            body: JSON.stringify({
                data: [
                    { id: "claude-3-opus" },
                    { id: "claude-3-sonnet" },
                ],
            }),
            rawHeaders: {},
        })),
        OPENCLAW_DIR: "/tmp/fake-openclaw",
        AGENTS_STATE_DIR: "/tmp/fake-openclaw/agents",
    };
});

// Mock node:fs to prevent real filesystem reads in _scanAllProviders
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        existsSync: vi.fn(() => false),
        readFileSync: actual.readFileSync,
    };
});

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

// ─── Tests ───

describe("providers route — parameterized scanner output shape", () => {
    // We need a fresh module for each test group to reset module-level cache state
    let handleProviderRoutes: typeof import("../providers.js").handleProviderRoutes;
    let getProviderCache: typeof import("../providers.js").getProviderCache;
    let httpsGetMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });

        // Reset module-level state by re-importing
        vi.resetModules();

        const apiUtils = await import("../../api-utils.js");
        httpsGetMock = apiUtils.httpsGet as ReturnType<typeof vi.fn>;

        // Default: Anthropic returns 200 with models
        httpsGetMock.mockResolvedValue({
            status: 200,
            body: JSON.stringify({
                data: [
                    { id: "claude-3-opus" },
                    { id: "claude-3-sonnet" },
                ],
            }),
            rawHeaders: {},
        });

        const mod = await import("../providers.js");
        handleProviderRoutes = mod.handleProviderRoutes;
        getProviderCache = mod.getProviderCache;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("returns provider result with correct shape on GET /models/status", async () => {
        // Advance past the initial 3s startup delay so the cache builds
        await vi.advanceTimersByTimeAsync(4000);

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/models/status");

        const handled = await handleProviderRoutes(req, res, url, "/models/status");

        expect(handled).toBe(true);

        const body = res._body;
        expect(body).toBeDefined();
        expect(body).toHaveProperty("providers");
        expect(body).toHaveProperty("cachedAt");
        expect(Array.isArray(body.providers)).toBe(true);

        // At least one provider (Anthropic) should be present since we mocked the key
        const anthropic = body.providers.find((p: any) => p.provider === "Anthropic");
        expect(anthropic).toBeDefined();
        expect(anthropic).toHaveProperty("provider", "Anthropic");
        expect(anthropic).toHaveProperty("keyHint");
        expect(anthropic.keyHint).toMatch(/^\.\.\./);
        expect(anthropic).toHaveProperty("status", "ok");
        expect(anthropic).toHaveProperty("httpStatus", 200);
        expect(anthropic).toHaveProperty("models");
        expect(Array.isArray(anthropic.models)).toBe(true);
        expect(anthropic).toHaveProperty("billing");
        expect(anthropic).toHaveProperty("source");
        expect(anthropic).toHaveProperty("envVar", "ANTHROPIC_API_KEY");
    });

    it("marks provider as error when HTTP request fails", async () => {
        httpsGetMock.mockRejectedValue(new Error("Connection refused"));

        // Advance past startup delay
        await vi.advanceTimersByTimeAsync(4000);

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/models/status");

        await handleProviderRoutes(req, res, url, "/models/status");

        const body = res._body;
        const anthropic = body.providers.find((p: any) => p.provider === "Anthropic");
        expect(anthropic).toBeDefined();
        expect(anthropic.status).toBe("error");
        expect(anthropic.note).toContain("Connection refused");
    });
});

describe("providers route — stale-while-revalidate", () => {
    let handleProviderRoutes: typeof import("../providers.js").handleProviderRoutes;
    let getProviderCache: typeof import("../providers.js").getProviderCache;
    let httpsGetMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.resetModules();

        const apiUtils = await import("../../api-utils.js");
        httpsGetMock = apiUtils.httpsGet as ReturnType<typeof vi.fn>;

        httpsGetMock.mockResolvedValue({
            status: 200,
            body: JSON.stringify({ data: [{ id: "claude-3-opus" }] }),
            rawHeaders: {},
        });

        const mod = await import("../providers.js");
        handleProviderRoutes = mod.handleProviderRoutes;
        getProviderCache = mod.getProviderCache;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("serves stale cache immediately and triggers background refresh", async () => {
        // Let the initial cache build complete
        await vi.advanceTimersByTimeAsync(4000);

        // First request — populates cache
        const req1 = createMockReq("GET");
        const res1 = createMockRes();
        await handleProviderRoutes(req1, res1, new URL("http://localhost/api/models/status"), "/models/status");
        expect(res1._body).toBeDefined();
        const firstCachedAt = res1._body.cachedAt;

        // Advance time past the 5-minute TTL
        await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

        // Update mock to return different data for the background refresh
        httpsGetMock.mockResolvedValue({
            status: 200,
            body: JSON.stringify({ data: [{ id: "claude-4-opus" }] }),
            rawHeaders: {},
        });

        // Second request — should serve stale cache immediately
        const req2 = createMockReq("GET");
        const res2 = createMockRes();
        await handleProviderRoutes(req2, res2, new URL("http://localhost/api/models/status"), "/models/status");

        // Should get the stale data back immediately (same cachedAt)
        expect(res2._body).toBeDefined();
        expect(res2._body.cachedAt).toBe(firstCachedAt);

        // Let the background refresh complete
        await vi.advanceTimersByTimeAsync(1000);

        // Third request — should get refreshed data
        const req3 = createMockReq("GET");
        const res3 = createMockRes();
        await handleProviderRoutes(req3, res3, new URL("http://localhost/api/models/status"), "/models/status");

        expect(res3._body.cachedAt).not.toBe(firstCachedAt);
    });

    it("getProviderCache returns cached data after build", async () => {
        // Initially null
        expect(getProviderCache()).toBeNull();

        // Let the startup build complete
        await vi.advanceTimersByTimeAsync(4000);

        // Trigger a request to ensure cache is populated
        const req = createMockReq("GET");
        const res = createMockRes();
        await handleProviderRoutes(req, res, new URL("http://localhost/api/models/status"), "/models/status");

        const cache = getProviderCache();
        expect(cache).not.toBeNull();
        expect(cache).toHaveProperty("providers");
        expect(cache).toHaveProperty("cachedAt");
    });
});

describe("providers route — build deduplication", () => {
    let handleProviderRoutes: typeof import("../providers.js").handleProviderRoutes;
    let httpsGetMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.resetModules();

        const apiUtils = await import("../../api-utils.js");
        httpsGetMock = apiUtils.httpsGet as ReturnType<typeof vi.fn>;

        // Use a slow response to make deduplication observable
        httpsGetMock.mockImplementation(() =>
            new Promise((resolve) =>
                setTimeout(() => resolve({
                    status: 200,
                    body: JSON.stringify({ data: [{ id: "claude-3-opus" }] }),
                    rawHeaders: {},
                }), 500)
            )
        );

        const mod = await import("../providers.js");
        handleProviderRoutes = mod.handleProviderRoutes;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("concurrent requests share a single build (no duplicate builds)", async () => {
        // Clear any call count from module initialization
        httpsGetMock.mockClear();

        // Fire multiple concurrent requests before any cache exists
        const req1 = createMockReq("GET");
        const res1 = createMockRes();
        const req2 = createMockReq("GET");
        const res2 = createMockRes();
        const req3 = createMockReq("GET");
        const res3 = createMockRes();

        const url = new URL("http://localhost/api/models/status");

        // Start all three requests concurrently
        const p1 = handleProviderRoutes(req1, res1, url, "/models/status");
        const p2 = handleProviderRoutes(req2, res2, url, "/models/status");
        const p3 = handleProviderRoutes(req3, res3, url, "/models/status");

        // Advance timers to let the build complete
        await vi.advanceTimersByTimeAsync(2000);

        await Promise.all([p1, p2, p3]);

        // All three should have received the same response
        expect(res1._body).toBeDefined();
        expect(res2._body).toBeDefined();
        expect(res3._body).toBeDefined();
        expect(res1._body.cachedAt).toBe(res2._body.cachedAt);
        expect(res2._body.cachedAt).toBe(res3._body.cachedAt);

        // httpsGet should have been called only once per provider (not 3x per provider)
        // With only ANTHROPIC_API_KEY set, we expect exactly 1 call for Anthropic models
        // (other providers have no keys so they return null without calling httpsGet)
        // Plus the billing fetcher call for Anthropic = 2 calls total for one build
        // The key assertion: the count should be the same as a single build, not 3x
        const callCount = httpsGetMock.mock.calls.length;
        expect(callCount).toBeLessThanOrEqual(3); // single build: models + billing for Anthropic
    });
});
