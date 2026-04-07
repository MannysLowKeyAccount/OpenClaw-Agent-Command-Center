/**
 * API Dispatcher — thin router that delegates to domain-specific route modules.
 *
 * Each route handler receives (req, res, url, path) where `path` is the URL
 * pathname with the `/api` prefix stripped.  Handlers return `true` if they
 * handled the request, `false` to let the dispatcher try the next module.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { json } from "./api-utils.js";

// ─── Route modules ───
import { handleLogRoutes } from "./routes/logs.js";
import { handleHealthRoutes } from "./routes/health.js";
import { handleSessionRoutes } from "./routes/sessions.js";
import { handleAgentRoutes } from "./routes/agents.js";
import { handleConfigRoutes } from "./routes/config.js";
import { handleTaskRoutes } from "./routes/tasks.js";
import { handleProviderRoutes } from "./routes/providers.js";
import { handleToolRoutes } from "./routes/tools.js";
import { handleAuthProfileRoutes } from "./routes/auth-profiles.js";
import { handleDashboardUiRoutes } from "./routes/dashboard-ui.js";
import { handleSkillRoutes } from "./routes/skills.js";

// Ordered list of route handlers — first match wins.
const routeHandlers: Array<
    (req: IncomingMessage, res: ServerResponse, url: URL, path: string) => Promise<boolean>
> = [
        handleLogRoutes,
        handleHealthRoutes,
        handleSessionRoutes,
        handleSkillRoutes,
        handleAgentRoutes,
        handleConfigRoutes,
        handleTaskRoutes,
        handleProviderRoutes,
        handleToolRoutes,
        handleAuthProfileRoutes,
        handleDashboardUiRoutes,
    ];

/**
 * Main API entry point — called by `index.ts` for every `/api/*` request.
 *
 * Strips the `/api` prefix and delegates to each route module in order.
 * If no module handles the request a 404 JSON response is returned.
 */
export async function handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
): Promise<void> {
    const path = url.pathname.replace(/^\/api/, "");

    for (const handler of routeHandlers) {
        if (await handler(req, res, url, path)) return;
    }

    // No route matched — 404
    json(res, 404, { error: "Not found" });
}
