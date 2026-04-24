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

function sessionUiCtx() {
    const state: Record<string, { query: string; filter: string; sort: string }> = {};
    return {
        _sessionUiState: state,
        _sessionState: (agentId: string) => {
            if (!state[agentId]) state[agentId] = { query: "", filter: "all", sort: "recent" };
            return state[agentId];
        },
        _sessionDisplayName(session: any, agentId: string) {
            const key = session?.threadId || session?.sessionKey || session?.id || "";
            if (session?.kind === "primary") return `${agentId || session?.agentId || "agent"} main thread`;
            if (session?.agentId && session.agentId !== agentId) return session.agentId;
            if (key.includes("-")) return `${key.split("-")[0]} task`;
            return key || "Attached thread";
        },
        _sessionSecondaryLabel(session: any) {
            const key = session?.threadId || session?.sessionKey || session?.id || "";
            return key.length > 28 ? `${key.slice(0, 28)}…` : key;
        },
        _sessionStatusLabel(session: any) {
            if (session?.readOnly || session?.kind === "subagent") return (session?.messageCount || 0) > 0 ? "read-only" : "idle";
            return (session?.messageCount || 0) > 0 ? "active" : "ready";
        },
        _sessionQueryMatch(session: any, query: string) {
            if (!query) return true;
            const q = query.toLowerCase();
            const key = session?.threadId || session?.sessionKey || session?.id || "";
            return `${key} ${session?.agentId || ""}`.toLowerCase().includes(q);
        },
        _sessionFilterMatch(session: any, filter: string) {
            const count = session?.messageCount || 0;
            const readOnly = !!(session?.readOnly || session?.kind === "subagent");
            if (filter === "active") return count > 0 && !readOnly;
            if (filter === "readonly") return readOnly;
            if (filter === "empty") return count === 0;
            return true;
        },
        _sessionSortList(list: any[], sort: string) {
            return list.slice().sort((a, b) => {
                if (sort === "messages") return (b.messageCount || 0) - (a.messageCount || 0);
                if (sort === "name") return String(a.sessionKey || a.threadId || "").localeCompare(String(b.sessionKey || b.threadId || ""));
                if (sort === "oldest") return new Date(a.updatedAt || 0).getTime() - new Date(b.updatedAt || 0).getTime();
                return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
            });
        },
        _sessionSummaryCounts(primarySession: any, subagentSessions: any[], extraPrimarySessions: any[]) {
            const all = [...(primarySession ? [primarySession] : []), ...(subagentSessions || []), ...(extraPrimarySessions || [])];
            return {
                total: all.length,
                active: all.filter((session) => (session?.messageCount || 0) > 0 && !(session?.readOnly || session?.kind === "subagent")).length,
                readonly: all.filter((session) => !!(session?.readOnly || session?.kind === "subagent")).length,
                empty: all.filter((session) => (session?.messageCount || 0) === 0).length,
            };
        },
        _renderSessionRow({ session, key, agentId, title, secondary, kind }: any) {
            const resolvedKey = key || session?.threadId || session?.sessionKey || session?.id || "";
            return `<div class="session-card${kind === "main" ? " session-card-main" : ""}" data-session-action="${kind === "main" ? "open-main" : "open-thread"}" data-session-key="${resolvedKey}" data-agent-id="${agentId || ""}"><button class="btn btn-sm btn-accent">${kind === "main" ? "Open Chat" : "Open"}</button><button class="btn btn-sm btn-danger" data-session-action="${kind === "main" ? "clear-main" : "end-session"}">${kind === "main" ? "Clear session" : "End"}</button>${title || ""}${secondary || ""}</div>`;
        },
    };
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
            ...sessionUiCtx(),
        };

        vm.runInNewContext(block, ctx);
        const html = ctx.renderSessions({ id: "alpha" });

        expect(html).toContain("main thread");
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
            ...sessionUiCtx(),
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

    it("renders safer session cards with promoted open actions", () => {
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
            ...sessionUiCtx(),
        };

        vm.runInNewContext(block, ctx);
        const html = ctx.renderSessions({ id: "alpha" });

        expect(html).toContain('class="session-card');
        expect(html).toContain('Open Chat');
        expect(html).toContain('data-session-action="clear-main"');
        expect(html).toContain('data-session-action="end-session"');
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
            ...sessionUiCtx(),
        };

        vm.runInNewContext(block, ctx);
        const html = ctx.renderSessions({ id: "alpha" });

        expect(html).toContain('data-session-action="refresh"');
        expect(html).toContain('data-session-action="open-main"');
        expect(html).toContain('data-session-action="open-thread"');
        expect(html).toContain('data-session-action="clear-main"');
        expect(html).toContain('data-session-action="end-session"');
        expect(html).toContain('data-session-action="end-subagents"');
        expect(html).toContain('data-session-control="query"');
        expect(html).not.toContain('data-session-control="sort"');
        expect(html).not.toContain('data-session-action="set-filter"');
        expect(html).not.toContain('session-summary-pill');
        expect(html).not.toContain('data-session-action="manage-main"');
        expect(html).not.toContain('data-session-action="manage-thread"');
        expect(html).not.toContain('data-session-action="manage-subagents"');
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
        const block = extractRange(source, "_chatTextHasInternalMarker", "closeChatView");

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
        const block = extractRange(source, "_chatTextHasInternalMarker", "closeChatView");

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

    it("hides heartbeat markers from untyped array thinking parts while preserving visible text", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "_chatTextHasInternalMarker", "closeChatView");

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

        expect(el.innerHTML).not.toContain("Read HEARTBEAT.md");
        expect(el.innerHTML).toContain("Visible reply");
        expect(el.innerHTML).toContain("Visible after");
    });

    it("hides plugin-only assistant chatter with Hide Internal", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "_chatTextHasInternalMarker", "closeChatView");

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
            { role: "assistant", content: "[plugins] [agent-dashboard] Loading Agent Dashboard plugin..." },
            { role: "assistant", content: "[plugins] memory-lancedb: plugin registered (db: /home/manthan/.openclaw/memory/lancedb, lazy init)" },
            { role: "assistant", content: "Visible reply" },
        ], false);

        expect(el.innerHTML).not.toContain("[plugins]");
        expect(el.innerHTML).not.toContain("memory-lancedb");
        expect(el.innerHTML).toContain("Visible reply");
    });

    it("strips plugin chatter while preserving mixed assistant answers", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "_chatTextHasInternalMarker", "closeChatView");

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
            { role: "assistant", content: "[plugins] [agent-dashboard] Loading Agent Dashboard plugin...\n[plugins] memory-lancedb: plugin registered (db: /tmp/db)\nHey! What's up?" },
            { role: "assistant", content: ["[plugins] [agent-dashboard] Loading Agent Dashboard plugin...", { text: "Clean array answer" }] },
        ], false);

        expect(el.innerHTML).not.toContain("[plugins]");
        expect(el.innerHTML).not.toContain("memory-lancedb");
        expect(el.innerHTML).toContain("Hey! What's up?");
        expect(el.innerHTML).toContain("Clean array answer");
    });

    it("strips screenshot-style internal chatter and hides bubble when nothing remains", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "_chatTextHasInternalMarker", "closeChatView");

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
            {
                role: "assistant",
                content: [
                    "[plugins] [agent-dashboard] Loading Agent Dashboard plugin...\n[plugins] memory-lancedb: plugin registered (db: /home/manthan/.openclaw/memory/lancedb, lazy init)\nHEARTBEAT_OK",
                ],
            },
            {
                role: "assistant",
                content: "[plugins] [agent-dashboard] Loading Agent Dashboard plugin...\n[plugins] memory-lancedb: plugin registered (db: /tmp/db, lazy init)\nHEARTBEAT_OK\nActual assistant reply",
            },
        ], false);

        expect(el.innerHTML).not.toContain("Loading Agent Dashboard plugin");
        expect(el.innerHTML).not.toContain("memory-lancedb");
        expect(el.innerHTML).not.toContain("HEARTBEAT_OK");
        expect(el.innerHTML).toContain("Actual assistant reply");
        expect((el.innerHTML.match(/chat-bubble/g) || []).length).toBe(1);
    });

    it("uses cursor delta polling instead of count-only guards", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        expect(source).toContain("?after=");
        expect(source).toContain("?limit=100");

        const refreshBlock = extractRange(source, "_refreshChatMessages", "renderSubagents");
        expect(refreshBlock).not.toContain("newCount<=_chatLastMsgCount");
        expect(refreshBlock).toContain("_chatThreadState.lastSeq");
        expect(refreshBlock).toContain("_appendChatMessages(msgs)");
    });

    it("appends polling deltas without replacing existing chat DOM", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "_chatTextHasInternalMarker", "_openChatFullscreen");
        const existingNode = { stable: true };
        const el: any = {
            scrollHeight: 200,
            scrollTop: 140,
            clientHeight: 80,
            inserted: "",
            children: [existingNode],
            querySelector: () => null,
            insertAdjacentHTML(_where: string, html: string) {
                this.inserted += html;
            },
        };
        const ctx: any = {
            _chatHideInternal: true,
            _chatLastMsgs: [{ role: "user", content: "Already here" }],
            _chatLastMsgCount: 1,
            Q: (id: string) => (id === "chat-msgs" ? el : null),
            fmtTime: (value: string) => value,
            esc: (value: unknown) => String(value ?? ""),
        };

        vm.runInNewContext(block, ctx);
        const appended = ctx._appendChatMessages([
            { role: "user", content: "Already here" },
            { role: "assistant", content: "New answer" },
        ]);

        expect(appended).toBe(1);
        expect(el.children[0]).toBe(existingNode);
        expect(el.inserted).toContain("New answer");
        expect(el.inserted).not.toContain("Already here");
        expect(el.scrollTop).toBe(200);
        expect(ctx._chatLastMsgCount).toBe(2);
    });

    it("only animates newly appended chat messages", () => {
        const css = readFileSync(DASHBOARD_CSS_PATH, "utf-8");

        expect(css).toContain(".chat-msg.is-new");
        expect(css).not.toContain(".chat-msg {\n  max-width: min(85%, 72ch);\n  animation:");
    });
});
