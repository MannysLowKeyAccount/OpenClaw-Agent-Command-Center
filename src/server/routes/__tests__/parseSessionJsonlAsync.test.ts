import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSessionJsonl, parseSessionJsonlAsync } from "../sessions.js";

const TEST_DIR = join(tmpdir(), "parseSessionJsonlAsync-test-" + process.pid);

function setup() {
    mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { }
}

afterEach(() => teardown());

function writeJsonl(name: string, lines: object[]): string {
    setup();
    const fp = join(TEST_DIR, name);
    writeFileSync(fp, lines.map(l => JSON.stringify(l)).join("\n"), "utf-8");
    return fp;
}

describe("parseSessionJsonlAsync", () => {
    it("produces identical output to sync version for a typical session", async () => {
        const fp = writeJsonl("typical.jsonl", [
            { type: "session", agentId: "agent-1", channel: "cli" },
            { type: "message", message: { role: "user", content: "hello" }, timestamp: "2024-01-01T00:00:00Z" },
            { type: "message", message: { role: "assistant", content: "hi" }, timestamp: "2024-01-01T00:00:01Z" },
        ]);

        const syncResult = parseSessionJsonl(fp);
        const asyncResult = await parseSessionJsonlAsync(fp);

        expect(asyncResult).toEqual(syncResult);
    });

    it("produces identical output for an empty file", async () => {
        setup();
        const fp = join(TEST_DIR, "empty.jsonl");
        writeFileSync(fp, "", "utf-8");

        const syncResult = parseSessionJsonl(fp);
        const asyncResult = await parseSessionJsonlAsync(fp);

        expect(asyncResult).toEqual(syncResult);
        expect(asyncResult.messages).toEqual([]);
        expect(asyncResult.agentId).toBe("");
        expect(asyncResult.channel).toBe("");
        expect(asyncResult.updatedAt).toBeNull();
    });

    it("produces identical output with malformed lines mixed in", async () => {
        setup();
        const fp = join(TEST_DIR, "malformed.jsonl");
        const content = [
            JSON.stringify({ type: "session", agentId: "a1", channel: "web" }),
            "not valid json",
            "",
            JSON.stringify({ type: "message", message: { role: "user", content: "test" }, timestamp: "2024-06-01T12:00:00Z" }),
            "{broken",
        ].join("\n");
        writeFileSync(fp, content, "utf-8");

        const syncResult = parseSessionJsonl(fp);
        const asyncResult = await parseSessionJsonlAsync(fp);

        expect(asyncResult).toEqual(syncResult);
        expect(asyncResult.messages).toHaveLength(1);
        expect(asyncResult.agentId).toBe("a1");
    });

    it("produces identical output with only session entries (no messages)", async () => {
        const fp = writeJsonl("no-messages.jsonl", [
            { type: "session", agentId: "bot", channel: "dashboard" },
        ]);

        const syncResult = parseSessionJsonl(fp);
        const asyncResult = await parseSessionJsonlAsync(fp);

        expect(asyncResult).toEqual(syncResult);
        expect(asyncResult.messages).toEqual([]);
        expect(asyncResult.agentId).toBe("bot");
        expect(asyncResult.channel).toBe("dashboard");
    });

    it("produces identical output with multiple session entries (last wins)", async () => {
        const fp = writeJsonl("multi-session.jsonl", [
            { type: "session", agentId: "first", channel: "a" },
            { type: "message", message: { role: "user", content: "msg1" }, timestamp: "2024-01-01T00:00:00Z" },
            { type: "session", agentId: "second", channel: "b" },
            { type: "message", message: { role: "assistant", content: "msg2" }, timestamp: "2024-01-01T00:00:01Z" },
        ]);

        const syncResult = parseSessionJsonl(fp);
        const asyncResult = await parseSessionJsonlAsync(fp);

        expect(asyncResult).toEqual(syncResult);
        expect(asyncResult.agentId).toBe("second");
        expect(asyncResult.channel).toBe("b");
        expect(asyncResult.messages).toHaveLength(2);
    });

    it("handles entries without timestamp", async () => {
        const fp = writeJsonl("no-timestamp.jsonl", [
            { type: "session", agentId: "x", channel: "y" },
            { type: "message", message: { role: "user", content: "no ts" } },
        ]);

        const syncResult = parseSessionJsonl(fp);
        const asyncResult = await parseSessionJsonlAsync(fp);

        expect(asyncResult).toEqual(syncResult);
        expect(asyncResult.updatedAt).toBeNull();
        expect(asyncResult.messages).toHaveLength(1);
    });
});
