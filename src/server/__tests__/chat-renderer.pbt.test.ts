import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

// ─── Property 3: Message Filtering Completeness ───
// **Validates: Requirements 4.2, 4.3, 1.4**

// ── Types ──

type ContentPart = { type?: string; text?: string; thinking?: string };
type MessageContent = string | ContentPart[];

interface ChatMessage {
    role?: string;
    content?: MessageContent;
    text?: string;
}

interface FilteredMessage {
    role: string;
    content: string;
    isInternal: boolean;
}

// ── Pure filtering logic extracted from _renderChatMessages ──

/**
 * Replicates the filtering logic from `_renderChatMessages` in dashboard.js.txt.
 * Returns the messages that would be rendered (in order), after applying all
 * filtering, stripping, and content-resolution rules.
 */
function filterMessages(
    msgs: ChatMessage[],
    hideInternal: boolean,
): FilteredMessage[] {
    const result: FilteredMessage[] = [];

    for (const m of msgs) {
        const role = m.role || "system";
        let content: MessageContent = m.content ?? m.text ?? "";
        let isInternal = false;

        // system/tool/toolResult roles are internal
        if (role === "system" || role === "toolResult" || role === "tool") {
            if (hideInternal) continue;
            isInternal = true;
        }

        // Handle array content (ContentPart[])
        if (Array.isArray(content)) {
            const textParts: string[] = [];
            const thinkingParts: string[] = [];
            for (const c of content) {
                if (typeof c === "string") {
                    textParts.push(c);
                } else if (c.type === "thinking" && c.thinking) {
                    thinkingParts.push(c.thinking);
                } else if (c.text) {
                    textParts.push(c.text);
                }
            }
            const textContent = textParts.join("\n");
            if (
                textContent.indexOf("OPENCLAW_INTERNAL_CONTEXT") > -1 ||
                textContent.indexOf("<<<BEGIN_OPENCLAW") > -1
            ) {
                isInternal = true;
            }
            if (hideInternal) {
                if (isInternal) continue;
                content = textContent;
            } else {
                const parts: string[] = [];
                if (thinkingParts.length > 0)
                    parts.push("[thinking] " + thinkingParts.join("\n"));
                if (textContent) parts.push(textContent);
                content = parts.join("\n\n");
            }
        } else {
            // String content — filter internal markers
            if (
                typeof content === "string" &&
                (content.indexOf("OPENCLAW_INTERNAL_CONTEXT") > -1 ||
                    content.indexOf("<<<BEGIN_OPENCLAW") > -1)
            ) {
                if (hideInternal) continue;
                isInternal = true;
            }
        }

        // Always filter empty, whitespace-only, and NO_REPLY messages
        if (!content || !(content as string).trim()) continue;
        if ((content as string).trim() === "NO_REPLY") continue;

        // Strip routing tags
        let strContent = content as string;
        strContent = strContent
            .replace(/\[\[reply_to_current\]\]/g, "")
            .replace(/\[\[reply_to:[^\]]*\]\]/g, "");

        // Strip injected timestamp prefixes
        strContent = strContent.replace(
            /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\]]*\]\s*/,
            "",
        );

        strContent = strContent.trim();
        if (!strContent) continue;

        result.push({ role, content: strContent, isInternal });
    }

    return result;
}

// ── Reference implementation for expected filtering ──

/**
 * Independent reference that computes which messages should survive filtering.
 * Used to cross-check the filterMessages function.
 */
