import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as fc from "fast-check";
import { parseSessionJsonl, parseSessionJsonlAsync } from "../routes/sessions.js";

// ─── Property 6: JSONL Parsing Correctness ───
// **Validates: Requirements 7.1, 7.2, 7.3, 5.4, 5.5**

// Arbitraries for generating JSONL content components

/** Generate a valid session header line */
const sessionHeaderArb = fc.record({
    agentId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes("\n") && !s.includes('"')),
    channel: fc.constantFrom("cli", "dashboard", "discord", "slack", "api"),
    sessionId: fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes("\n") && !s.includes('"')),
}).map(({ agentId, channel, sessionId }) =>
    JSON.stringify({ type: "session", agentId, channel, sessionId })
);

/** Generate a valid message entry line */
const messageEntryArb = fc.record({
    role: fc.constantFrom("user", "assistant", "system", "tool"),
    content: fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes("\n")),
    timestamp: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") }).map(d => d.toISOString()),
}).map(({ role, content, timestamp }) =>
    JSON.stringify({ type: "message", message: { role, content }, timestamp })
);

const INTERNAL_SESSION_MARKERS = [
    "OPENCLAW_INTERNAL_CONTEXT",
    "<<<BEGIN_OPENCLAW",
    "<relevant-memories>",
    "Read HEARTBEAT.md",
    "HEARTBEAT_OK",
];

function isInternalSessionMessage(message: { role?: string; content?: string | unknown[]; internal?: boolean; isInternal?: boolean }): boolean {
    if (message.internal === true || message.isInternal === true) return true;
    const role = message.role || "";
    if (role === "system" || role === "tool" || role === "toolResult") return true;
    const content = message.content;
    const text = Array.isArray(content)
        ? content.map((part) => typeof part === "string" ? part : typeof (part as any)?.thinking === "string" ? (part as any).thinking : typeof (part as any)?.text === "string" ? (part as any).text : "").join("\n")
        : String(content ?? "");
    return INTERNAL_SESSION_MARKERS.some((marker) => text.includes(marker));
}

/** Generate a blank line (empty or whitespace-only) */
const blankLineArb = fc.constantFrom("", "  ", "\t", "   \t  ");

/** Generate a malformed JSON line (not valid JSON) */
const malformedLineArb = fc.constantFrom(
    "{bad json",
    "not json at all",
    '{"type": "message", missing bracket',
    "{{{{",
    "undefined",
    "[[[",
    '{"type": "message"',  // truncated
);

/** A tagged union so we know what kind of line was generated */
type TaggedLine =
    | { tag: "header"; line: string; agentId: string; channel: string }
    | { tag: "message"; line: string; message: { role: string; content: string; _timestamp?: string }; timestamp: string }
    | { tag: "blank"; line: string }
    | { tag: "malformed"; line: string };

const taggedHeaderArb: fc.Arbitrary<TaggedLine> = fc.record({
    agentId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => !s.includes("\n") && !s.includes('"')),
    channel: fc.constantFrom("cli", "dashboard", "discord", "slack", "api"),
    sessionId: fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes("\n") && !s.includes('"')),
}).map(({ agentId, channel, sessionId }) => ({
    tag: "header" as const,
    line: JSON.stringify({ type: "session", agentId, channel, sessionId }),
    agentId,
    channel,
}));

const taggedMessageArb: fc.Arbitrary<TaggedLine> = fc.record({
    role: fc.constantFrom("user", "assistant", "system", "tool"),
    content: fc.string({ minLength: 1, maxLength: 100 }).filter(s => !s.includes("\n")),
    timestamp: fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01") }).filter(d => !isNaN(d.getTime())).map(d => d.toISOString()),
}).map(({ role, content, timestamp }) => ({
    tag: "message" as const,
    line: JSON.stringify({ type: "message", message: { role, content }, timestamp }),
    message: { role, content },
    timestamp,
}));

const taggedBlankArb: fc.Arbitrary<TaggedLine> = blankLineArb.map(line => ({
    tag: "blank" as const,
    line,
}));

const taggedMalformedArb: fc.Arbitrary<TaggedLine> = malformedLineArb.map(line => ({
    tag: "malformed" as const,
    line,
}));

/** Generate a JSONL document as an array of tagged lines.
 *  Structure: optionally one header first, then a mix of messages, blanks, and malformed lines.
 */
const jsonlDocumentArb = fc.record({
    header: fc.option(taggedHeaderArb, { nil: undefined }),
    body: fc.array(
        fc.oneof(
            { weight: 5, arbitrary: taggedMessageArb },
            { weight: 2, arbitrary: taggedBlankArb },
            { weight: 2, arbitrary: taggedMalformedArb },
            { weight: 1, arbitrary: taggedHeaderArb }, // extra headers (should be ignored after first)
        ),
        { minLength: 0, maxLength: 30 },
    ),
}).map(({ header, body }) => {
    const lines: TaggedLine[] = [];
    if (header) lines.push(header);
    lines.push(...body);
    return lines;
});

