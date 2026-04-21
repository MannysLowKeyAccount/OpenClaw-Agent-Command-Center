import { describe, it, expect } from "vitest";
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
});
