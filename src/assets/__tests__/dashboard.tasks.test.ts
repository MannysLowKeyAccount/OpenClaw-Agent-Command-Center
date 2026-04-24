import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const DASHBOARD_JS_PATH = join(process.cwd(), "src/assets/dashboard.js.txt");

function extractRange(source: string, startName: string, endName: string): string {
    const start = source.indexOf(`function ${startName}(`);
    const end = source.indexOf(`function ${endName}(`, start + 1);
    if (start < 0 || end < 0) throw new Error(`Unable to locate ${startName}`);
    return source.slice(start, end);
}

describe("dashboard task visibility", () => {
    it("shows fixed interval fields by removing the hidden class", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const toggleBlock = extractRange(source, "toggleCronManualRecipient", "toggleAnnounceFields");
        const elements: Record<string, { hidden: boolean; classList: { toggle: (name: string, force?: boolean) => void } }> = {};
        for (const id of ["cj-cron-fields", "cj-every-fields", "cj-at-fields"]) {
            const element = {
                hidden: true,
                classList: {
                    toggle(name: string, force?: boolean) {
                        if (name === "is-hidden") element.hidden = Boolean(force);
                    },
                },
            };
            elements[id] = element;
        }
        const ctx: any = {
            V: () => "every",
            Q: (id: string) => elements[id] ?? null,
        };

        vm.runInNewContext(toggleBlock, ctx);
        ctx.toggleCronFields();

        expect(elements["cj-cron-fields"].hidden).toBe(true);
        expect(elements["cj-every-fields"].hidden).toBe(false);
        expect(elements["cj-at-fields"].hidden).toBe(true);
    });

    it("renders fixed interval jobs with every labels", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const helperBlock = extractRange(source, "_cronStatusLabel", "renderScheduledSection");
        const cardBlock = extractRange(source, "renderCronJobCard", "renderCronRunsModal");

        const ctx: any = {
            _taskRunPending: {},
            fmtDate: (value: string) => value,
            esc: (value: unknown) => String(value ?? ""),
            cronToHuman: (expr: string) => expr,
            Q: () => null,
        };

        vm.runInNewContext(helperBlock, ctx);
        vm.runInNewContext(cardBlock, ctx);

        const html = ctx.renderCronJobCard({
            id: "interval-brief",
            name: "Interval Brief",
            enabled: true,
            every: "6h",
        });

        expect(html).toContain("every 6h");
        expect(html).toContain('badge badge-muted">every');
    });

    it("uses larger prompt textareas in scheduled task modals", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");

        expect(source).toContain('id="cj-message" class="task-prompt-textarea" rows="8"');
        expect(source).toContain('id="cej-message" class="task-prompt-textarea" rows="8"');
    });

    it("renders the latest run status and result on scheduled cards", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const helperBlock = extractRange(source, "_cronStatusLabel", "renderScheduledSection");
        const cardBlock = extractRange(source, "renderCronJobCard", "renderCronRunsModal");

        const ctx: any = {
            _taskRunPending: {},
            fmtDate: (value: string) => value,
            esc: (value: unknown) => String(value ?? ""),
            cronToHuman: (expr: string) => expr,
            Q: () => null,
        };

        vm.runInNewContext(helperBlock, ctx);
        vm.runInNewContext(cardBlock, ctx);

        const html = ctx.renderCronJobCard({
            id: "nightly-gmail-triage",
            name: "Nightly Gmail Triage",
            enabled: true,
            schedule: { kind: "cron", expr: "0 7 * * *" },
            latestRun: {
                status: "running",
                latestProgress: "Decision: send follow-ups to finance",
                sessionId: "session-123",
                startedAt: "2026-04-21T07:00:00.000Z",
            },
        });

        expect(html).toContain("Running");
        expect(html).toContain("Decision: send follow-ups");
        expect(html).toContain("Session session-123");
    });

    it("shows an empty state when registered flows are loaded but absent", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const start = source.indexOf("var _registeredFlowsCache=[];");
        const end = source.indexOf("function _renderRegisteredFlowCard(", start);
        const flowsBlock = source.slice(start, end);

        const api = vi.fn();
        const ctx: any = {
            _registeredFlowsCache: [],
            _pendingFlowsCache: [],
            _flowHistoryCache: [],
            renderTasksPanel: vi.fn(),
            api,
            Q: () => null,
            esc: (value: unknown) => String(value ?? ""),
            agentToneClass: () => "",
        };

        vm.runInNewContext(flowsBlock, ctx);
        ctx._registeredFlowsCache = [];
        ctx._registeredFlowsLoaded = true;
        ctx._registeredFlowsLoading = false;
        ctx._registeredFlowsError = "";

        const html = ctx.renderFlowsSection();

        expect(html).toContain("No registered flows yet");
        expect(html).not.toContain("Loading…");
        expect(api).not.toHaveBeenCalled();
    });
});
