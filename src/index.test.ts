import { describe, it, expect, vi } from "vitest";
import register from "./index.js";

describe("AgentDashboardPlugin", () => {
    it("registers a background service and gateway method", () => {
        const api = {
            logger: { info: vi.fn() },
            registerService: vi.fn(),
            registerGatewayMethod: vi.fn(),
            config: {},
        };

        register(api);

        expect(api.registerService).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "agent-dashboard",
                start: expect.any(Function),
                stop: expect.any(Function),
            })
        );

        expect(api.registerGatewayMethod).toHaveBeenCalledWith(
            "dashboard.status",
            expect.any(Function)
        );
    });

    it("reports custom port via RPC", () => {
        const api = {
            logger: { info: vi.fn() },
            registerService: vi.fn(),
            registerGatewayMethod: vi.fn(),
            config: {
                plugins: {
                    entries: {
                        "agent-dashboard": {
                            config: { port: 19000, title: "Custom" },
                        },
                    },
                },
            },
        };

        register(api);

        const respond = vi.fn();
        api.registerGatewayMethod.mock.calls[0][1]({ respond });
        expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ port: 19000 }));
    });
});
