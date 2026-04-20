import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";

const DASHBOARD_JS_PATH = join(process.cwd(), "src/assets/dashboard.js.txt");

function extractFunction(source: string, name: string, nextName: string): string {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(`function ${nextName}(`, start + 1);
    if (start < 0 || end < 0) throw new Error(`Unable to locate ${name}`);
    return source.slice(start, end);
}

describe("dashboard channels visibility", () => {
    it("keeps binding-only channels visible alongside configured ones", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const visibleFn = extractFunction(source, "_getVisibleChannels", "_setEffectiveBindings");
        const renderFn = extractFunction(source, "renderChannelsPage", "toggleChannelPage");

        const channelsBody = { innerHTML: "" };
        const ctx: any = {
            D: {
                channels: {
                    discord: { enabled: true, accounts: { default: { enabled: true } } },
                },
                bindings: [
                    { agentId: "alpha", match: { channel: "discord", accountId: "default" } },
                    { agentId: "beta", match: { channel: "slack" } },
                ],
            },
            Q: (id: string) => (id === "channels-body" ? channelsBody : null),
            esc: (value: unknown) => String(value ?? ""),
            chIcon: (ch: string) => `[${ch}]`,
            agentColor: () => "#123456",
            showAddAccountModal: () => undefined,
            showAddBindingModal: () => undefined,
            toggleChannelPage: () => undefined,
            editChannelSettings: () => undefined,
            deleteChannelPage: () => undefined,
            editAccountPage: () => undefined,
            deleteAccount: () => undefined,
            showEditBindingModal: () => undefined,
            removeBindingGlobal: () => undefined,
        };

        vm.runInNewContext(visibleFn, ctx);
        vm.runInNewContext(renderFn, ctx);

        const visible = ctx._getVisibleChannels();
        expect(Object.keys(visible).sort()).toEqual(["discord", "slack"]);

        ctx.renderChannelsPage();
        expect(channelsBody.innerHTML).toContain("discord");
        expect(channelsBody.innerHTML).toContain("slack");
        expect(channelsBody.innerHTML).toContain("beta");
    });
});