describe("Property 6: JSONL Parsing Correctness", () => {
    const testDir = join(tmpdir(), `sessions-parser-pbt-${Date.now()}`);
    let fileCounter = 0;

    beforeAll(() => {
        mkdirSync(testDir, { recursive: true });
    });

    afterAll(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    function writeTempJsonl(lines: TaggedLine[]): string {
        const filePath = join(testDir, `test-${fileCounter++}.jsonl`);
        const content = lines.map(l => l.line).join("\n");
        writeFileSync(filePath, content, "utf-8");
        return filePath;
    }

    /** Compute expected results from tagged lines */
    function computeExpected(lines: TaggedLine[]) {
        let expectedAgentId = "";
        let expectedChannel = "";
        let headerFound = false;
        const expectedMessages: { role: string; content: string; _timestamp?: string; seq?: number; cursor?: number; internal?: boolean; isInternal?: boolean }[] = [];
        let expectedUpdatedAt: string | null = null;
        let seq = 0;

        for (const tagged of lines) {
            if (tagged.tag === "header" && !headerFound) {
                expectedAgentId = tagged.agentId;
                expectedChannel = tagged.channel;
                headerFound = true;
            }
            if (tagged.tag === "message") {
                seq += 1;
                const internal = isInternalSessionMessage(tagged.message);
                expectedMessages.push({ ...tagged.message, _timestamp: tagged.timestamp, seq, cursor: seq, internal, isInternal: internal });
                expectedUpdatedAt = tagged.timestamp;
            }
        }

        return { expectedAgentId, expectedChannel, expectedMessages, expectedUpdatedAt };
    }

    it("parseSessionJsonl returns exactly the valid message entries in order with correct header fields", () => {
        fc.assert(
            fc.property(jsonlDocumentArb, (taggedLines) => {
                const filePath = writeTempJsonl(taggedLines);
                const result = parseSessionJsonl(filePath);
                const { expectedAgentId, expectedChannel, expectedMessages, expectedUpdatedAt } = computeExpected(taggedLines);

                // agentId and channel match the first session header
                expect(result.agentId).toBe(expectedAgentId);
                expect(result.channel).toBe(expectedChannel);

                // messages array contains exactly the valid message entries in order
                expect(result.messages).toHaveLength(expectedMessages.length);
                for (let i = 0; i < expectedMessages.length; i++) {
                    expect(result.messages[i]).toEqual(expectedMessages[i]);
                    expect(result.messages[i].internal).toBe(expectedMessages[i].internal);
                    expect(result.messages[i].isInternal).toBe(expectedMessages[i].isInternal);
                }

                // updatedAt matches the last message timestamp
                expect(result.updatedAt).toBe(expectedUpdatedAt);
            }),
            { numRuns: 150 },
        );
    });

    it("parseSessionJsonlAsync returns exactly the valid message entries in order with correct header fields", async () => {
        await fc.assert(
            fc.asyncProperty(jsonlDocumentArb, async (taggedLines) => {
                const filePath = writeTempJsonl(taggedLines);
                const result = await parseSessionJsonlAsync(filePath);
                const { expectedAgentId, expectedChannel, expectedMessages, expectedUpdatedAt } = computeExpected(taggedLines);

                // agentId and channel match the first session header
                expect(result.agentId).toBe(expectedAgentId);
                expect(result.channel).toBe(expectedChannel);

                // messages array contains exactly the valid message entries in order
                expect(result.messages).toHaveLength(expectedMessages.length);
                for (let i = 0; i < expectedMessages.length; i++) {
                    expect(result.messages[i]).toEqual(expectedMessages[i]);
                }

                // updatedAt matches the last message timestamp
                expect(result.updatedAt).toBe(expectedUpdatedAt);
            }),
            { numRuns: 150 },
        );
    });

    it("marks semantic internal messages in parsed sessions", () => {
        const filePath = writeTempJsonl([
            { tag: "header", line: JSON.stringify({ type: "session", agentId: "alpha", channel: "dashboard", sessionId: "s-1" }), agentId: "alpha", channel: "dashboard" },
            { tag: "message", line: JSON.stringify({ type: "message", message: { role: "assistant", content: "heartbeat tick" }, timestamp: "2026-04-22T10:00:00Z" }), message: { role: "assistant", content: "heartbeat tick" }, timestamp: "2026-04-22T10:00:00Z" },
            { tag: "message", line: JSON.stringify({ type: "message", message: { role: "assistant", content: "OPENCLAW_INTERNAL_CONTEXT hidden" }, timestamp: "2026-04-22T10:01:00Z" }), message: { role: "assistant", content: "OPENCLAW_INTERNAL_CONTEXT hidden" }, timestamp: "2026-04-22T10:01:00Z" },
        ]);

        const result = parseSessionJsonl(filePath);
        expect(result.messages[0].internal).toBe(false);
        expect(result.messages[0].isInternal).toBe(false);
        expect(result.messages[1].internal).toBe(true);
        expect(result.messages[1].isInternal).toBe(true);
    });

    it("marks heartbeat orchestration chatter as internal", () => {
        const filePath = writeTempJsonl([
            { tag: "header", line: JSON.stringify({ type: "session", agentId: "alpha", channel: "dashboard", sessionId: "s-2" }), agentId: "alpha", channel: "dashboard" },
            { tag: "message", line: JSON.stringify({ type: "message", message: { role: "assistant", content: "Read HEARTBEAT.md and continue" }, timestamp: "2026-04-22T10:02:00Z" }), message: { role: "assistant", content: "Read HEARTBEAT.md and continue" }, timestamp: "2026-04-22T10:02:00Z" },
            { tag: "message", line: JSON.stringify({ type: "message", message: { role: "assistant", content: "HEARTBEAT_OK" }, timestamp: "2026-04-22T10:03:00Z" }), message: { role: "assistant", content: "HEARTBEAT_OK" }, timestamp: "2026-04-22T10:03:00Z" },
            { tag: "message", line: JSON.stringify({ type: "message", message: { role: "assistant", content: "Visible reply" }, timestamp: "2026-04-22T10:04:00Z" }), message: { role: "assistant", content: "Visible reply" }, timestamp: "2026-04-22T10:04:00Z" },
        ]);

        const result = parseSessionJsonl(filePath);
        expect(result.messages[0].internal).toBe(true);
        expect(result.messages[1].internal).toBe(true);
        expect(result.messages[2].internal).toBe(false);
    });
});


// ─── Property 7: JSONL Session Header Round-Trip ───
// **Validates: Requirements 7.5, 7.6, 5.6**

describe("Property 7: JSONL Session Header Round-Trip", () => {
    /** Generate a valid session header object */
    const validSessionHeaderArb = fc.record({
        type: fc.constant("session" as const),
        agentId: fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes("\n") && !s.includes('"')),
        channel: fc.constantFrom("cli", "dashboard", "discord", "slack", "api"),
        sessionId: fc.string({ minLength: 1, maxLength: 50 }).filter(s => !s.includes("\n") && !s.includes('"')),
    });

    it("JSON.parse(JSON.stringify(header)) deep-equals the original header", () => {
        fc.assert(
            fc.property(validSessionHeaderArb, (header) => {
                const serialized = JSON.stringify(header);
                const deserialized = JSON.parse(serialized);

                expect(deserialized).toEqual(header);
                expect(deserialized.type).toBe("session");
                expect(deserialized.agentId).toBe(header.agentId);
                expect(deserialized.channel).toBe(header.channel);
                expect(deserialized.sessionId).toBe(header.sessionId);
            }),
            { numRuns: 150 },
        );
    });

    it("round-trip preserves all header fields with no extra or missing keys", () => {
        fc.assert(
            fc.property(validSessionHeaderArb, (header) => {
                const roundTripped = JSON.parse(JSON.stringify(header));

                // Same set of keys
                expect(Object.keys(roundTripped).sort()).toEqual(Object.keys(header).sort());

                // No extra keys introduced
                for (const key of Object.keys(roundTripped)) {
                    expect(key in header).toBe(true);
                }
            }),
            { numRuns: 150 },
        );
    });

    it("serialized header is valid JSON that can be used as a JSONL first line", () => {
        fc.assert(
            fc.property(validSessionHeaderArb, (header) => {
                const line = JSON.stringify(header);

                // Must not contain newlines (valid JSONL line)
                expect(line).not.toContain("\n");

                // Must parse back without error
                const parsed = JSON.parse(line);
                expect(parsed.type).toBe("session");
            }),
            { numRuns: 150 },
        );
    });
});


