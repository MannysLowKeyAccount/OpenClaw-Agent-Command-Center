import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";

const TEST_ROOT = join(tmpdir(), `sessions-threading-${process.pid}`);
const AGENTS_DIR = join(TEST_ROOT, "agents");
const DASH_DIR = join(TEST_ROOT, "dashboard-sessions");

function setupDir(fp: string): void {
    mkdirSync(fp, { recursive: true });
}

function writeJsonl(fp: string, agentId: string, channel: string, messageCount: number): void {
    const lines: string[] = [JSON.stringify({ type: "session", agentId, channel })];
    for (let i = 1; i <= messageCount; i++) {
        lines.push(JSON.stringify({ type: "message", message: { role: i % 2 === 0 ? "assistant" : "user", content: `${channel}-${i}` }, timestamp: `2026-04-21T10:${String(i).padStart(2, "0")}:00Z` }));
    }
    writeFileSync(fp, lines.join("\n") + "\n", "utf-8");
}

function createMockReq(method: string): IncomingMessage {
    return { method } as unknown as IncomingMessage;
}

function createMockRes(): ServerResponse & { _body: any } {
    return { statusCode: 0, _body: undefined, setHeader: vi.fn(), end: vi.fn() } as unknown as ServerResponse & { _body: any };
}

vi.mock("../../api-utils.js", () => {
    return {
        json: vi.fn((res: any, status: number, data: any) => { res.statusCode = status; res._body = data; }),
        parseBody: vi.fn(async () => ({ message: "hello", agentId: "alpha" })),
        readConfig: vi.fn(() => ({ agents: { list: [{ id: "alpha", subagents: { allowAgents: ["beta"] } }, { id: "beta", subagents: { allowAgents: [] } }] } })),
        execAsync: vi.fn(async () => { throw new Error("CLI not available"); }),
        resolveHome: vi.fn((p: string) => p.replace("~", TEST_ROOT)),
        tryReadFile: vi.fn((path: string) => {
            try { return readFileSync(path, "utf-8"); } catch { return null; }
        }),
        AGENTS_STATE_DIR: AGENTS_DIR,
        DASHBOARD_SESSIONS_DIR: DASH_DIR,
    };
});