function expectedFilteredMessages(
    msgs: ChatMessage[],
    hideInternal: boolean,
): FilteredMessage[] {
    const result: FilteredMessage[] = [];

    for (const m of msgs) {
        const role = m.role || "system";
        const rawContent: MessageContent = m.content ?? m.text ?? "";
        let isInternal = false;

        // Rule 1: system/tool/toolResult roles are internal
        if (role === "system" || role === "tool" || role === "toolResult") {
            if (hideInternal) continue;
            isInternal = true;
        }

        let resolvedContent: string;

        if (Array.isArray(rawContent)) {
            const textParts: string[] = [];
            const thinkingParts: string[] = [];
            for (const c of rawContent) {
                if (typeof c === "string") textParts.push(c);
                else if (c.type === "thinking" && c.thinking)
                    thinkingParts.push(c.thinking);
                else if (c.text) textParts.push(c.text);
            }
            const textContent = textParts.join("\n");

            // Rule 2: internal markers in array content
            if (
                textContent.includes("OPENCLAW_INTERNAL_CONTEXT") ||
                textContent.includes("<<<BEGIN_OPENCLAW")
            ) {
                isInternal = true;
            }

            if (hideInternal && isInternal) continue;

            if (hideInternal) {
                resolvedContent = textContent;
            } else {
                const parts: string[] = [];
                if (thinkingParts.length > 0)
                    parts.push("[thinking] " + thinkingParts.join("\n"));
                if (textContent) parts.push(textContent);
                resolvedContent = parts.join("\n\n");
            }
        } else {
            // Rule 2: internal markers in string content
            if (
                typeof rawContent === "string" &&
                (rawContent.includes("OPENCLAW_INTERNAL_CONTEXT") ||
                    rawContent.includes("<<<BEGIN_OPENCLAW"))
            ) {
                if (hideInternal) continue;
                isInternal = true;
            }
            resolvedContent = rawContent as string;
        }

        // Rule 3: filter empty / whitespace / NO_REPLY
        if (!resolvedContent || !resolvedContent.trim()) continue;
        if (resolvedContent.trim() === "NO_REPLY") continue;

        // Rule 4: strip routing tags and timestamps
        resolvedContent = resolvedContent
            .replace(/\[\[reply_to_current\]\]/g, "")
            .replace(/\[\[reply_to:[^\]]*\]\]/g, "");
        resolvedContent = resolvedContent.replace(
            /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\]]*\]\s*/,
            "",
        );
        resolvedContent = resolvedContent.trim();
        if (!resolvedContent) continue;

        result.push({ role, content: resolvedContent, isInternal });
    }

    return result;
}

// ── Arbitraries ──

const INTERNAL_MARKERS = [
    "OPENCLAW_INTERNAL_CONTEXT",
    "<<<BEGIN_OPENCLAW",
];

/** Safe text that won't accidentally contain internal markers or routing tags */
const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789 .,!?-";
const safeTextArb = fc
    .string({ minLength: 1, maxLength: 40 })
    .map((s) =>
        Array.from(s)
            .map((ch) => SAFE_CHARS[ch.charCodeAt(0) % SAFE_CHARS.length])
            .join(""),
    )
    .filter(
        (s) =>
            !s.includes("OPENCLAW_INTERNAL_CONTEXT") &&
            !s.includes("<<<BEGIN_OPENCLAW") &&
            !s.includes("[[reply_to") &&
            s.trim() !== "NO_REPLY" &&
            s.trim().length > 0,
    );

/** Content that contains internal markers */
const internalContentArb = fc.oneof(
    safeTextArb.map((s) => `${s} OPENCLAW_INTERNAL_CONTEXT ${s}`),
    safeTextArb.map((s) => `${s} <<<BEGIN_OPENCLAW ${s}`),
    fc.constant("OPENCLAW_INTERNAL_CONTEXT data here"),
    fc.constant("<<<BEGIN_OPENCLAW some internal stuff"),
);

/** Content that should always be filtered out */
const alwaysFilteredContentArb = fc.oneof(
    fc.constant(""),
    fc.constant("   "),
    fc.constant("\t\n  "),
    fc.constant("NO_REPLY"),
    fc.constant("  NO_REPLY  "),
);

/** Content with routing tags that should be stripped */
const routingTagContentArb = safeTextArb.map(
    (s) => `[[reply_to_current]]${s}`,
);

