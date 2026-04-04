import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { buildDashboardHTML, getDashboardCSSContent } from "./dashboard.js";
import { handleApiRequest } from "./api.js";
import { resolveAsset } from "./resolve-asset.js";

// Pre-load icon PNGs
let IOS_ICON: Buffer;
let FAVICON: Buffer;
let LOGO: Buffer;
try { IOS_ICON = readFileSync(resolveAsset("ios_icon.png")); } catch { IOS_ICON = Buffer.alloc(0); }
try { FAVICON = readFileSync(resolveAsset("favicon.png")); } catch { FAVICON = Buffer.alloc(0); }
try { LOGO = readFileSync(resolveAsset("logo.png")); } catch { LOGO = Buffer.alloc(0); }

export default function register(api: any) {
    api.logger.info("[agent-dashboard] Loading Agent Dashboard plugin...");

    const config = api.config?.plugins?.entries?.["agent-dashboard"]?.config ?? {};
    const port = config.port ?? 19900;
    const title = config.title ?? "OpenClaw Command Center";

    // Respect gateway bind setting for the dashboard too
    const gwBind = api.config?.gateway?.bind ?? "loopback";
    const bindAddr = config.bind ?? (gwBind === "loopback" ? "0.0.0.0" : gwBind === "lan" ? "0.0.0.0" : "0.0.0.0");

    // Register as a background service — runs its own HTTP server
    api.registerService({
        id: "agent-dashboard",
        start: () => {
            try {
                const server = createServer(async (req, res) => {
                    // CORS headers for flexibility
                    res.setHeader("Access-Control-Allow-Origin", "*");
                    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
                    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

                    if (req.method === "OPTIONS") {
                        res.statusCode = 204;
                        res.end();
                        return;
                    }

                    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

                    // Serve dashboard HTML at root
                    if (url.pathname === "/" || url.pathname === "") {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "text/html; charset=utf-8");
                        res.end(buildDashboardHTML(title));
                        return;
                    }

                    // Serve dashboard CSS (read fresh from disk every time)
                    if (url.pathname === "/dashboard.css") {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "text/css; charset=utf-8");
                        res.setHeader("Cache-Control", "no-cache");
                        const cssPath = resolveAsset("dashboard.css");
                        try {
                            res.end(readFileSync(cssPath, "utf-8"));
                        } catch (e: any) {
                            res.end("/* CSS load error: " + e.message + " */");
                        }
                        return;
                    }

                    // PWA manifest for iOS/Android "Add to Home Screen"
                    if (url.pathname === "/manifest.json") {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "application/manifest+json");
                        res.end(JSON.stringify({
                            name: title,
                            short_name: "OpenClaw",
                            start_url: "/",
                            display: "standalone",
                            orientation: "portrait",
                            background_color: "#0b0b10",
                            theme_color: "#0b0b10",
                            icons: [
                                { src: "/ios-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
                                { src: "/ios-icon.png", sizes: "180x180", type: "image/png", purpose: "maskable" }
                            ]
                        }));
                        return;
                    }

                    // Serve icon PNGs
                    if (url.pathname === "/ios-icon.png" || url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png" || url.pathname === "/icon-180.png") {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "image/png");
                        res.setHeader("Cache-Control", "public, max-age=86400");
                        res.end(IOS_ICON);
                        return;
                    }

                    if (url.pathname === "/logo.png") {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "image/png");
                        res.setHeader("Cache-Control", "public, max-age=86400");
                        res.end(LOGO);
                        return;
                    }

                    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png") {
                        res.statusCode = 200;
                        res.setHeader("Content-Type", "image/png");
                        res.setHeader("Cache-Control", "public, max-age=86400");
                        res.end(FAVICON);
                        return;
                    }

                    // API routes under /api/*
                    if (url.pathname.startsWith("/api/")) {
                        try {
                            await handleApiRequest(req, res, url);
                        } catch (err: any) {
                            res.statusCode = 500;
                            res.setHeader("Content-Type", "application/json");
                            res.end(JSON.stringify({ error: err.message ?? "Internal server error" }));
                        }
                        return;
                    }

                    // 404
                    res.statusCode = 404;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ error: "Not found" }));
                });

                server.on("error", (err: any) => {
                    api.logger.error(`[agent-dashboard] Server error: ${err.message}`);
                });

                server.listen(port, bindAddr, () => {
                    api.logger.info(`[agent-dashboard] Dashboard running at http://${bindAddr}:${port}`);
                });

                // Store ref for cleanup
                (api as any)._dashboardServer = server;
            } catch (err: any) {
                api.logger.error(`[agent-dashboard] Failed to start: ${err.message}\n${err.stack}`);
            }
        },
        stop: () => {
            const server = (api as any)._dashboardServer;
            if (server) {
                server.close();
                api.logger.info("[agent-dashboard] Dashboard server stopped");
            }
        },
    });

    // Register RPC methods so gateway knows about us
    api.registerGatewayMethod("dashboard.status", ({ respond }: any) => {
        respond(true, { ok: true, plugin: "agent-dashboard", version: "1.0.0", port });
    });

    api.logger.info(`[agent-dashboard] Will start standalone server on port ${port}`);
}

