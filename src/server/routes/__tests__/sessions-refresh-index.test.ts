import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

const AGENTS_DIR = join("/tmp", "fake-agents-state");
const DASH_DIR = join("/tmp", "fake-dashboard-sessions");

// ─── Mock api-utils before importing sessions ───
vi.mock("../../api-utils.js", () => ({
    json: vi.fn(),
    parseBody: vi.fn(async () => ({})),
    readConfig: vi.fn(() => ({ agents: { list: [] } })),
    execAsync: vi.fn(async () => { throw new Error("CLI not available"); }),
    resolveHome: vi.fn((p: string) => p.replace("~", join("/tmp", "fakehome"))),
    tryReadFile: vi.fn(() => null),
    AGENTS_STATE_DIR: AGENTS_DIR,
    DASHBOARD_SESSIONS_DIR: DASH_DIR,
}));

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

const mockStat = vi.fn();
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();

vi.mock("node:fs/promises", () => ({
    stat: mockStat,
    readdir: mockReaddir,
    readFile: mockReadFile,
}));

// Helper to build agent session paths
const agentSessDir = (agentId: string) => join(AGENTS_DIR, agentId, "sessions");
const agentSessFile = (agentId: string, file: string) => join(AGENTS_DIR, agentId, "sessions", file);
const dashFile = (file: string) => join(DASH_DIR, file);

