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

describe("dashboard agent list sidebar", () => {
    it("renders model and bindings on separate metadata lines", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const block = extractRange(source, "renderAgentList", "zoomMap");

        const body = { innerHTML: "" };
        const ctx: any = {
            D: {
                agents: [
                    { id: "alpha", name: "Primary Agent With Very Long Name", default: true, model: "openai/gpt-5.4" },
                ],
            },
            drawerAgent: { id: "alpha" },
            Q: (id: string) => (id === "agent-list-body" ? body : null),
            getPeers: () => ["alpha"],
            agentIcon: () => "🤖",
            getModel: (agent: any) => agent.model,
            _bindingCountForAgent: () => 3,
            _bindingCountLabel: (count: number) => `${count} bindings`,
            openDrawer: () => undefined,
            esc: (value: unknown) => String(value ?? ""),
        };

        vm.runInNewContext(block, ctx);
        ctx.renderAgentList();

        expect(body.innerHTML).toContain("<div class=\"agent-list-meta\"><div class=\"agent-list-meta-model\" title=\"openai/gpt-5.4\">openai/gpt-5.4</div><div class=\"agent-list-meta-bindings\" title=\"3 bindings\">3 bindings</div></div>");
        expect(body.innerHTML).toContain("DEFAULT");
        expect(body.innerHTML).not.toContain("agent-list-meta-sep");
    });
});