describe("sessions threading and cursor APIs", () => {
    let handleSessionRoutes: typeof import("../sessions.js").handleSessionRoutes;
    let sessionIndex: Map<string, any>;
    let initSessionIndex: () => Promise<void>;

    beforeAll(() => {
        setupDir(AGENTS_DIR);
        setupDir(DASH_DIR);
    });

    afterAll(() => {
        try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { }
    });

    beforeEach(async () => {
        vi.resetModules();
        sessionIndex = (await import("../sessions.js")).sessionIndex;
        initSessionIndex = (await import("../sessions.js")).initSessionIndex;
        handleSessionRoutes = (await import("../sessions.js")).handleSessionRoutes;
        sessionIndex.clear();
        rmSync(TEST_ROOT, { recursive: true, force: true });
        setupDir(AGENTS_DIR);
        setupDir(DASH_DIR);
    });

    it("indexes exact message counts for large JSONL histories", async () => {
        const sessDir = join(AGENTS_DIR, "alpha", "sessions");
        mkdirSync(sessDir, { recursive: true });
        const fp = join(sessDir, "alpha-main.jsonl");
        writeJsonl(fp, "alpha", "cli", 600);
        writeFileSync(join(sessDir, "sessions.json"), JSON.stringify({ "agent:alpha:main": { sessionId: "alpha-main", agentId: "alpha", channel: "cli", updatedAt: "2026-04-21T10:00:00Z" } }, null, 2), "utf-8");

        await initSessionIndex();

        const entry = sessionIndex.get("alpha-main");
        expect(entry).toBeDefined();
        expect(entry?.messageCount).toBe(600);
    });

    it("returns agent thread summaries with attached subagent metadata", async () => {
        const alphaDir = join(AGENTS_DIR, "alpha", "sessions");
        const betaDir = join(AGENTS_DIR, "beta", "sessions");
        mkdirSync(alphaDir, { recursive: true });
        mkdirSync(betaDir, { recursive: true });
        writeJsonl(join(alphaDir, "alpha-main.jsonl"), "alpha", "cli", 3);
        writeJsonl(join(betaDir, "beta-sub.jsonl"), "beta", "cli", 2);
        writeFileSync(join(alphaDir, "sessions.json"), JSON.stringify({ "agent:alpha:main": { sessionId: "alpha-main", agentId: "alpha", channel: "cli" } }, null, 2), "utf-8");
        writeFileSync(join(betaDir, "sessions.json"), JSON.stringify({ "agent:beta:subagent:alpha": { sessionId: "beta-sub", agentId: "beta", channel: "cli" } }, null, 2), "utf-8");

        await initSessionIndex();

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/sessions/agent/alpha");
        const handled = await handleSessionRoutes(req, res, url, "/sessions/agent/alpha");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.primaryThread).toBeTruthy();
        expect(res._body.primaryThread.kind).toBe("primary");
        expect(res._body.primaryThread.rootSessionKey).toBe("alpha-main");
        expect(res._body.primaryThread.attachedThreads).toHaveLength(1);
        expect(res._body.primaryThread.attachedThreads[0].agentId).toBe("beta");
        expect(res._body.primaryThread.attachedThreads[0].readOnly).toBe(true);
        expect(res._body.primaryThread.attachedThreads[0].kind).toBe("subagent");
        expect(res._body.primaryThread.attachedThreads[0].parentSessionKey).toBe("alpha-main");
        expect(res._body.threads.some((t: any) => t.sessionKey === "beta-sub" && t.kind === "subagent")).toBe(true);
    });

    it("keeps a child agent's own main thread primary", async () => {
        const alphaDir = join(AGENTS_DIR, "alpha", "sessions");
        const betaDir = join(AGENTS_DIR, "beta", "sessions");
        mkdirSync(alphaDir, { recursive: true });
        mkdirSync(betaDir, { recursive: true });
        writeJsonl(join(betaDir, "beta-main.jsonl"), "beta", "cli", 2);
        writeFileSync(join(alphaDir, "sessions.json"), JSON.stringify({ "agent:alpha:main": { sessionId: "alpha-main", agentId: "alpha", channel: "cli" } }, null, 2), "utf-8");
        writeFileSync(join(betaDir, "sessions.json"), JSON.stringify({ "agent:beta:main": { sessionId: "beta-main", agentId: "beta", channel: "cli" } }, null, 2), "utf-8");

        await initSessionIndex();

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/sessions/agent/beta");
        const handled = await handleSessionRoutes(req, res, url, "/sessions/agent/beta");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.primaryThread.kind).toBe("primary");
        expect(res._body.primaryThread.readOnly).toBe(false);
        expect(res._body.threads.some((t: any) => t.sessionKey === "beta-main" && t.kind === "primary")).toBe(true);
    });

    it("prefers a ready real primary over a missing synthetic dashboard primary", async () => {
        sessionIndex.set("dashboard:alpha:main", {
            sessionKey: "dashboard:alpha:main",
            agentId: "alpha",
            filePath: "",
            channel: "dashboard",
            gatewayKey: "agent:alpha:explicit:dashboard:alpha:main",
            messageCount: 0,
            updatedAt: "2026-04-21T11:00:00Z",
            mtime: 0,
        });
        sessionIndex.set("real-alpha-session", {
            sessionKey: "real-alpha-session",
            agentId: "alpha",
            filePath: join(AGENTS_DIR, "alpha", "sessions", "real-alpha-session.jsonl"),
            channel: "webchat",
            gatewayKey: "agent:alpha:main",
            messageCount: 2,
            updatedAt: "2026-04-21T10:00:00Z",
            mtime: 1,
        });

        const req = createMockReq("GET");
        const res = createMockRes();
        const url = new URL("http://localhost/api/sessions/agent/alpha");
        const handled = await handleSessionRoutes(req, res, url, "/sessions/agent/alpha");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res._body.primaryThread.sessionKey).toBe("real-alpha-session");
        expect(res._body.primaryThread.status).toBe("ready");
    });

    it("resolves the real primary session key when a stale synthetic primary exists", async () => {
        const { resolveGatewaySessionId } = await import("../sessions.js");
        sessionIndex.set("dashboard:alpha:main", {
            sessionKey: "dashboard:alpha:main",
            agentId: "alpha",
            filePath: "",
            channel: "dashboard",
            gatewayKey: "agent:alpha:explicit:dashboard:alpha:main",
            messageCount: 0,
            updatedAt: "2026-04-21T11:00:00Z",
            mtime: 0,
        });
        sessionIndex.set("real-alpha-session", {
            sessionKey: "real-alpha-session",
            agentId: "alpha",
            filePath: join(AGENTS_DIR, "alpha", "sessions", "real-alpha-session.jsonl"),
            channel: "webchat",
            gatewayKey: "agent:alpha:main",
            messageCount: 2,
            updatedAt: "2026-04-21T10:00:00Z",
            mtime: 1,
        });

        const resolved = resolveGatewaySessionId("alpha", "dashboard:alpha:main", sessionIndex.get("dashboard:alpha:main"), {
            agents: { list: [{ id: "alpha", subagents: { allowAgents: ["beta"] } }] },
        });

        expect(resolved).toBe("real-alpha-session");
        expect(resolved).not.toBe("dashboard:alpha:main");
    });

    it("returns empty gateway session id when only a stale synthetic primary exists", async () => {
        const { resolveGatewaySessionId } = await import("../sessions.js");
        sessionIndex.set("dashboard:alpha:main", {
            sessionKey: "dashboard:alpha:main",
            agentId: "alpha",
            filePath: "",
            channel: "dashboard",
            gatewayKey: "agent:alpha:explicit:dashboard:alpha:main",
            messageCount: 0,
            updatedAt: "2026-04-21T11:00:00Z",
            mtime: 0,
        });

        const resolved = resolveGatewaySessionId("alpha", "dashboard:alpha:main", sessionIndex.get("dashboard:alpha:main"), {
            agents: { list: [{ id: "alpha", subagents: { allowAgents: ["beta"] } }] },
        });

        expect(resolved).toBe("");
    });

    it("supports cursor-based backfill and delta history pages", async () => {
        const sessDir = join(AGENTS_DIR, "alpha", "sessions");
        mkdirSync(sessDir, { recursive: true });
        const fp = join(sessDir, "alpha-main.jsonl");
        writeJsonl(fp, "alpha", "cli", 4);
        writeFileSync(join(sessDir, "sessions.json"), JSON.stringify({ "agent:alpha:main": { sessionId: "alpha-main", agentId: "alpha", channel: "cli" } }, null, 2), "utf-8");

        await initSessionIndex();

        const firstReq = createMockReq("GET");
        const firstRes = createMockRes();
        const firstUrl = new URL("http://localhost/api/sessions/alpha-main/messages?limit=2");
        await handleSessionRoutes(firstReq, firstRes, firstUrl, "/sessions/alpha-main/messages");
        expect(firstRes._body.thread.kind).toBe("primary");
        expect(firstRes._body.session.messages).toHaveLength(2);
        expect(firstRes._body.session.cursor.startSeq).toBe(3);
        expect(firstRes._body.session.cursor.endSeq).toBe(4);
        expect(firstRes._body.session.cursor.hasMoreBefore).toBe(true);

        const deltaReq = createMockReq("GET");
        const deltaRes = createMockRes();
        const deltaUrl = new URL("http://localhost/api/sessions/alpha-main/messages?after=2&limit=10");
        await handleSessionRoutes(deltaReq, deltaRes, deltaUrl, "/sessions/alpha-main/messages");
        expect(deltaRes._body.session.messages).toHaveLength(2);
        expect(deltaRes._body.session.messages[0].seq).toBe(3);
        expect(deltaRes._body.session.messages[1].seq).toBe(4);
        expect(deltaRes._body.session.cursor.hasMoreBefore).toBe(true);
    });

    it("rejects writes to attached subagent threads", async () => {
        const alphaDir = join(AGENTS_DIR, "alpha", "sessions");
        const betaDir = join(AGENTS_DIR, "beta", "sessions");
        mkdirSync(alphaDir, { recursive: true });
        mkdirSync(betaDir, { recursive: true });
        writeJsonl(join(alphaDir, "alpha-main.jsonl"), "alpha", "cli", 1);
        writeJsonl(join(betaDir, "beta-sub.jsonl"), "beta", "cli", 1);
        writeFileSync(join(alphaDir, "sessions.json"), JSON.stringify({ "agent:alpha:main": { sessionId: "alpha-main", agentId: "alpha", channel: "cli" } }, null, 2), "utf-8");
        writeFileSync(join(betaDir, "sessions.json"), JSON.stringify({ "agent:beta:subagent:alpha": { sessionId: "beta-sub", agentId: "beta", channel: "cli" } }, null, 2), "utf-8");

        await initSessionIndex();

        const req = createMockReq("POST");
        const res = createMockRes();
        const url = new URL("http://localhost/api/sessions/beta-sub/message");
        const handled = await handleSessionRoutes(req, res, url, "/sessions/beta-sub/message");

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(403);
        expect(res._body.readOnly).toBe(true);
    });
});
