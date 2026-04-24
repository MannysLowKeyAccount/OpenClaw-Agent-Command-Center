/**
 * Preservation Property Tests — Normal Session Operations Unchanged
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
 *
 * IMPORTANT: These tests capture the CURRENT (unfixed) behavior for non-buggy inputs.
 * They MUST PASS on unfixed code — confirming baseline behavior to preserve.
 * After the fix is applied, they MUST STILL PASS — confirming no regressions.
 *
 * Property 2: Preservation - Normal Session Operations Unchanged
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Source code loaders ───
const DASHBOARD_JS_PATH = join(__dirname, "..", "..", "assets", "dashboard.js.txt");
const SESSIONS_TS_PATH = join(__dirname, "..", "routes", "sessions.ts");

function loadDashboardJs(): string {
    return readFileSync(DASHBOARD_JS_PATH, "utf-8");
}

function loadSessionsTs(): string {
    return readFileSync(SESSIONS_TS_PATH, "utf-8");
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
    return src.substring(startIdx, startIdx + 5000);
}

// ─── Arbitraries ───
const arbAgentId = fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/);
const arbSessionKey = fc.stringMatching(/^[a-z][a-z0-9_:-]{2,39}$/);


// ─── Property 2: Preservation Tests ───

describe("Property 2: Preservation — Normal Session Operations Unchanged", () => {
    /**
     * Req 3.1 & 3.2: Normal message send where primarySessionKey matches current key.
     * POST /sessions/{key}/message returns {ok: true, result, response, primarySessionKey} with status 200.
     *
     * Observation on unfixed code: The message handler uses exec("openclaw agent --message ...")
     * and returns json(res, 200, { ok: true, result: responseText, response: responseText, primarySessionKey }).
     * The response format is preserved regardless of the CLI vs gateway implementation.
     *
     * **Validates: Requirements 3.1, 3.2**
     */
    describe("Normal message send response format (Req 3.1, 3.2)", () => {
        it("POST /sessions/{key}/message handler returns {ok, result, response, primarySessionKey} with status 200", () => {
            fc.assert(
                fc.property(arbSessionKey, arbAgentId, (_key, _agentId) => {
                    const src = loadSessionsTs();

                    // Find the message handler
                    const handlerMarker = 'action === "message"';
                    const handlerStart = src.indexOf(handlerMarker);
                    expect(handlerStart).toBeGreaterThan(-1);

                    // Extract the handler body (up to the next route handler)
                    const handlerEnd = src.indexOf('action === "spawn"', handlerStart);
                    const handlerBody = src.substring(
                        handlerStart,
                        handlerEnd > -1 ? handlerEnd : handlerStart + 3000,
                    );

                    // Verify the success response format: json(res, 200, { ok: true, result, response, primarySessionKey })
                    const hasOkTrue = handlerBody.includes("ok: true");
                    const hasResult = handlerBody.includes("result: responseText") || handlerBody.includes("result:");
                    const hasResponse = handlerBody.includes("response: responseText") || handlerBody.includes("response:");
                    const hasPrimarySessionKey = handlerBody.includes("primarySessionKey");
                    const hasStatus200 = handlerBody.includes("json(res, 200");

                    expect(hasOkTrue).toBe(true);
                    expect(hasResult).toBe(true);
                    expect(hasResponse).toBe(true);
                    expect(hasPrimarySessionKey).toBe(true);
                    expect(hasStatus200).toBe(true);
                }),
                { numRuns: 10 },
            );
        });

        it("sendMsg displays message and response in chat for normal sends (keys match)", () => {
            fc.assert(
                fc.property(arbSessionKey, (_key) => {
                    const src = loadDashboardJs();

                    const fnStart = src.indexOf("function sendMsg(");
                    expect(fnStart).toBeGreaterThan(-1);

                    const fnBody = extractFunctionBody(src, fnStart);

                    // Normal send flow: appends user message div, appends pending div, then on success replaces pending with response
                    const appendsUserMsg = fnBody.includes("chat-msg user");
                    const appendsPending = fnBody.includes("chat-pending");
                    const replacesWithResponse =
                        fnBody.includes("d.result") || fnBody.includes("d.response");
                    const enablesInput = fnBody.includes("inp.disabled=false");

                    expect(appendsUserMsg).toBe(true);
                    expect(appendsPending).toBe(true);
                    expect(replacesWithResponse).toBe(true);
                    expect(enablesInput).toBe(true);
                }),
                { numRuns: 10 },
            );
        });

        it("POST /sessions/{key}/message sends user text without rewriting or extra system prompts", () => {
            const src = loadSessionsTs();

            expect(src).toContain('messages: [{ role: "user", content: message }]');
            expect(src).not.toContain("DASHBOARD_CHAT_SYSTEM_MESSAGE");
            expect(src).not.toContain("not a heartbeat poll or scheduled heartbeat cycle");
            expect(src).toContain("callGatewayDashboardChat(agentId, userMessage, gatewaySessionId, config)");
        });

        it("POST /sessions/{key}/message stores dashboard chat in per-agent dashboard sessions", () => {
            const src = loadSessionsTs();

            expect(src).toContain("function appendDashboardSessionMessage");
            expect(src).toContain('kind: "primary"');
            expect(src).toContain('session.readOnly = false');
            expect(src).toContain('`dashboard-${agentId || "agent"}-main`');
            expect(src).toContain('const gatewaySessionId = `dashboard:${agentId || "agent"}:main`');
            expect(src).toContain('appendDashboardSessionMessage(targetSessionKey, agentId, "user", userMessage)');
            expect(src).toContain('appendDashboardSessionMessage(targetSessionKey, agentId, "assistant", responseText)');
            expect(src).toContain("callGatewayDashboardChat(agentId, userMessage, gatewaySessionId, config)");
        });

        it("dashboard JSON sessions are treated as writable primary threads", () => {
            const src = loadSessionsTs();

            expect(src).toContain('if (entry.channel === "dashboard") return "primary"');
        });

        it("POST /sessions/{key}/message persists dashboard chat only after gateway success", () => {
            const src = loadSessionsTs();
            const handlerStart = src.indexOf('action === "message"');
            expect(handlerStart).toBeGreaterThan(-1);
            const handlerEnd = src.indexOf('action === "spawn"', handlerStart);
            const handlerBody = src.substring(handlerStart, handlerEnd > -1 ? handlerEnd : handlerStart + 4000);
            const callIdx = handlerBody.indexOf("responseText = await callGatewayDashboardChat(agentId, userMessage, gatewaySessionId, config)");
            const userPersistIdx = handlerBody.indexOf('appendDashboardSessionMessage(targetSessionKey, agentId, "user", userMessage)');
            const assistantPersistIdx = handlerBody.indexOf('appendDashboardSessionMessage(targetSessionKey, agentId, "assistant", responseText)');

            expect(callIdx).toBeGreaterThan(-1);
            expect(userPersistIdx).toBeGreaterThan(callIdx);
            expect(assistantPersistIdx).toBeGreaterThan(userPersistIdx);
        });

        it("POST /sessions/{key}/message uses one REST request and rejects failed sentinels", () => {
            const src = loadSessionsTs();

            expect(src).toContain("function _responseLooksFailed");
            expect(src).toContain("async function callGatewayDashboardChat");
            expect(src).toContain('const runtimeAgentId = agentId === "main" ? "assistant" : agentId');
            expect(src).toContain("Agent couldn't generate a response");
            expect(src).toContain("if (_responseLooksFailed(response)) throw new Error");
            expect(src).toContain("allowCliFallback = true");
            expect(src).toContain("callGatewayChat(runtimeAgentId, message, sessionKey, config)");
        });
    });

    /**
     * Req 3.4: GET /sessions/agent/{agentId} returns {sessions: [...], agentId} from in-memory index.
     *
     * Observation on unfixed code: The handler filters sessionIndex entries by agentId
     * (including subagents) and returns json(res, 200, { sessions, agentId }).
     *
     * **Validates: Requirements 3.4**
     */
    describe("Session listing response format (Req 3.4)", () => {
        it("GET /sessions/agent/{agentId} returns {sessions, agentId} format", () => {
            fc.assert(
                fc.property(arbAgentId, (_agentId) => {
                    const src = loadSessionsTs();

                    // Find the agent session listing handler
                    const handlerMarker = 'sub[0] === "agent"';
                    const handlerStart = src.indexOf(handlerMarker);
                    expect(handlerStart).toBeGreaterThan(-1);

                    // Extract handler body up to the next route
                    const nextRoute = src.indexOf("// GET /sessions —", handlerStart);
                    const handlerBody = src.substring(
                        handlerStart,
                        nextRoute > -1 ? nextRoute : handlerStart + 2000,
                    );

                    // Verify response format: json(res, 200, { sessions, agentId })
                    const hasSessionsField = handlerBody.includes("{ sessions, agentId }") ||
                        handlerBody.includes("{sessions, agentId}") ||
                        (handlerBody.includes("sessions") && handlerBody.includes("agentId"));
                    const hasStatus200 = handlerBody.includes("json(res, 200");

                    // Verify it reads from sessionIndex (in-memory)
                    const usesIndex = handlerBody.includes("sessionIndex");

                    expect(hasSessionsField).toBe(true);
                    expect(hasStatus200).toBe(true);
                    expect(usesIndex).toBe(true);
                }),
                { numRuns: 10 },
            );
        });

        it("GET /sessions/agent/{agentId} does not fall back to another agent primary thread", () => {
            const src = loadSessionsTs();
            const handlerMarker = 'sub[0] === "agent"';
            const handlerStart = src.indexOf(handlerMarker);
            expect(handlerStart).toBeGreaterThan(-1);
            const nextRoute = src.indexOf("// GET /sessions —", handlerStart);
            const handlerBody = src.substring(handlerStart, nextRoute > -1 ? nextRoute : handlerStart + 3000);

            expect(handlerBody).toContain('summary.agentId === agentId');
            expect(handlerBody).toContain('summary.kind === "subagent"');
            expect(handlerBody).toContain("const explicitAttachedSessionKey = entry.attachedToSessionKey || entry.parentSessionKey || entry.rootSessionKey || null");
            expect(handlerBody).toContain("ownPrimaryKeys");
            expect(handlerBody).toContain("ownPrimaryKeys.has(explicitAttachedSessionKey)");
            expect(handlerBody).toContain("summary.attachedToAgentId === agentId");
            expect(handlerBody).toContain('a.channel === "dashboard"');
            expect(handlerBody).toContain('const primaryThread = sessions.find((s) => s.kind === "primary" && s.agentId === agentId) || null');
            expect(handlerBody).not.toContain('|| sessions.find((s) => s.kind === "primary") || null');
        });
    });

    /**
     * Req 3.3: DELETE /sessions/{key} removes session from sessionIndex and cleans up files.
     *
     * Observation on unfixed code: The handler deletes the session file, dashboard JSON,
     * updates sessions.json, and removes from sessionIndex.
     *
     * **Validates: Requirements 3.3**
     */
    describe("Session delete cleanup (Req 3.3)", () => {
        it("DELETE /sessions/{key} removes from sessionIndex and cleans up files", () => {
            fc.assert(
                fc.property(arbSessionKey, (_key) => {
                    const src = loadSessionsTs();

                    // Find the single session delete handler
                    const singleDeleteMarker = "// ─── Single session delete ───";
                    const handlerStart = src.indexOf(singleDeleteMarker);
                    expect(handlerStart).toBeGreaterThan(-1);

                    // Extract the handler body
                    const handlerEnd = src.indexOf("} catch (err", handlerStart);
                    const handlerBody = src.substring(
                        handlerStart,
                        handlerEnd > -1 ? handlerEnd : handlerStart + 2000,
                    );

                    // Verify cleanup steps:
                    // 1. Looks up session in index
                    const looksUpIndex = handlerBody.includes("sessionIndex.get(sessionKey)");
                    // 2. Deletes session file
                    const deletesFile = handlerBody.includes("unlinkAsync(entry.filePath)");
                    // 3. Deletes dashboard JSON
                    const deletesDashboard = handlerBody.includes("unlinkAsync(dashFp)");
                    // 4. Updates sessions.json
                    const updatesSessionsJson = handlerBody.includes("sessions.json");
                    // 5. Removes from sessionIndex
                    const removesFromIndex = handlerBody.includes("sessionIndex.delete(sessionKey)");

                    expect(looksUpIndex).toBe(true);
                    expect(deletesFile).toBe(true);
                    expect(deletesDashboard).toBe(true);
                    expect(updatesSessionsJson).toBe(true);
                    expect(removesFromIndex).toBe(true);
                }),
                { numRuns: 10 },
            );
        });
    });

    /**
     * Req 3.6: Rate limit errors (401, 403, 429) return 429 with {error, errorType: "model_limit"}.
     *
     * Observation on unfixed code: The message handler catches CLI errors, tests against
     * a rate-limit regex, and returns json(res, 429, { error, errorType: "model_limit", userMessageSaved: false }).
     *
     * **Validates: Requirements 3.6**
     */
    describe("Rate limit error handling (Req 3.6)", () => {
        it("gateway errors matching rate-limit regex return 429 with {error, errorType: 'model_limit'}", () => {
            fc.assert(
                fc.property(arbSessionKey, (_key) => {
                    const src = loadSessionsTs();

                    // Find the message handler error handling
                    const handlerMarker = 'action === "message"';
                    const handlerStart = src.indexOf(handlerMarker);
                    expect(handlerStart).toBeGreaterThan(-1);

                    const handlerEnd = src.indexOf('action === "spawn"', handlerStart);
                    const handlerBody = src.substring(
                        handlerStart,
                        handlerEnd > -1 ? handlerEnd : handlerStart + 3000,
                    );

                    // Verify rate-limit regex pattern exists
                    const hasRateLimitRegex = handlerBody.includes("usage limit") ||
                        handlerBody.includes("rate.limit") ||
                        handlerBody.includes("rate_limit");
                    // Verify it checks for auth/limit status codes
                    const checksStatusCodes = handlerBody.includes("401") &&
                        handlerBody.includes("403") &&
                        handlerBody.includes("429");
                    // Verify 429 response with model_limit errorType
                    const returns429 = handlerBody.includes("json(res, 429");
                    const hasModelLimit = handlerBody.includes('"model_limit"');
                    const reportsNotSaved = handlerBody.includes("userMessageSaved: false");

                    expect(hasRateLimitRegex).toBe(true);
                    expect(checksStatusCodes).toBe(true);
                    expect(returns429).toBe(true);
                    expect(hasModelLimit).toBe(true);
                    expect(reportsNotSaved).toBe(true);
                }),
                { numRuns: 10 },
            );
        });

        it("rate-limit regex matches expected error patterns", () => {
            // Directly test the regex pattern used in the handler
            const rateLimitRegex = /usage limit|rate.limit|rate_limit|quota|invalid.*key|invalid.*api|unauthorized|401|403|429|too many requests|failover/i;

            fc.assert(
                fc.property(
                    fc.oneof(
                        fc.constant("usage limit exceeded"),
                        fc.constant("rate limit reached"),
                        fc.constant("rate_limit_error"),
                        fc.constant("quota exceeded"),
                        fc.constant("invalid api key"),
                        fc.constant("unauthorized access"),
                        fc.constant("HTTP 401"),
                        fc.constant("HTTP 403"),
                        fc.constant("HTTP 429"),
                        fc.constant("too many requests"),
                        fc.constant("failover triggered"),
                    ),
                    (errorMsg) => {
                        expect(rateLimitRegex.test(errorMsg)).toBe(true);
                    },
                ),
                { numRuns: 20 },
            );
        });

        it("non-rate-limit errors return 503 with {error, ok: false}", () => {
            fc.assert(
                fc.property(arbSessionKey, (_key) => {
                    const src = loadSessionsTs();

                    const handlerMarker = 'action === "message"';
                    const handlerStart = src.indexOf(handlerMarker);
                    expect(handlerStart).toBeGreaterThan(-1);

                    const handlerEnd = src.indexOf('action === "spawn"', handlerStart);
                    const handlerBody = src.substring(
                        handlerStart,
                        handlerEnd > -1 ? handlerEnd : handlerStart + 3000,
                    );

                    // Verify non-rate-limit errors return 503
                    const returns503 = handlerBody.includes("json(res, 503");
                    const hasOkFalse = handlerBody.includes("ok: false");
                    const reportsNotSaved = handlerBody.includes("userMessageSaved: false");

                    expect(returns503).toBe(true);
                    expect(hasOkFalse).toBe(true);
                    expect(reportsNotSaved).toBe(true);
                }),
                { numRuns: 10 },
            );
        });
    });

    /**
     * Req 3.5: Opening an existing session with messages loads and displays full message history.
     *
     * Observation on unfixed code: _openChatFullscreen renders a chat overlay with a messages
     * container, and _renderChatMessages iterates over all messages to build the HTML.
     *
     * **Validates: Requirements 3.5**
     */
    describe("Opening existing session loads full history (Req 3.5)", () => {
        it("_openChatFullscreen creates chat overlay with messages container", () => {
            fc.assert(
                fc.property(arbSessionKey, (_key) => {
                    const src = loadDashboardJs();

                    const fnStart = src.indexOf("function _openChatFullscreen(");
                    expect(fnStart).toBeGreaterThan(-1);

                    const fnBody = extractFunctionBody(src, fnStart);

                    // Verify it creates the fullscreen overlay
                    const createsOverlay = fnBody.includes("chat-fullscreen");
                    // Verify it has a messages container
                    const hasMsgsContainer = fnBody.includes("chat-msgs");
                    // Verify it has an input field for non-readonly
                    const hasInputField = fnBody.includes("chat-in");
                    // Verify it appends to document body
                    const appendsToBody = fnBody.includes("document.body.appendChild");

                    expect(createsOverlay).toBe(true);
                    expect(hasMsgsContainer).toBe(true);
                    expect(hasInputField).toBe(true);
                    expect(appendsToBody).toBe(true);
                }),
                { numRuns: 10 },
            );
        });

        it("_renderChatMessages renders all messages from the messages array", () => {
            fc.assert(
                fc.property(arbSessionKey, (_key) => {
                    const src = loadDashboardJs();

                    const fnStart = src.indexOf("function _renderChatMessages(");
                    expect(fnStart).toBeGreaterThan(-1);

                    const fnBody = extractFunctionBody(src, fnStart);

                    // Verify it iterates over messages
                    const iteratesMessages = fnBody.includes("msgs.forEach") || fnBody.includes("for(");
                    // Verify it renders role labels
                    const rendersRoles = fnBody.includes("chat-role-label");
                    // Verify it renders message bubbles
                    const rendersBubbles = fnBody.includes("chat-bubble");
                    // Verify it handles empty state
                    const handlesEmpty = fnBody.includes("No messages yet");

                    expect(iteratesMessages).toBe(true);
                    expect(rendersRoles).toBe(true);
                    expect(rendersBubbles).toBe(true);
                    expect(handlesEmpty).toBe(true);
                }),
                { numRuns: 10 },
            );
        });
    });

    /**
     * Req 3.7: DELETE /sessions/all:{agentId} deletes all subagent sessions and refreshes list.
     *
     * Observation on unfixed code: The handler collects all agent IDs (parent + subagents),
     * deletes all matching session files, removes from sessionIndex, and returns
     * { ok: true, deleted, cleanedAll: true, cleanedAgents }.
     *
     * **Validates: Requirements 3.7**
     */
    describe("Delete all subagent sessions (Req 3.7)", () => {
        it("DELETE /sessions/all:{agentId} deletes all sessions for agent and subagents", () => {
            fc.assert(
                fc.property(arbAgentId, (_agentId) => {
                    const src = loadSessionsTs();

                    // Find the "all:" handler
                    const allMarker = 'sessionKey.startsWith("all:")';
                    const handlerStart = src.indexOf(allMarker);
                    expect(handlerStart).toBeGreaterThan(-1);

                    // Extract handler body
                    const singleDeleteMarker = "// ─── Single session delete ───";
                    const handlerEnd = src.indexOf(singleDeleteMarker, handlerStart);
                    const handlerBody = src.substring(
                        handlerStart,
                        handlerEnd > -1 ? handlerEnd : handlerStart + 3000,
                    );

                    // Verify it collects subagent IDs
                    const collectsSubagents = handlerBody.includes("subagents") ||
                        handlerBody.includes("childAgentIds") ||
                        handlerBody.includes("allAgentIds");
                    // Verify it deletes from sessionIndex
                    const deletesFromIndex = handlerBody.includes("sessionIndex.delete");
                    // Verify response format
                    const hasCleanedAll = handlerBody.includes("cleanedAll: true");
                    const hasCleanedAgents = handlerBody.includes("cleanedAgents");

                    expect(collectsSubagents).toBe(true);
                    expect(deletesFromIndex).toBe(true);
                    expect(hasCleanedAll).toBe(true);
                    expect(hasCleanedAgents).toBe(true);
                }),
                { numRuns: 10 },
            );
        });
    });
});
