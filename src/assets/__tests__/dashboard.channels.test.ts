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
            _describeBindingRoute: (m: any) => m.guildId ? `guild: ${m.guildId}` : "all channels",
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

    it("captures guild IDs in Discord binding modals", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const addPeerFn = extractFunction(source, "_buildBindingAccPeer", "onBindingChChange");
        const editPeerFn = extractFunction(source, "_buildEditBindingAccPeer", "onEditBindingChChange");
        const ctx: any = {
            D: { channels: { discord: { accounts: { default: {} } } } },
            tip: (_label: string, body: string) => body,
            esc: (value: unknown) => String(value ?? ""),
        };

        vm.runInNewContext(addPeerFn, ctx);
        vm.runInNewContext(editPeerFn, ctx);

        expect(ctx._buildBindingAccPeer("discord")).toContain("ab-guild-id");
        expect(ctx._buildBindingAccPeer("discord")).toContain("Exact Discord bindings");
        expect(ctx._buildEditBindingAccPeer("discord", { guildId: "guild-1", peer: { kind: "channel", id: "chan-1" } })).toContain("eb-guild-id");
    });

    it("sends guild IDs when saving Discord bindings", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const addFn = extractFunction(source, "doAddBinding", "showEditBindingModal");
        const editFn = extractFunction(source, "doEditBinding", "saveAccountConfig");
        const payloads: any[] = [];
        const values: Record<string, string> = {
            "ab-agent": "alpha",
            "ab-acc": "default",
            "ab-guild-id": "guild-1",
            "ab-peer-id": "chan-1",
            "eb-agent": "alpha",
            "eb-acc": "default",
            "eb-ch": "discord",
            "eb-guild-id": "guild-2",
            "eb-peer-id": "chan-2",
        };
        const ctx: any = {
            D: { bindings: [] },
            V: (id: string) => values[id] || "",
            api: (_url: string, opts: any) => { payloads.push(JSON.parse(opts.body)); return Promise.resolve({}); },
            _deferParam: (path: string) => path,
            toast: () => undefined,
            _deferRestart: () => undefined,
            closeModal: () => undefined,
            _refreshEffectiveUi: () => undefined,
        };

        vm.runInNewContext(addFn, ctx);
        vm.runInNewContext(editFn, ctx);

        ctx.doAddBinding("discord");
        ctx.D.bindings = [{ agentId: "alpha", match: { channel: "discord", accountId: "default" } }];
        ctx.doEditBinding(0);

        expect(payloads[0].bindings[0].match.guildId).toBe("guild-1");
        expect(payloads[0].bindings[0].match.peer).toEqual({ kind: "channel", id: "chan-1" });
        expect(payloads[1].bindings[0].match.guildId).toBe("guild-2");
        expect(payloads[1].bindings[0].match.peer).toEqual({ kind: "channel", id: "chan-2" });
    });
});