describe("refreshSessionIndex", () => {
    let sessionIndex: Map<string, any>;
    let refreshSessionIndex: () => Promise<void>;

    beforeEach(async () => {
        vi.resetModules();
        mockStat.mockReset();
        mockReaddir.mockReset();
        mockReadFile.mockReset();

        mockStat.mockRejectedValue(new Error("ENOENT"));
        mockReaddir.mockRejectedValue(new Error("ENOENT"));
        mockReadFile.mockRejectedValue(new Error("ENOENT"));

        const mod = await import("../sessions.js");
        sessionIndex = mod.sessionIndex;
        refreshSessionIndex = mod.refreshSessionIndex;
        sessionIndex.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("skips entries whose mtime has not changed", async () => {
        const fp = agentSessFile("agent-a", "sess-1.jsonl");
        sessionIndex.set("sess-1", {
            sessionKey: "sess-1", agentId: "agent-a", filePath: fp,
            channel: "cli", messageCount: 5, updatedAt: "2024-01-01T00:00:00.000Z", mtime: 1000,
        });

        mockStat.mockImplementation(async (p: string) => {
            if (p === fp) return { mtimeMs: 1000, mtime: new Date(1000), size: 2500 };
            throw new Error("ENOENT");
        });
        mockReaddir.mockRejectedValue(new Error("ENOENT"));

        await refreshSessionIndex();

        const entry = sessionIndex.get("sess-1")!;
        expect(entry.mtime).toBe(1000);
        expect(entry.messageCount).toBe(5);
        expect(entry.channel).toBe("cli");
    });

    it("re-reads header when mtime has changed", async () => {
        const fp = agentSessFile("agent-b", "sess-2.jsonl");
        sessionIndex.set("sess-2", {
            sessionKey: "sess-2", agentId: "agent-b", filePath: fp,
            channel: "old-channel", messageCount: 3, updatedAt: "2024-01-01T00:00:00.000Z", mtime: 1000,
        });

        mockStat.mockImplementation(async (p: string) => {
            if (p === fp) return { mtimeMs: 2000, mtime: new Date(2000), size: 5000 };
            throw new Error("ENOENT");
        });
        mockReadFile.mockImplementation(async (p: string) => {
            if (p === fp) return '{"type":"session","agentId":"agent-b","channel":"new-channel"}\n';
            throw new Error("ENOENT");
        });
        mockReaddir.mockRejectedValue(new Error("ENOENT"));

        await refreshSessionIndex();

        const entry = sessionIndex.get("sess-2")!;
        expect(entry.mtime).toBe(2000);
        expect(entry.channel).toBe("new-channel");
        expect(entry.messageCount).toBe(0);
    });

    it("removes entries for files that no longer exist", async () => {
        sessionIndex.set("sess-gone", {
            sessionKey: "sess-gone", agentId: "agent-c",
            filePath: agentSessFile("agent-c", "sess-gone.jsonl"),
            channel: "cli", messageCount: 1, updatedAt: null, mtime: 500,
        });

        mockStat.mockRejectedValue(new Error("ENOENT"));
        mockReaddir.mockRejectedValue(new Error("ENOENT"));

        await refreshSessionIndex();

        expect(sessionIndex.has("sess-gone")).toBe(false);
    });

    it("discovers new files from agent session directories", async () => {
        const sessDir = agentSessDir("agent-x");
        const fp = agentSessFile("agent-x", "new-sess.jsonl");

        mockStat.mockImplementation(async (p: string) => {
            if (p === sessDir) return { mtimeMs: 100, mtime: new Date(100), size: 0 };
            if (p === fp) return { mtimeMs: 3000, mtime: new Date(3000), size: 1500 };
            throw new Error("ENOENT");
        });
        mockReaddir.mockImplementation(async (p: string) => {
            if (p === AGENTS_DIR) return ["agent-x"];
            if (p === sessDir) return ["new-sess.jsonl"];
            throw new Error("ENOENT");
        });
        mockReadFile.mockImplementation(async (p: string) => {
            if (p === fp) return '{"type":"session","agentId":"agent-x","channel":"gateway"}\n';
            throw new Error("ENOENT");
        });

        await refreshSessionIndex();

        expect(sessionIndex.has("new-sess")).toBe(true);
        const entry = sessionIndex.get("new-sess")!;
        expect(entry.agentId).toBe("agent-x");
        expect(entry.channel).toBe("gateway");
        expect(entry.filePath).toBe(fp);
    });

    it("discovers new dashboard session files", async () => {
        const fp = dashFile("dash-1.json");

        mockStat.mockImplementation(async (p: string) => {
            if (p === fp) return { mtimeMs: 4000, mtime: new Date(4000), size: 200 };
            throw new Error("ENOENT");
        });
        mockReaddir.mockImplementation(async (p: string) => {
            if (p === AGENTS_DIR) return [];
            if (p === DASH_DIR) return ["dash-1.json"];
            throw new Error("ENOENT");
        });
        mockReadFile.mockImplementation(async (p: string) => {
            if (p === fp) return JSON.stringify({
                sessionKey: "dash-1", agentId: "my-agent", channel: "dashboard",
                messages: [{ role: "user", content: "hello" }], updatedAt: "2024-06-01T00:00:00.000Z",
            });
            throw new Error("ENOENT");
        });

        await refreshSessionIndex();

        expect(sessionIndex.has("dash-1")).toBe(true);
        const entry = sessionIndex.get("dash-1")!;
        expect(entry.agentId).toBe("my-agent");
        expect(entry.channel).toBe("dashboard");
        expect(entry.messageCount).toBe(1);
    });

    it("does not overwrite existing agent entries with dashboard entries", async () => {
        const agentFp = agentSessFile("agent-z", "shared-key.jsonl");
        sessionIndex.set("shared-key", {
            sessionKey: "shared-key", agentId: "agent-z", filePath: agentFp,
            channel: "gateway", messageCount: 10, updatedAt: "2024-01-01T00:00:00.000Z", mtime: 5000,
        });

        mockStat.mockImplementation(async (p: string) => {
            if (p === agentFp) return { mtimeMs: 5000, mtime: new Date(5000), size: 5000 };
            if (p === dashFile("shared-key.json")) return { mtimeMs: 6000, mtime: new Date(6000), size: 100 };
            throw new Error("ENOENT");
        });
        mockReaddir.mockImplementation(async (p: string) => {
            if (p === AGENTS_DIR) return [];
            if (p === DASH_DIR) return ["shared-key.json"];
            throw new Error("ENOENT");
        });
        mockReadFile.mockImplementation(async () =>
            JSON.stringify({ sessionKey: "shared-key", agentId: "other", channel: "dashboard", messages: [] })
        );

        await refreshSessionIndex();

        const entry = sessionIndex.get("shared-key")!;
        expect(entry.agentId).toBe("agent-z");
        expect(entry.channel).toBe("gateway");
    });

    it("removes entries with no filePath", async () => {
        sessionIndex.set("no-path", {
            sessionKey: "no-path", agentId: "agent-q", filePath: "",
            channel: "", messageCount: 0, updatedAt: null, mtime: 0,
        });
        mockReaddir.mockRejectedValue(new Error("ENOENT"));

        await refreshSessionIndex();

        expect(sessionIndex.has("no-path")).toBe(false);
    });

    it("uses only fs/promises APIs (no sync calls)", async () => {
        const fs = await import("node:fs");
        const fp = agentSessFile("agent-t", "test-async.jsonl");

        sessionIndex.set("test-async", {
            sessionKey: "test-async", agentId: "agent-t", filePath: fp,
            channel: "cli", messageCount: 1, updatedAt: null, mtime: 100,
        });

        mockStat.mockImplementation(async (p: string) => {
            if (p === fp) return { mtimeMs: 200, mtime: new Date(200), size: 1000 };
            throw new Error("ENOENT");
        });
        mockReadFile.mockImplementation(async () => '{"type":"session","agentId":"agent-t","channel":"cli"}\n');
        mockReaddir.mockRejectedValue(new Error("ENOENT"));

        (fs.readFileSync as any).mockClear();
        (fs.readdirSync as any).mockClear();
        (fs.existsSync as any).mockClear();
        (fs.statSync as any).mockClear();

        await refreshSessionIndex();

        expect(fs.readFileSync).not.toHaveBeenCalled();
        expect(fs.readdirSync).not.toHaveBeenCalled();
        expect(fs.existsSync).not.toHaveBeenCalled();
        expect(fs.statSync).not.toHaveBeenCalled();
    });
});
