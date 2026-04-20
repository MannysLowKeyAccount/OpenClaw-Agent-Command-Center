import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    tryReadFile,
    json,
    stagePendingDestructiveOp,
    commitPendingDestructiveOps,
    discardPendingDestructiveOps,
    OPENCLAW_DIR,
    CONFIG_PATH,
    AGENTS_STATE_DIR,
    DASHBOARD_CONFIG_DIR,
    DASHBOARD_CONFIG_PATH,
    DASHBOARD_SESSIONS_DIR,
    DASHBOARD_TASKS_DIR,
    DASHBOARD_FLOWS_DIR,
    DASHBOARD_FLOW_DEFS_DIR,
    DASHBOARD_FLOW_STATE_DIR,
    DASHBOARD_FLOW_HISTORY_DIR,
    WORKSPACE_MD_FILES,
} from "../api-utils.js";
import type { ServerResponse } from "node:http";

// ─── tryReadFile ───
describe("tryReadFile", () => {
    const testDir = join(tmpdir(), `api-utils-test-${Date.now()}`);
    const testFile = join(testDir, "sample.txt");

    beforeAll(() => {
        mkdirSync(testDir, { recursive: true });
        writeFileSync(testFile, "hello world", "utf-8");
    });

    afterAll(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it("returns file content for an existing file", () => {
        expect(tryReadFile(testFile)).toBe("hello world");
    });

    it("returns null for a missing file", () => {
        expect(tryReadFile(join(testDir, "does-not-exist.txt"))).toBeNull();
    });

    it("returns null for a path that is a directory", () => {
        expect(tryReadFile(testDir)).toBeNull();
    });
});

// ─── json helper ───
describe("json", () => {
    function createMockResponse() {
        const headers: Record<string, string> = {};
        let endBody: string | undefined;
        let statusCode: number | undefined;

        const res = {
            set statusCode(code: number) { statusCode = code; },
            get statusCode() { return statusCode ?? 0; },
            setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
            end(body?: string) { endBody = body; },
            // test accessors
            _getHeaders: () => headers,
            _getBody: () => endBody,
        } as unknown as ServerResponse & { _getHeaders: () => Record<string, string>; _getBody: () => string | undefined };

        return res;
    }

    it("sets the correct status code", () => {
        const res = createMockResponse();
        json(res, 200, { ok: true });
        expect(res.statusCode).toBe(200);
    });

    it("sets Content-Type to application/json", () => {
        const res = createMockResponse();
        json(res, 200, { ok: true });
        expect((res as any)._getHeaders()["content-type"]).toBe("application/json");
    });

    it("writes JSON-serialized body", () => {
        const res = createMockResponse();
        const data = { message: "hello", count: 42 };
        json(res, 201, data);
        expect(JSON.parse((res as any)._getBody())).toEqual(data);
    });

    it("handles error status codes", () => {
        const res = createMockResponse();
        json(res, 404, { error: "Not found" });
        expect(res.statusCode).toBe(404);
        expect(JSON.parse((res as any)._getBody())).toEqual({ error: "Not found" });
    });
});

// ─── Path constants ───
describe("path constants", () => {
    const constants: Record<string, string> = {
        OPENCLAW_DIR,
        CONFIG_PATH,
        AGENTS_STATE_DIR,
        DASHBOARD_CONFIG_DIR,
        DASHBOARD_CONFIG_PATH,
        DASHBOARD_SESSIONS_DIR,
        DASHBOARD_TASKS_DIR,
        DASHBOARD_FLOWS_DIR,
        DASHBOARD_FLOW_DEFS_DIR,
        DASHBOARD_FLOW_STATE_DIR,
        DASHBOARD_FLOW_HISTORY_DIR,
    };

    for (const [name, value] of Object.entries(constants)) {
        it(`${name} is a non-empty string`, () => {
            expect(typeof value).toBe("string");
            expect(value.length).toBeGreaterThan(0);
        });
    }

    it("WORKSPACE_MD_FILES is a non-empty array of non-empty strings", () => {
        expect(Array.isArray(WORKSPACE_MD_FILES)).toBe(true);
        expect(WORKSPACE_MD_FILES.length).toBeGreaterThan(0);
        for (const f of WORKSPACE_MD_FILES) {
            expect(typeof f).toBe("string");
            expect(f.length).toBeGreaterThan(0);
        }
    });
});

describe("pending destructive ops", () => {
    it("applies agent cleanup before flow-definition deletes", () => {
        discardPendingDestructiveOps();
        const order: string[] = [];

        stagePendingDestructiveOp({ kind: "flow-definition", key: "flow", description: "flow", apply: () => order.push("flow") });
        stagePendingDestructiveOp({ kind: "agent", key: "agent", description: "agent", apply: () => order.push("agent") });

        expect(commitPendingDestructiveOps()).toBe(2);
        expect(order).toEqual(["agent", "flow"]);
    });
});