/** Content with timestamp prefix that should be stripped */
const timestampContentArb = safeTextArb.map(
    (s) => `[2024-06-15T12:30:00Z] ${s}`,
);

const roleArb = fc.constantFrom(
    "user",
    "assistant",
    "tool",
    "toolResult",
    "system",
);

/** A message with normal visible content */
const normalMessageArb = fc.record({
    role: roleArb,
    content: safeTextArb,
});

/** A message with internal marker content */
const internalMessageArb = fc.record({
    role: fc.constantFrom("user", "assistant", "system"),
    content: internalContentArb,
});

/** A message that should always be filtered (empty/whitespace/NO_REPLY) */
const alwaysFilteredMessageArb = fc.record({
    role: roleArb,
    content: alwaysFilteredContentArb,
});

/** A tool/toolResult message (internal by role) */
const toolMessageArb = fc.record({
    role: fc.constantFrom("tool", "toolResult"),
    content: safeTextArb,
});

/** A message with array content (ContentPart[]) */
const arrayContentMessageArb = fc.record({
    role: fc.constantFrom("user", "assistant", "system"),
    content: fc.array(
        fc.oneof(
            safeTextArb.map((t) => ({ type: "text" as const, text: t })),
            safeTextArb.map((t) => ({
                type: "thinking" as const,
                thinking: t,
            })),
        ),
        { minLength: 1, maxLength: 3 },
    ),
});

/** Mixed message arbitrary — any kind of message */
const anyMessageArb: fc.Arbitrary<ChatMessage> = fc.oneof(
    normalMessageArb,
    internalMessageArb,
    alwaysFilteredMessageArb,
    toolMessageArb,
    arrayContentMessageArb,
    // Messages with routing tags
    fc.record({ role: roleArb, content: routingTagContentArb }),
    // Messages with timestamp prefixes
    fc.record({ role: roleArb, content: timestampContentArb }),
);

// ── Property Tests ──

