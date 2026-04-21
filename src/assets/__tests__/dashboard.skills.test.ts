import { describe, it, expect, vi } from "vitest";
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

describe("global skills state labels", () => {
    it("distinguishes global, partial, and disabled states", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const stateFn = extractFunction(source, "_getGlobalSkillState", "_renderGlobalSkillCard");
        const renderFn = extractFunction(source, "_renderGlobalSkillCard", "showPluginsPage");

        const ctx: any = {
            esc: (value: unknown) => String(value ?? ""),
        };

        const helpers = source.slice(source.indexOf("var _skillToggleLocks="), source.indexOf("// Mobile nav"));
        vm.runInNewContext(helpers, ctx);

        vm.runInNewContext(stateFn, ctx);
        vm.runInNewContext(renderFn, ctx);

        expect(ctx._getGlobalSkillState({ enabled: true })).toEqual({ state: "global", label: "Enabled globally" });
        expect(ctx._getGlobalSkillState({ enabled: false, agentEnabledCount: 2 })).toEqual({ state: "partial", label: "Enabled for some agents" });
        expect(ctx._getGlobalSkillState({ enabled: false, agentEnabledCount: 0 })).toEqual({ state: "disabled", label: "Disabled for all agents" });

        const partialHtml = ctx._renderGlobalSkillCard({
            dirName: "shared-skill",
            name: "Shared Skill",
            tier: "managed",
            enabled: false,
            agentEnabledCount: 1,
            hasValidSkillMd: true,
            description: "Shared",
        });

        expect(partialHtml).toContain("Enabled for some agents");
        expect(partialHtml).toContain("skill-partial");
    });
});

describe("drawer skill cards", () => {
    it("marks pending skill changes and keeps managed toggles scoped globally", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const cardFn = extractFunction(source, "_renderSkillCard", "openSkillEditor");

        const ctx: any = {
            esc: (value: unknown) => String(value ?? ""),
        };

        const helpers = source.slice(source.indexOf("var _skillToggleLocks="), source.indexOf("// Mobile nav"));
        vm.runInNewContext(helpers, ctx);

        vm.runInNewContext(cardFn, ctx);

        const html = ctx._renderSkillCard({
            dirName: "shared-skill",
            name: "Shared Skill",
            tier: "managed",
            enabled: true,
            pending: true,
            pendingAction: "update",
            hasValidSkillMd: true,
            description: "Shared",
        }, { id: "alpha" });

        expect(html).toContain("skill-pending");
        expect(html).toContain("Pending apply");
        expect(html).toContain("disabled");
        expect(html).toContain("toggleSkill('alpha','shared-skill',this.checked,'managed')");
    });
});

describe("skill toggle locking", () => {
    it("blocks rapid repeat toggles while a request is pending", () => {
        const source = readFileSync(DASHBOARD_JS_PATH, "utf-8");
        const start = source.indexOf("var _skillToggleLocks=");
        if (start < 0) throw new Error("Unable to locate skill toggle helpers");

        const ctx: any = {
            api: vi.fn(() => new Promise(() => {})),
            toast: vi.fn(),
            _skillsCache: { alpha: [{ dirName: "shared-skill", tier: "managed", enabled: true }] },
            _globalSkillsCache: [{ dirName: "shared-skill", tier: "managed", enabled: true }],
            drawerAgent: null,
            drawerTab: "",
            renderGlobalSkillsPage: vi.fn(),
            _refreshGlobalSkillsPage: vi.fn(),
            _deferRestart: vi.fn(),
            Q: vi.fn(() => null),
        };

        const toggleFn = extractFunction(source, "toggleSkill", "openInstallSkillForm");
        vm.runInNewContext(source.slice(start, source.indexOf("// Mobile nav")), ctx);
        vm.runInNewContext(toggleFn, ctx);

        ctx.toggleSkill("alpha", "shared-skill", false, "managed");
        ctx.toggleSkill("alpha", "shared-skill", true, "managed");

        expect(ctx.api).toHaveBeenCalledTimes(1);
        expect(ctx._skillToggleLocks["managed::alpha::shared-skill"]).toBe(true);
    });
});
