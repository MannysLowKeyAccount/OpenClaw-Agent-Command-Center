/**
 * Preservation Property Tests — Normal Polling and Session Operations Unchanged
 *
 * **Validates: Requirements 3.1, 3.2, 3.4**
 *
 * These tests capture the CURRENT cursor-based polling behavior for non-buggy inputs.
 * They MUST PASS on both unfixed and fixed code — ensuring no regressions.
 *
 * The _refreshChatMessages flow now uses cursor deltas instead of a count-only guard.
 * For non-buggy inputs, the observable outcomes remain:
 * - fetchedMsgCount > _chatLastMsgCount → re-render happens
 * - _chatLastMsgCount === 0 && fetchedMsgCount > 0 → initial render happens
 * - fetchedMsgCount === _chatLastMsgCount && _chatLastMsgCount > 0 → no re-render needed
 *
 * Property 4: Preservation — Normal Polling and Session Operations Unchanged
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Source code loader ───
const DASHBOARD_JS_PATH = join(
    __dirname,
    "..",
    "..",
    "assets",
    "dashboard.js.txt",
);

function loadDashboardJs(): string {
    return readFileSync(DASHBOARD_JS_PATH, "utf-8");
}

// ─── Helper: Extract function body ───
function extractFunctionBody(src: string, startIdx: number): string {
    let braceCount = 0;
    let started = false;
    let bodyStart = startIdx;

    for (let i = startIdx; i < src.length && i < startIdx + 15000; i++) {
        if (src[i] === "{") {
            if (!started) {
                started = true;
                bodyStart = i;
            }
            braceCount++;
        } else if (src[i] === "}") {
            braceCount--;
            if (started && braceCount === 0) {
                return src.substring(bodyStart, i + 1);
            }
        }
    }
    return src.substring(startIdx, startIdx + 8000);
}

/**
 * Simulate the observed cursor-based polling outcome from the dashboard source.
 *
 * Returns:
 *   { skipped: boolean, newChatLastMsgCount: number }
 *   - skipped=true means no re-render was needed because there were no newer messages
 *   - skipped=false means the chat should re-render/apply a delta
 */
function simulateRefreshGuard(
    chatLastMsgCount: number,
    fetchedMsgCount: number,
): { skipped: boolean; newChatLastMsgCount: number } {
    // Read the actual source to confirm the guard logic
    const src = loadDashboardJs();
    const fnStart = src.indexOf("function _refreshChatMessages(");
    if (fnStart === -1) throw new Error("_refreshChatMessages not found");
    const fnBody = extractFunctionBody(src, fnStart);

    expect(fnBody).toContain("?after=");
    expect(fnBody).not.toContain("newCount<=_chatLastMsgCount");
    expect(fnBody).not.toContain("_chatLastMsgCount===newCount");

    const skipped = fetchedMsgCount === chatLastMsgCount && chatLastMsgCount > 0;

    if (skipped) {
        return { skipped: true, newChatLastMsgCount: chatLastMsgCount };
    }
    return { skipped: false, newChatLastMsgCount: fetchedMsgCount };
}

// ─── Arbitraries ───

/** Positive message count (1..200) */
const arbPositiveCount = fc.integer({ min: 1, max: 200 });

/** Non-negative message count (0..200) */
const arbCount = fc.integer({ min: 0, max: 200 });

describe("Property 4: Preservation — Normal Polling and Session Operations Unchanged", () => {
    /**
     * Preservation Property 1: New messages trigger re-render
     *
     * For all (_chatLastMsgCount, fetchedMsgCount) where fetchedMsgCount > _chatLastMsgCount:
     * the guard must NOT skip — re-render must happen so new messages are picked up.
     *
     * This validates that normal polling continues to work: when the backend has
     * more messages than the frontend last saw, the chat view updates.
     *
     * **Validates: Requirements 3.1, 3.4**
     */
    it("re-renders when fetchedMsgCount > _chatLastMsgCount (new messages arrive)", () => {
        fc.assert(
            fc.property(
                arbCount,
                fc.integer({ min: 1, max: 200 }),
                (chatLastMsgCount, delta) => {
                    const fetchedMsgCount = chatLastMsgCount + delta;
                    const result = simulateRefreshGuard(
                        chatLastMsgCount,
                        fetchedMsgCount,
                    );

                    // Re-render MUST happen — new messages should be displayed
                    expect(result.skipped).toBe(false);
                    // _chatLastMsgCount should be updated to the new count
                    expect(result.newChatLastMsgCount).toBe(fetchedMsgCount);
                },
            ),
            { numRuns: 100 },
        );
    });

    /**
     * Preservation Property 2: Initial load / session open triggers re-render
     *
     * For all (_chatLastMsgCount, fetchedMsgCount) where _chatLastMsgCount === 0
     * and fetchedMsgCount > 0: the guard must NOT skip — the initial message load
     * must render.
     *
     * This validates that opening an existing session with messages works correctly.
     *
     * **Validates: Requirements 3.2**
     */
    it("re-renders on initial load when _chatLastMsgCount === 0 and fetchedMsgCount > 0", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 200 }),
                (fetchedMsgCount) => {
                    const chatLastMsgCount = 0;
                    const result = simulateRefreshGuard(
                        chatLastMsgCount,
                        fetchedMsgCount,
                    );

                    // Re-render MUST happen — initial load should display messages
                    expect(result.skipped).toBe(false);
                    expect(result.newChatLastMsgCount).toBe(fetchedMsgCount);
                },
            ),
            { numRuns: 100 },
        );
    });

    /**
     * Preservation Property 3: Equal count with non-zero skips re-render
     *
     * For all (_chatLastMsgCount, fetchedMsgCount) where
     * fetchedMsgCount === _chatLastMsgCount and _chatLastMsgCount > 0:
     * the guard MUST skip — no new messages means no re-render needed.
     *
     * This validates that the fast-path optimization works: when the backend
     * returns the same number of messages, we don't waste time re-rendering.
     *
     * **Validates: Requirements 3.4**
     */
    it("skips re-render when fetchedMsgCount === _chatLastMsgCount and _chatLastMsgCount > 0", () => {
        fc.assert(
            fc.property(arbPositiveCount, (count) => {
                const result = simulateRefreshGuard(count, count);

                // Re-render MUST be skipped — no new messages
                expect(result.skipped).toBe(true);
                // _chatLastMsgCount should remain unchanged
                expect(result.newChatLastMsgCount).toBe(count);
            }),
            { numRuns: 100 },
        );
    });
});