describe("Property 3: Message Filtering Completeness", () => {
    it("filtered output matches expected non-filtered messages in order (hideInternal=true)", () => {
        fc.assert(
            fc.property(
                fc.array(anyMessageArb, { minLength: 0, maxLength: 20 }),
                (msgs) => {
                    const actual = filterMessages(msgs, true);
                    const expected = expectedFilteredMessages(msgs, true);

                    expect(actual).toEqual(expected);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("filtered output matches expected non-filtered messages in order (hideInternal=false)", () => {
        fc.assert(
            fc.property(
                fc.array(anyMessageArb, { minLength: 0, maxLength: 20 }),
                (msgs) => {
                    const actual = filterMessages(msgs, false);
                    const expected = expectedFilteredMessages(msgs, false);

                    expect(actual).toEqual(expected);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("empty/whitespace/NO_REPLY messages are always excluded regardless of hideInternal", () => {
        fc.assert(
            fc.property(
                fc.array(alwaysFilteredMessageArb, {
                    minLength: 1,
                    maxLength: 10,
                }),
                fc.boolean(),
                (msgs, hideInternal) => {
                    const result = filterMessages(msgs, hideInternal);
                    expect(result).toHaveLength(0);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("tool/toolResult messages are excluded when hideInternal=true", () => {
        fc.assert(
            fc.property(
                fc.array(toolMessageArb, { minLength: 1, maxLength: 10 }),
                (msgs) => {
                    const result = filterMessages(msgs, true);
                    expect(result).toHaveLength(0);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("tool/toolResult messages are included when hideInternal=false", () => {
        fc.assert(
            fc.property(
                fc.array(toolMessageArb, { minLength: 1, maxLength: 10 }),
                (msgs) => {
                    const result = filterMessages(msgs, false);
                    // All tool messages with non-empty safe content should appear
                    expect(result.length).toBe(msgs.length);
                    for (const r of result) {
                        expect(r.isInternal).toBe(true);
                        expect(["tool", "toolResult"]).toContain(r.role);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });

    it("system-role messages are hidden when hideInternal=true and marked internal when shown", () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        role: fc.constant("system"),
                        content: safeTextArb,
                    }),
                    { minLength: 1, maxLength: 10 },
                ),
                (msgs) => {
                    const hidden = filterMessages(msgs, true);
                    expect(hidden).toHaveLength(0);

                    const visible = filterMessages(msgs, false);
                    expect(visible).toHaveLength(msgs.length);
                    for (const r of visible) {
                        expect(r.role).toBe("system");
                        expect(r.isInternal).toBe(true);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });

    it("internal marker messages are excluded when hideInternal=true", () => {
        fc.assert(
            fc.property(
                fc.array(internalMessageArb, { minLength: 1, maxLength: 10 }),
                (msgs) => {
                    const result = filterMessages(msgs, true);
                    expect(result).toHaveLength(0);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("internal marker messages are included when hideInternal=false", () => {
        fc.assert(
            fc.property(
                fc.array(internalMessageArb, { minLength: 1, maxLength: 10 }),
                (msgs) => {
                    const result = filterMessages(msgs, false);
                    expect(result.length).toBe(msgs.length);
                    for (const r of result) {
                        expect(r.isInternal).toBe(true);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });

    it("output preserves original array order", () => {
        fc.assert(
            fc.property(
                fc.array(normalMessageArb, { minLength: 2, maxLength: 15 }),
                fc.boolean(),
                (msgs, hideInternal) => {
                    // Tag each message with its original index for tracking
                    const tagged = msgs.map((m, i) => ({
                        ...m,
                        content: `[idx${i}] ${m.content}`,
                    }));

                    const result = filterMessages(tagged, hideInternal);

                    // Extract original indices from the tagged content
                    const outputIndices = result.map((r) => {
                        const match = r.content.match(/\[idx(\d+)\]/);
                        return match ? parseInt(match[1], 10) : -1;
                    });

                    // Verify strictly increasing order
                    for (let i = 1; i < outputIndices.length; i++) {
                        expect(outputIndices[i]).toBeGreaterThan(
                            outputIndices[i - 1],
                        );
                    }
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── Property 4: Routing Tag and Timestamp Stripping ───
// **Validates: Requirements 4.4**

/**
 * Pure function extracted from `_renderChatMessages` in dashboard.js.txt.
 * Strips routing tags and injected timestamp prefixes from message content.
 */
function stripRoutingTags(content: string): string {
    let result = content;
    result = result.replace(/\[\[reply_to_current\]\]/g, "");
    result = result.replace(/\[\[reply_to:[^\]]*\]\]/g, "");
    result = result.replace(
        /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\]]*\]\s*/,
        "",
    );
    return result;
}

// ── Arbitraries for Property 4 ──

/** Characters that won't accidentally form routing tag or timestamp patterns */
const P4_SAFE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-_:;(){}+=/";
const p4SafeTextArb = fc
    .string({ minLength: 1, maxLength: 30 })
    .map((s) =>
        Array.from(s)
            .map((ch) => P4_SAFE_CHARS[ch.charCodeAt(0) % P4_SAFE_CHARS.length])
            .join(""),
    )
    .filter(
        (s) =>
            !s.includes("[[") &&
            !s.match(/^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/) &&
            s.trim().length > 0,
    );

/** Generates [[reply_to_current]] tags */
const replyToCurrentArb = fc.constant("[[reply_to_current]]");

/** Generates [[reply_to:...]] tags with random content inside */
const replyToTargetArb = p4SafeTextArb.map(
    (s) => `[[reply_to:${s.replace(/\]/g, "")}]]`,
);

/** Generates valid timestamp prefixes like [2024-06-15T12:30:00Z] */
const timestampPrefixArb = fc
    .record({
        year: fc.integer({ min: 2000, max: 2099 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 28 }),
        hour: fc.integer({ min: 0, max: 23 }),
        minute: fc.integer({ min: 0, max: 59 }),
        second: fc.integer({ min: 0, max: 59 }),
        sep: fc.constantFrom("T", " "),
        suffix: fc.constantFrom("Z", "+00:00", "-05:00", ".000Z", ""),
    })
    .map(
        ({ year, month, day, hour, minute, second, sep, suffix }) =>
            `[${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}${sep}${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${suffix}] `,
    );

/** Generates a string that is a mix of safe text and routing tags */
const contentWithRoutingTagsArb = fc
    .array(
        fc.oneof(
            { weight: 3, arbitrary: p4SafeTextArb },
            { weight: 1, arbitrary: replyToCurrentArb },
            { weight: 1, arbitrary: replyToTargetArb },
        ),
        { minLength: 1, maxLength: 6 },
    )
    .map((parts) => parts.join(""));

/** Generates a string with a timestamp prefix followed by content */
const contentWithTimestampArb = fc
    .tuple(timestampPrefixArb, p4SafeTextArb)
    .map(([ts, text]) => `${ts}${text}`);

/** Generates content that may have both timestamp prefix and routing tags */
const contentWithBothArb = fc
    .tuple(
        timestampPrefixArb,
        fc.array(
            fc.oneof(
                { weight: 3, arbitrary: p4SafeTextArb },
                { weight: 1, arbitrary: replyToCurrentArb },
                { weight: 1, arbitrary: replyToTargetArb },
            ),
            { minLength: 1, maxLength: 4 },
        ),
    )
    .map(([ts, parts]) => `${ts}${parts.join("")}`);

// ── Property 4 Tests ──

describe("Property 4: Routing Tag and Timestamp Stripping", () => {
    it("no [[reply_to_current]] patterns remain after stripping", () => {
        fc.assert(
            fc.property(contentWithRoutingTagsArb, (content) => {
                const stripped = stripRoutingTags(content);
                expect(stripped).not.toContain("[[reply_to_current]]");
            }),
            { numRuns: 100 },
        );
    });

    it("no [[reply_to:...]] patterns remain after stripping", () => {
        fc.assert(
            fc.property(contentWithRoutingTagsArb, (content) => {
                const stripped = stripRoutingTags(content);
                expect(stripped).not.toMatch(/\[\[reply_to:[^\]]*\]\]/);
            }),
            { numRuns: 100 },
        );
    });

    it("timestamp prefix at start of string is removed", () => {
        fc.assert(
            fc.property(contentWithTimestampArb, (content) => {
                const stripped = stripRoutingTags(content);
                expect(stripped).not.toMatch(
                    /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/,
                );
            }),
            { numRuns: 100 },
        );
    });

    it("normal text is preserved after stripping routing tags", () => {
        fc.assert(
            fc.property(
                p4SafeTextArb,
                fc.array(
                    fc.oneof(replyToCurrentArb, replyToTargetArb),
                    { minLength: 0, maxLength: 3 },
                ),
                (normalText, tags) => {
                    // Build content: normalText with tags inserted around it
                    const content = tags.join("") + normalText + tags.join("");
                    const stripped = stripRoutingTags(content);
                    expect(stripped).toContain(normalText);
                },
            ),
            { numRuns: 100 },
        );
    });

    it("normal text after timestamp prefix is preserved", () => {
        fc.assert(
            fc.property(
                timestampPrefixArb,
                p4SafeTextArb,
                (tsPrefix, normalText) => {
                    const content = `${tsPrefix}${normalText}`;
                    const stripped = stripRoutingTags(content);
                    // The regex consumes trailing whitespace after the timestamp bracket,
                    // so leading spaces in normalText may be consumed. Check trimmed content.
                    expect(stripped).toContain(normalText.trimStart());
                },
            ),
            { numRuns: 100 },
        );
    });

    it("safe text without any tags or timestamps passes through unchanged", () => {
        fc.assert(
            fc.property(p4SafeTextArb, (content) => {
                const stripped = stripRoutingTags(content);
                expect(stripped).toBe(content);
            }),
            { numRuns: 100 },
        );
    });

    it("content with both timestamp prefix and routing tags is fully cleaned", () => {
        fc.assert(
            fc.property(contentWithBothArb, (content) => {
                const stripped = stripRoutingTags(content);
                expect(stripped).not.toContain("[[reply_to_current]]");
                expect(stripped).not.toMatch(/\[\[reply_to:[^\]]*\]\]/);
                expect(stripped).not.toMatch(
                    /^\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/,
                );
            }),
            { numRuns: 100 },
        );
    });

    it("stripping is idempotent — applying it twice yields the same result", () => {
        fc.assert(
            fc.property(contentWithBothArb, (content) => {
                const once = stripRoutingTags(content);
                const twice = stripRoutingTags(once);
                expect(twice).toBe(once);
            }),
            { numRuns: 100 },
        );
    });
});

// ─── Property 5: Role Label Mapping ───
// **Validates: Requirements 4.1**

/**
 * Pure function extracted from `_renderChatMessages` in dashboard.js.txt.
 * Maps message roles to display labels for chat bubbles.
 */
function mapRoleLabel(role: string): string {
    return role === "user"
        ? "you"
        : role === "assistant"
            ? "agent"
            : role === "tool" || role === "toolResult"
                ? "tool"
                : role;
}

// ── Expected mapping lookup (independent reference) ──

const EXPECTED_LABEL_MAP: Record<string, string> = {
    user: "you",
    assistant: "agent",
    tool: "tool",
    toolResult: "tool",
    system: "system",
};

// ── Arbitraries for Property 5 ──

const p5RoleArb = fc.constantFrom(
    "user",
    "assistant",
    "tool",
    "toolResult",
    "system",
);

// ── Property 5 Tests ──

describe("Property 5: Role Label Mapping", () => {
    it("every known role maps to its expected label", () => {
        fc.assert(
            fc.property(p5RoleArb, (role) => {
                const label = mapRoleLabel(role);
                expect(label).toBe(EXPECTED_LABEL_MAP[role]);
            }),
            { numRuns: 100 },
        );
    });

    it("user role always maps to 'you'", () => {
        fc.assert(
            fc.property(fc.constant("user"), (role) => {
                expect(mapRoleLabel(role)).toBe("you");
            }),
            { numRuns: 100 },
        );
    });

    it("assistant role always maps to 'agent'", () => {
        fc.assert(
            fc.property(fc.constant("assistant"), (role) => {
                expect(mapRoleLabel(role)).toBe("agent");
            }),
            { numRuns: 100 },
        );
    });

    it("tool and toolResult both map to 'tool'", () => {
        fc.assert(
            fc.property(
                fc.constantFrom("tool", "toolResult"),
                (role) => {
                    expect(mapRoleLabel(role)).toBe("tool");
                },
            ),
            { numRuns: 100 },
        );
    });

    it("system role maps to itself ('system')", () => {
        fc.assert(
            fc.property(fc.constant("system"), (role) => {
                expect(mapRoleLabel(role)).toBe("system");
            }),
            { numRuns: 100 },
        );
    });

    it("unknown roles fall through to the role string itself", () => {
        fc.assert(
            fc.property(
                fc.string({ minLength: 1, maxLength: 20 }).filter(
                    (s) =>
                        s !== "user" &&
                        s !== "assistant" &&
                        s !== "tool" &&
                        s !== "toolResult" &&
                        s !== "system",
                ),
                (role) => {
                    expect(mapRoleLabel(role)).toBe(role);
                },
            ),
            { numRuns: 100 },
        );
    });
});