// ─── Property 8: Sync and Async Parser Equivalence ───
// **Validates: Requirements 7.4**

describe("Property 8: Sync and Async Parser Equivalence", () => {
    const testDir = join(tmpdir(), `sessions-parser-pbt-equiv-${Date.now()}`);
    let fileCounter = 0;

    beforeAll(() => {
        mkdirSync(testDir, { recursive: true });
    });

    afterAll(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    function writeTempJsonl(lines: TaggedLine[]): string {
        const filePath = join(testDir, `equiv-${fileCounter++}.jsonl`);
        const content = lines.map(l => l.line).join("\n");
        writeFileSync(filePath, content, "utf-8");
        return filePath;
    }

    it("parseSessionJsonl and parseSessionJsonlAsync produce identical output for any valid JSONL content", async () => {
        await fc.assert(
            fc.asyncProperty(jsonlDocumentArb, async (taggedLines) => {
                const filePath = writeTempJsonl(taggedLines);

                const syncResult = parseSessionJsonl(filePath);
                const asyncResult = await parseSessionJsonlAsync(filePath);

                // Same agentId
                expect(asyncResult.agentId).toBe(syncResult.agentId);

                // Same channel
                expect(asyncResult.channel).toBe(syncResult.channel);

                // Same updatedAt
                expect(asyncResult.updatedAt).toBe(syncResult.updatedAt);

                // Same messages array (length and content in same order)
                expect(asyncResult.messages).toHaveLength(syncResult.messages.length);
                for (let i = 0; i < syncResult.messages.length; i++) {
                    expect(asyncResult.messages[i]).toEqual(syncResult.messages[i]);
                }
            }),
            { numRuns: 150 },
        );
    });
});
