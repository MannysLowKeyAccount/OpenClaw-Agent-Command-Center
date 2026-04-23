import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const DASHBOARD_JS_PATH = join(process.cwd(), "src/assets/dashboard.js.txt");
const DASHBOARD_CSS_PATH = join(process.cwd(), "src/assets/dashboard.css");

function extractRange(source: string, startName: string, endName: string): string {
    const start = source.indexOf(`function ${startName}(`);
    const end = source.indexOf(`function ${endName}(`, start + 1);
    if (start < 0 || end < 0) throw new Error(`Unable to locate ${startName}`);
    return source.slice(start, end);
}

describe("dashboard sessions rework", () => {
    it("renders attached read-only subagent threads from server summaries", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "_mergeAgentSessionsIntoGlobal", "refreshSessions");

        const ctx: any = {
            D: {
                agents: [{ id: "alpha" }],
                _agentSessions: {
                    alpha: [
                        {
                            threadId: "alpha-main",
                            sessionKey: "alpha-main",
                            agentId: "alpha",
                            kind: "primary",
                            readOnly: false,
                            updatedAt: "2026-04-21T10:00:00Z",
                            messageCount: 3,
                            lastEventSeq: 3,
                            attachedThreads: [
                                {
                                    threadId: "beta-sub",
                                    sessionKey: "beta-sub",
                                    agentId: "beta",
                                    kind: "subagent",
                                    readOnly: true,
                                    updatedAt: "2026-04-21T10:01:00Z",
                                    messageCount: 2,
                                    lastEventSeq: 2,
                                },
                            ],
                        },
                        {
                            threadId: "alpha-legacy",
                            sessionKey: "alpha-legacy",
                            agentId: "alpha",
                            kind: "primary",
                            readOnly: false,
                            updatedAt: "2026-04-20T10:00:00Z",
                            messageCount: 1,
                            lastEventSeq: 1,
                        },
                    ],
                },
            },
            drawerAgent: { id: "alpha" },
            drawerTab: "sessions",
            _sessionResetting: false,
            _modelLimitActive: false,
            _showProgress: () => undefined,
            _hideProgress: () => undefined,
            api: vi.fn(),
            document: { addEventListener: () => undefined },
            Q: () => null,
            fmtDate: (value: string) => value,
            esc: (value: unknown) => String(value ?? ""),
            toast: () => undefined,
            openSessionChat: () => undefined,
            confirm: () => true,
            renderSessions: () => "",
            _preloadOtherAgentSessions: () => undefined,
        };

        vm.runInNewContext(block, ctx);
        const html = ctx.renderSessions({ id: "alpha" });

        expect(html).toContain("Main Thread");
        expect(html).toContain("Attached Subagent Threads");
        expect(html).toContain("read-only");
        expect(html).toContain("beta-sub");
        expect(html).toContain("Other Primary Threads");
    });

    it("hydrates attached subagent threads from the agent session payload", async () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "_normalizeThreadSummary", "startMainChat");

        const attached = {
            threadId: "beta-sub",
            sessionKey: "beta-sub",
            agentId: "beta",
            kind: "subagent",
            readOnly: true,
            updatedAt: "2026-04-21T10:01:00Z",
            messageCount: 2,
            lastEventSeq: 2,
        };

        const ctx: any = {
            D: { agents: [{ id: "alpha" }], _agentSessions: {} },
            drawerAgent: { id: "alpha" },
            drawerTab: "sessions",
            _modelLimitActive: false,
            _sessionResetting: false,
            _showProgress: () => undefined,
            _hideProgress: () => undefined,
            api: vi.fn(),
            Q: () => null,
            esc: (value: unknown) => String(value ?? ""),
            _mergeAgentSessionsIntoGlobal: () => undefined,
            fmtDate: (value: string) => value,
            toast: () => undefined,
            openSessionChat: () => undefined,
            confirm: () => true,
            document: { addEventListener: () => undefined },
            _threadSort: () => 0,
            _threadKey: (session: any) => session.threadId || session.sessionKey || session.id || "",
            _threadCount: (session: any) => session.messageCount || 0,
            _threadIsPrimary: (session: any) => session.kind === "primary",
            _threadIsReadOnly: (session: any) => !!(session && (session.readOnly || session.kind === "subagent")),
            _normalizeThreadList: (value: unknown) => value,
        };

        vm.runInNewContext(block, ctx);
        const sessions = ctx._sessionListFromAgentResponse({
            threads: [
                { threadId: "alpha-main", sessionKey: "alpha-main", agentId: "alpha", kind: "primary" },
                attached,
            ],
            primaryThread: {
                threadId: "alpha-main",
                sessionKey: "alpha-main",
                agentId: "alpha",
                kind: "primary",
                attachedThreads: [attached],
            },
        });
        ctx.D._agentSessions.alpha = sessions;

        expect(ctx.D._agentSessions.alpha).toHaveLength(2);
        expect(ctx.D._agentSessions.alpha[0].attachedThreads).toHaveLength(1);
        expect(ctx.D._agentSessions.alpha[0].attachedThreads[0].sessionKey).toBe("beta-sub");

        const html = ctx.renderSessions({ id: "alpha" });
        expect(html).toContain("Attached Subagent Threads");
        expect(html).toContain("beta-sub");
    });

    it("ends attached subagent threads from the primary session", async () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "endSubagentSessions", "endAllSessions");

        const api = vi.fn().mockResolvedValue({});
        const ctx: any = {
            D: {
                _agentSessions: {
                    alpha: [
                        {
                            threadId: "alpha-main",
                            sessionKey: "alpha-main",
                            agentId: "alpha",
                            kind: "primary",
                            attachedThreads: [
                                {
                                    threadId: "beta-sub",
                                    sessionKey: "beta-sub",
                                    agentId: "beta",
                                    kind: "subagent",
                                    readOnly: true,
                                },
                            ],
                        },
                    ],
                },
            },
            api,
            _showProgress: () => undefined,
            _hideProgress: () => undefined,
            toast: () => undefined,
            confirm: () => true,
            refreshSessions: () => undefined,
            _threadIsReadOnly: (session: any) => !!(session && (session.readOnly || session.kind === "subagent")),
            _threadKey: (session: any) => session.threadId || session.sessionKey || session.id || "",
        };

        vm.runInNewContext(block, ctx);
        ctx.endSubagentSessions("alpha");
        await Promise.resolve();
        await Promise.resolve();

        expect(api).toHaveBeenCalledWith("sessions/beta-sub", expect.objectContaining({ method: "DELETE", _quiet: true }));
    });

    it("renders compact icon-only subagent actions with accessible labels", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "renderSessions", "startMainChat");

        const ctx: any = {
            D: {
                agents: [{ id: "alpha" }],
                _agentSessions: {
                    alpha: [
                        {
                            threadId: "alpha-main",
                            sessionKey: "alpha-main",
                            agentId: "alpha",
                            kind: "primary",
                            readOnly: false,
                            updatedAt: "2026-04-21T10:00:00Z",
                            messageCount: 3,
                            lastEventSeq: 3,
                            attachedThreads: [
                                {
                                    threadId: "beta-sub",
                                    sessionKey: "beta-sub",
                                    agentId: "beta",
                                    kind: "subagent",
                                    readOnly: true,
                                    updatedAt: "2026-04-21T10:01:00Z",
                                    messageCount: 2,
                                    lastEventSeq: 2,
                                },
                            ],
                        },
                    ],
                },
            },
            drawerAgent: { id: "alpha" },
            drawerTab: "sessions",
            _modelLimitActive: false,
            _sessionResetting: false,
            _normalizeThreadList: (value: unknown) => value,
            _threadSort: () => 0,
            _threadIsPrimary: (session: any) => session.kind === "primary",
            _threadIsReadOnly: (session: any) => !!(session && (session.readOnly || session.kind === "subagent")),
            _threadKey: (session: any) => session.threadId || session.sessionKey || session.id || "",
            _threadCount: (session: any) => session.messageCount || 0,
            _showProgress: () => undefined,
            _hideProgress: () => undefined,
            api: vi.fn(),
            document: { addEventListener: () => undefined },
            Q: () => null,
            fmtDate: (value: string) => value,
            esc: (value: unknown) => String(value ?? ""),
            toast: () => undefined,
            openSessionChat: () => undefined,
            clearMainSession: () => undefined,
            endSubagentSessions: () => undefined,
            endSession: () => undefined,
            refreshSessions: () => undefined,
            startMainChat: () => undefined,
        };

        vm.runInNewContext(block, ctx);
        const html = ctx.renderSessions({ id: "alpha" });

        expect(html).toContain('class="btn btn-sm btn-icon"');
        expect(html).toContain('aria-label="Open attached subagent chat"');
        expect(html).toContain('title="Open attached subagent chat"');
        expect(html).toContain('btn btn-sm btn-danger');
    });

    it("uses data attributes for session actions instead of inline JS strings", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "renderSessions", "startMainChat");

        const ctx: any = {
            D: {
                agents: [{ id: "alpha" }],
                _agentSessions: {
                    alpha: [
                        {
                            threadId: "alpha-main",
                            sessionKey: "alpha-main",
                            agentId: "alpha",
                            kind: "primary",
                            readOnly: false,
                            updatedAt: "2026-04-21T10:00:00Z",
                            messageCount: 3,
                            lastEventSeq: 3,
                            attachedThreads: [
                                {
                                    threadId: "beta'\"-sub",
                                    sessionKey: "beta'\"-sub",
                                    agentId: "beta'\"",
                                    kind: "subagent",
                                    readOnly: true,
                                    updatedAt: "2026-04-21T10:01:00Z",
                                    messageCount: 2,
                                    lastEventSeq: 2,
                                },
                            ],
                        },
                    ],
                },
            },
            drawerAgent: { id: "alpha" },
            drawerTab: "sessions",
            _modelLimitActive: false,
            _sessionResetting: false,
            _normalizeThreadList: (value: unknown) => value,
            _threadSort: () => 0,
            _threadIsPrimary: (session: any) => session.kind === "primary",
            _threadIsReadOnly: (session: any) => !!(session && (session.readOnly || session.kind === "subagent")),
            _threadKey: (session: any) => session.threadId || session.sessionKey || session.id || "",
            _threadCount: (session: any) => session.messageCount || 0,
            _showProgress: () => undefined,
            _hideProgress: () => undefined,
            api: vi.fn(),
            document: { addEventListener: () => undefined },
            Q: () => null,
            fmtDate: (value: string) => value,
            esc: (value: unknown) => String(value ?? ""),
            toast: () => undefined,
            openSessionChat: () => undefined,
            clearMainSession: () => undefined,
            endSubagentSessions: () => undefined,
            endSession: () => undefined,
            refreshSessions: () => undefined,
            startMainChat: () => undefined,
        };

        vm.runInNewContext(block, ctx);
        const html = ctx.renderSessions({ id: "alpha" });

        expect(html).toContain('data-session-action="refresh"');
        expect(html).toContain('data-session-action="open-main"');
        expect(html).toContain('data-session-action="open-thread"');
        expect(html).toContain('data-session-action="clear-main"');
        expect(html).toContain('data-session-action="end-subagents"');
        expect(html).toContain('data-session-action="end-session"');
        expect(html).not.toContain('onclick="openSessionChat');
        expect(html).not.toContain('onclick="event.stopPropagation();openSessionChat');
        expect(html).not.toContain('onclick="refreshSessions');
    });

    it("keeps the mobile subagent action button right-aligned and icon-sized", () => {
        const source = readFileSync(DASHBOARD_CSS_PATH, "utf-8");

        expect(source).toContain("@media(max-width:480px)");
        expect(source).toContain(".session-subagent-actions {");
        expect(source).toContain("justify-content: flex-end");
        expect(source).toContain(".session-subagent-actions .btn-icon {");
        expect(source).toContain("width: 2.25rem");
        expect(source).toContain("flex: 0 0 2.25rem");
    });

    it("keeps the sessions refresh button compact on mobile", () => {
        const css = readFileSync(DASHBOARD_CSS_PATH, "utf-8");
        const js = readFileSync(DASHBOARD_JS_PATH, "utf-8");

        expect(css).toContain(".session-header-refresh {");
        expect(css).toContain("align-self: flex-end");
        expect(js).toContain('class="btn btn-sm session-header-refresh"');
    });

    it("hides backend-classified internal chat messages even without marker text", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "_renderChatMessages", "closeChatView");

        const el: any = {
            innerHTML: "",
            scrollHeight: 200,
            scrollTop: 0,
            clientHeight: 150,
        };
        const ctx: any = {
            _chatHideInternal: true,
            _chatLastMsgs: null,
            Q: (id: string) => (id === "chat-msgs" ? el : null),
            fmtTime: (value: string) => value,
            esc: (value: unknown) => String(value ?? ""),
        };

        vm.runInNewContext(block, ctx);
        ctx._renderChatMessages([
            { role: "assistant", content: "heartbeat tick", internal: true },
            { role: "assistant", content: "Visible reply" },
        ], false);

        expect(el.innerHTML).not.toContain("heartbeat tick");
        expect(el.innerHTML).toContain("Visible reply");
    });

    it("hides heartbeat orchestration chatter with Hide Internal", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "_renderChatMessages", "closeChatView");

        const el: any = {
            innerHTML: "",
            scrollHeight: 200,
            scrollTop: 0,
            clientHeight: 150,
        };
        const ctx: any = {
            _chatHideInternal: true,
            _chatLastMsgs: null,
            Q: (id: string) => (id === "chat-msgs" ? el : null),
            fmtTime: (value: string) => value,
            esc: (value: unknown) => String(value ?? ""),
        };

        vm.runInNewContext(block, ctx);
        ctx._renderChatMessages([
            { role: "assistant", content: "Read HEARTBEAT.md and continue" },
            { role: "assistant", content: "HEARTBEAT_OK" },
            { role: "assistant", content: "Visible reply" },
        ], false);

        expect(el.innerHTML).not.toContain("Read HEARTBEAT.md");
        expect(el.innerHTML).not.toContain("HEARTBEAT_OK");
        expect(el.innerHTML).toContain("Visible reply");
    });

    it("hides heartbeat markers from untyped array thinking parts with Hide Internal", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "_renderChatMessages", "closeChatView");

        const el: any = {
            innerHTML: "",
            scrollHeight: 200,
            scrollTop: 0,
            clientHeight: 150,
        };
        const ctx: any = {
            _chatHideInternal: true,
            _chatLastMsgs: null,
            Q: (id: string) => (id === "chat-msgs" ? el : null),
            fmtTime: (value: string) => value,
            esc: (value: unknown) => String(value ?? ""),
        };

        vm.runInNewContext(block, ctx);
        ctx._renderChatMessages([
            { role: "assistant", content: [{ thinking: "Read HEARTBEAT.md" }, { text: "Visible reply" }] },
            { role: "assistant", content: "Visible after" },
        ], false);

        expect(el.innerHTML).not.toContain("Visible reply");
        expect(el.innerHTML).toContain("Visible after");
    });

    it("uses cursor delta polling instead of count-only guards", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        expect(source).toContain("?after=");
        expect(source).toContain("?limit=100");

        const refreshBlock = extractRange(source, "_refreshChatMessages", "renderSubagents");
        expect(refreshBlock).not.toContain("newCount<=_chatLastMsgCount");
        expect(refreshBlock).toContain("_chatThreadState.lastSeq");
    });
});
