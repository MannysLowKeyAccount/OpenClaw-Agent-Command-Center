import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    parseBody,
    readDashboardConfig,
    writeDashboardConfig,
} from "../api-utils.js";

// ─── Dashboard UI Routes — icon management and UI preferences ───

export async function handleDashboardUiRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method || "GET";

    // ─── GET /api/dashboard/icons — retrieve agent icons from extension config ───
    if (path === "/dashboard/icons" && method === "GET") {
        const dashCfg = readDashboardConfig();
        json(res, 200, { icons: dashCfg.icons || {} });
        return true;
    }

    // ─── PUT /api/dashboard/icons — update agent icon in extension config ───
    if (path === "/dashboard/icons" && method === "PUT") {
        const body = await parseBody(req);
        const dashCfg = readDashboardConfig();
        if (!dashCfg.icons) dashCfg.icons = {};
        if (body.agentId && body.icon) {
            dashCfg.icons[body.agentId] = body.icon;
        } else if (body.agentId && body.icon === null) {
            delete dashCfg.icons[body.agentId];
        }
        writeDashboardConfig(dashCfg);
        json(res, 200, { ok: true, icons: dashCfg.icons });
        return true;
    }

    return false;
}
