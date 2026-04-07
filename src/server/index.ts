import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildDashboardHTML, getDashboardCSSContent, getDashboardJSContent, getLoginCSSContent } from "./dashboard.js";
import { handleApiRequest } from "./api.js";
import { resolveAsset } from "./resolve-asset.js";
import { initSessionIndex } from "./routes/sessions.js";
import { isSetupRequired, isAuthenticated, handleSetup, handleLogin, handleLogout, serveLoginPage } from "./auth.js";
import { parseFlowDefinitionFile } from "../orchestrator/codegen.js";
import { TASK_FLOW_TOOL_ID } from "../orchestrator/utils.js";

// Lazy-cached icon PNGs — read once on first access, never re-read during crash-restart loops
let _IOS_ICON: Buffer | null = null;
let _FAVICON: Buffer | null = null;
let _LOGO: Buffer | null = null;

function getIosIcon(): Buffer {
    if (_IOS_ICON === null) {
        try { _IOS_ICON = readFileSync(resolveAsset("ios_icon.png")); } catch { _IOS_ICON = Buffer.alloc(0); }
    }
    return _IOS_ICON;
}

function getFavicon(): Buffer {
    if (_FAVICON === null) {
        try { _FAVICON = readFileSync(resolveAsset("favicon.png")); } catch { _FAVICON = Buffer.alloc(0); }
    }
    return _FAVICON;
}

function getLogo(): Buffer {
    if (_LOGO === null) {
        try { _LOGO = readFileSync(resolveAsset("logo.png")); } catch { _LOGO = Buffer.alloc(0); }
    }
    return _LOGO;
}

export default function register(api: any) {
    api.logger.info("[agent-dashboard] Loading Agent Dashboard plugin...");

    const config = api.config?.plugins?.entries?.["agent-dashboard"]?.config ?? {};
    const port = config.port ?? 19900;
    const title = config.title ?? "OpenClaw Command Center";

    // Bind address — defaults to 0.0.0.0 so the dashboard is reachable remotely.
    // Override with config.bind if you want to restrict (e.g. "127.0.0.1").
    const bindAddr: string = config.bind ?? "0.0.0.0";

    // Allowed origins for CORS and API access control.
    // By default: localhost + the server's own addresses. Extra origins can be
    // added via config.allowedOrigins (array of strings).
    const extraOrigins: string[] = config.allowedOrigins ?? [];
    const allowedOriginSet = new Set([
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
        ...extraOrigins,
    ]);
    // If binding to a specific non-loopback address, allow that too
    if (bindAddr !== "127.0.0.1" && bindAddr !== "0.0.0.0") {
        allowedOriginSet.add(`http://${bindAddr}:${port}`);
    }

    function isOriginAllowed(origin: string | undefined): boolean {
        if (!origin) return true; // same-origin requests (no Origin header)
        if (allowedOriginSet.has(origin)) return true;
        // Auto-allow any origin that targets our own port (the dashboard calling its own API)
        try {
            const u = new URL(origin);
            if (String(u.port || 80) === String(port)) return true;
        } catch { }
        return false;
    }

    // EADDRINUSE retry state
    const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
    let _retryCount = 0;
    let _currentServer: ReturnType<typeof createServer> | null = null;

    function startServer() {
        // Guard: close existing server before creating a new one
        if (_currentServer) {
            try { _currentServer.close(); } catch { }
            _currentServer = null;
        }

        const server = createServer(async (req, res) => {
            const origin = req.headers.origin;

            // CORS — only allow configured origins
            if (origin && isOriginAllowed(origin)) {
                res.setHeader("Access-Control-Allow-Origin", origin);
                res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
                res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                res.setHeader("Vary", "Origin");
            }

            if (req.method === "OPTIONS") {
                if (!origin || !isOriginAllowed(origin)) {
                    res.statusCode = 403;
                    res.end();
                    return;
                }
                res.statusCode = 204;
                res.end();
                return;
            }

            const url = new URL(req.url ?? "/", `http://localhost:${port}`);

            // Block cross-origin API requests from disallowed origins
            if (url.pathname.startsWith("/api/") && origin && !isOriginAllowed(origin)) {
                res.statusCode = 403;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Origin not allowed" }));
                return;
            }

            // ── Auth routes (always accessible) ──
            if (url.pathname === "/auth/setup" && req.method === "POST") {
                handleSetup(req, res);
                return;
            }
            if (url.pathname === "/auth/login" && req.method === "POST") {
                handleLogin(req, res);
                return;
            }
            if (url.pathname === "/auth/logout" && req.method === "POST") {
                handleLogout(req, res);
                return;
            }

            // ── Auth gate — everything below requires authentication ──
            // Allow favicon/icons through without auth (browsers request these automatically)
            const isPublicAsset = url.pathname === "/favicon.ico" || url.pathname === "/favicon.png"
                || url.pathname === "/manifest.json" || url.pathname === "/ios-icon.png"
                || url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png"
                || url.pathname === "/login.css";

            if (!isPublicAsset) {
                const needsSetup = isSetupRequired();
                if (needsSetup) {
                    // No credentials file — show setup page for HTML requests, 401 for API
                    if (url.pathname.startsWith("/api/")) {
                        res.statusCode = 401;
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify({ error: "Setup required — open the dashboard in a browser to create credentials" }));
                        return;
                    }
                    serveLoginPage(res, title, true);
                    return;
                }
                if (!isAuthenticated(req)) {
                    // Not logged in — show login page for HTML requests, 401 for API
                    if (url.pathname.startsWith("/api/")) {
                        res.statusCode = 401;
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify({ error: "Authentication required — provide a Bearer token or log in via the dashboard" }));
                        return;
                    }
                    serveLoginPage(res, title, false);
                    return;
                }
            }

            // Serve dashboard HTML at root
            if (url.pathname === "/" || url.pathname === "") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(buildDashboardHTML(title));
                return;
            }

            // Serve dashboard CSS (cached, invalidated on file change)
            if (url.pathname === "/dashboard.css") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/css; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache");
                try {
                    res.end(getDashboardCSSContent());
                } catch (e: any) {
                    res.end("/* CSS load error: " + e.message + " */");
                }
                return;
            }

            // Serve login CSS (cached, invalidated on file change)
            if (url.pathname === "/login.css") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/css; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache");
                try {
                    res.end(getLoginCSSContent());
                } catch (e: any) {
                    res.end("/* CSS load error: " + e.message + " */");
                }
                return;
            }

            // Serve dashboard JS (cached, invalidated on file change)
            if (url.pathname === "/dashboard.js") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/javascript; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache");
                try {
                    res.end(getDashboardJSContent());
                } catch (e: any) {
                    res.end("// JS load error: " + e.message);
                }
                return;
            }

            // PWA manifest for iOS/Android "Add to Home Screen" (cached)
            if (url.pathname === "/manifest.json") {
                if (!(api as any)._manifestJson) {
                    (api as any)._manifestJson = JSON.stringify({
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
                    });
                }
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/manifest+json");
                res.setHeader("Cache-Control", "public, max-age=3600");
                res.end((api as any)._manifestJson);
                return;
            }

            // Serve icon PNGs
            if (url.pathname === "/ios-icon.png" || url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png" || url.pathname === "/icon-180.png") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "image/png");
                res.setHeader("Cache-Control", "public, max-age=86400");
                res.end(getIosIcon());
                return;
            }

            if (url.pathname === "/logo.png") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "image/png");
                res.setHeader("Cache-Control", "public, max-age=86400");
                res.end(getLogo());
                return;
            }

            if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "image/png");
                res.setHeader("Cache-Control", "public, max-age=86400");
                res.end(getFavicon());
                return;
            }

            // API routes under /api/*
            if (url.pathname.startsWith("/api/")) {
                try {
                    await handleApiRequest(req, res, url);
                } catch (err: any) {
                    if (err.message === "Payload too large") {
                        res.statusCode = 413;
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify({ error: "Payload too large" }));
                    } else {
                        res.statusCode = 500;
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify({ error: err.message ?? "Internal server error" }));
                    }
                }
                return;
            }

            // 404
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Not found" }));
        });

        server.on("error", (err: any) => {
            if (err.code === "EADDRINUSE") {
                if (_retryCount >= BACKOFF_DELAYS.length) {
                    api.logger.error(`[agent-dashboard] FATAL: Port ${port} still in use after ${BACKOFF_DELAYS.length} retries. Giving up.`);
                    return;
                }
                const delay = BACKOFF_DELAYS[_retryCount];
                api.logger.warn(`[agent-dashboard] Port ${port} in use. Retrying in ${delay}ms (attempt ${_retryCount + 1}/${BACKOFF_DELAYS.length})...`);
                _retryCount++;
                setTimeout(() => startServer(), delay);
            } else {
                api.logger.error(`[agent-dashboard] Server error: ${err.message}`);
            }
        });

        server.listen(port, bindAddr, () => {
            _retryCount = 0; // reset on successful bind
            api.logger.info(`[agent-dashboard] Dashboard running at http://${bindAddr}:${port}`);
        });

        _currentServer = server;
        // Store ref for cleanup
        (api as any)._dashboardServer = server;
    }

    // Register as a background service — runs its own HTTP server
    api.registerService({
        id: "agent-dashboard",
        start: async () => {
            await initSessionIndex();
            startServer();
        },
        stop: () => {
            const server = _currentServer ?? (api as any)._dashboardServer;
            if (server) {
                server.close();
                _currentServer = null;
                api.logger.info("[agent-dashboard] Dashboard server stopped");
            }
        },
    });

    // Register RPC methods so gateway knows about us
    api.registerGatewayMethod("dashboard.status", ({ respond }: any) => {
        respond(true, { ok: true, plugin: "agent-dashboard", version: "1.0.0", port });
    });

    // Register the single common task flow tool (optional — agents must opt in via alsoAllow)
    const PLUGIN_DIR = join(homedir(), ".openclaw", "extensions", "openclaw-agent-dashboard");
    const TASKS_DIR = join(PLUGIN_DIR, "Tasks", "flows", "definitions");
    const FLOW_STATE_DIR = join(PLUGIN_DIR, "Tasks", "flows", "state");
    const FLOW_HISTORY_DIR = join(PLUGIN_DIR, "Tasks", "flows", "history");

    // Ensure directories exist
    try { if (!existsSync(FLOW_STATE_DIR)) mkdirSync(FLOW_STATE_DIR, { recursive: true }); } catch { }
    try { if (!existsSync(FLOW_HISTORY_DIR)) mkdirSync(FLOW_HISTORY_DIR, { recursive: true }); } catch { }

    // Flow execution state persisted to disk
    interface FlowExecState {
        token: string;
        flowName: string;
        task: string;
        agentId: string;
        sessionKey?: string;
        nextStepIndex: number;
        completedStepIds: string[];
        status: "running" | "waiting_for_approval" | "completed" | "cancelled";
        waitingAtStepId?: string;
        createdAt: string;
    }

    // ── In-memory caches to avoid redundant disk I/O ──
    const _stateCache = new Map<string, FlowExecState>();
    const _flowDefCache = new Map<string, { def: any; mtime: number }>();

    function stateFilePath(token: string): string {
        return join(FLOW_STATE_DIR, `${token}.json`);
    }

    function saveFlowState(state: FlowExecState): void {
        _stateCache.set(state.token, state);
        writeFileSync(stateFilePath(state.token), JSON.stringify(state), "utf-8");
    }

    function loadFlowState(token: string): FlowExecState | null {
        const cached = _stateCache.get(token);
        if (cached) {
            // For waiting states, re-read from disk — the API can approve (change status)
            // or deny (delete file) externally
            if (cached.status === "waiting_for_approval") {
                const p = stateFilePath(token);
                try {
                    const fresh = JSON.parse(readFileSync(p, "utf-8"));
                    _stateCache.set(token, fresh);
                    return fresh;
                } catch {
                    _stateCache.delete(token);
                    return null;
                }
            }
            return cached;
        }
        try {
            const state = JSON.parse(readFileSync(stateFilePath(token), "utf-8"));
            _stateCache.set(token, state);
            return state;
        } catch { return null; }
    }

    function deleteFlowState(token: string): void {
        _stateCache.delete(token);
        try { unlinkSync(stateFilePath(token)); } catch { }
    }

    /** Save a completed or cancelled flow to the history directory for the Tasks view. */
    function saveToHistory(state: FlowExecState): void {
        try {
            const record = { ...state, completedAt: new Date().toISOString() };
            writeFileSync(join(FLOW_HISTORY_DIR, `${state.token}.json`), JSON.stringify(record), "utf-8");
        } catch { }
    }

    function loadFlowDef(flowName: string): any {
        const flowFilePath = join(TASKS_DIR, `${flowName}.flow.ts`);
        try {
            const mtime = statSync(flowFilePath).mtimeMs;
            const cached = _flowDefCache.get(flowName);
            if (cached && cached.mtime === mtime) return cached.def;
            const content = readFileSync(flowFilePath, "utf-8");
            const def = parseFlowDefinitionFile(content);
            _flowDefCache.set(flowName, { def, mtime });
            return def;
        } catch { return null; }
    }

    // Returns the next action for the agent based on current state
    function getNextAction(state: FlowExecState, flowDef: any): { content: { type: string; text: string }[]; details?: any } {
        const steps = flowDef.steps || [];

        // Check if we're done
        if (state.nextStepIndex >= steps.length) {
            state.status = "completed";
            saveToHistory(state);
            deleteFlowState(state.token);
            return {
                content: [{ type: "text", text: `✅ Flow "${state.flowName}" completed. All ${steps.length} steps finished.\n\nCompleted: ${state.completedStepIds.join(" → ")}\n\nSummarize the results to the user.` }],
                details: { status: "completed", flowName: state.flowName, completedSteps: state.completedStepIds, flowToken: state.token },
            };
        }

        const step = steps[state.nextStepIndex];

        // Check if this step needs approval
        // Skip the gate if we just resumed from it (waitingAtStepId matches and status is running)
        const alreadyApproved = step.humanIntervention && state.waitingAtStepId === step.id && state.status === "running";
        if (step.humanIntervention && !alreadyApproved) {
            // Pause at this approval gate
            state.status = "waiting_for_approval";
            state.waitingAtStepId = step.id;
            saveFlowState(state);

            return {
                content: [{
                    type: "text",
                    text: [
                        `⏸ Flow "${state.flowName}" is paused before step "${step.id}" (${step.description || step.id}).`,
                        `This step requires human approval before proceeding.`,
                        ``,
                        `Progress so far: ${state.completedStepIds.join(" → ") || "(none)"}`,
                        `Remaining: ${steps.slice(state.nextStepIndex).map((s: any) => s.id).join(" → ")}`,
                        ``,
                        `**Ask the user for approval.** When they approve, call \`${TASK_FLOW_TOOL_ID}\` with:`,
                        `  action: "resume"`,
                        `  flowToken: "${state.token}"`,
                        `  approve: true`,
                    ].join("\n"),
                }],
                details: {
                    status: "waiting_for_approval",
                    flowName: state.flowName,
                    waitingAtStep: step.id,
                    waitingAtStepDescription: step.description,
                    completedSteps: state.completedStepIds,
                    remainingSteps: steps.slice(state.nextStepIndex).map((s: any) => s.id),
                    flowToken: state.token,
                },
            };
        }

        // Return the next step for the agent to execute
        state.status = "running";
        saveFlowState(state);

        const stepNum = state.nextStepIndex + 1;
        const totalSteps = steps.length;

        return {
            content: [{
                type: "text",
                text: [
                    `**Step ${stepNum}/${totalSteps}: ${step.id}**`,
                    `Delegate to agent \`${step.agentId}\` using \`sessions_spawn\`.`,
                    step.description ? `Task: ${step.description}` : "",
                    `Context: ${state.task}`,
                    ``,
                    `After this step completes, call \`${TASK_FLOW_TOOL_ID}\` with:`,
                    `  action: "step_complete"`,
                    `  flowToken: "${state.token}"`,
                ].filter(Boolean).join("\n"),
            }],
            details: {
                status: "execute_step",
                flowName: state.flowName,
                stepIndex: state.nextStepIndex,
                step: { id: step.id, agentId: step.agentId, description: step.description },
                flowToken: state.token,
                progress: `${stepNum}/${totalSteps}`,
            },
        };
    }

    api.registerTool(
        {
            name: TASK_FLOW_TOOL_ID,
            description: [
                "Orchestrate a multi-step task flow. Actions:",
                "run: Start a new flow (requires flowName, task).",
                "step_complete: Report current step done, get next step (requires flowToken).",
                "resume: Continue after approval gate (requires flowToken, approve=true/false).",
                "The tool returns one step at a time. Execute it via sessions_spawn, then call step_complete to advance.",
            ].join(" "),
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["run", "step_complete", "resume"], description: "run | step_complete | resume" },
                    flowName: { type: "string", description: "Flow name (for action=run)" },
                    task: { type: "string", description: "Task description (for action=run)" },
                    flowToken: { type: "string", description: "Flow token (for step_complete and resume)" },
                    approve: { type: "boolean", description: "Approve or deny (for action=resume)" },
                    sessionKey: { type: "string", description: "Your current session key (optional, enables dashboard approval routing)" },
                },
                required: ["action"],
                additionalProperties: false,
            },
            async execute(_id: string, params: any) {
                const action = params.action || "run";

                // ── RUN: start a new flow ──
                if (action === "run") {
                    const flowName = params.flowName;
                    const task = params.task;
                    if (!flowName || !task) {
                        return { content: [{ type: "text", text: "flowName and task are required for action=run" }] };
                    }

                    const flowDef = loadFlowDef(flowName);
                    if (!flowDef) {
                        let available: string[] = [];
                        try {
                            if (existsSync(TASKS_DIR)) {
                                available = readdirSync(TASKS_DIR)
                                    .filter((f: string) => f.endsWith(".flow.ts"))
                                    .map((f: string) => f.replace(".flow.ts", ""));
                            }
                        } catch { }
                        return { content: [{ type: "text", text: `Flow "${flowName}" not found.${available.length ? " Available: " + available.join(", ") : ""}` }] };
                    }

                    const token = randomUUID();
                    const state: FlowExecState = {
                        token,
                        flowName,
                        task,
                        agentId: flowDef.agentId,
                        sessionKey: params.sessionKey || undefined,
                        nextStepIndex: 0,
                        completedStepIds: [],
                        status: "running",
                        createdAt: new Date().toISOString(),
                    };
                    saveFlowState(state);

                    return getNextAction(state, flowDef);
                }

                // ── STEP_COMPLETE: advance to next step ──
                if (action === "step_complete") {
                    const token = params.flowToken;
                    if (!token) return { content: [{ type: "text", text: "flowToken required for step_complete" }] };

                    const state = loadFlowState(token);
                    if (!state) return { content: [{ type: "text", text: `Flow token not found: ${token}. The flow may have been cancelled from the dashboard.` }] };

                    // Guard: flow was cancelled from the dashboard
                    if (state.status === "cancelled") {
                        deleteFlowState(token);
                        return { content: [{ type: "text", text: `❌ Flow "${state.flowName}" was cancelled from the dashboard. Do not continue this flow. Inform the user it was cancelled.` }] };
                    }

                    // Guard: don't advance if flow is waiting for approval
                    if (state.status === "waiting_for_approval") {
                        return { content: [{ type: "text", text: `Flow "${state.flowName}" is paused at step "${state.waitingAtStepId}" waiting for approval. Use action="resume" with approve=true to continue.` }] };
                    }

                    const flowDef = loadFlowDef(state.flowName);
                    if (!flowDef) return { content: [{ type: "text", text: `Flow "${state.flowName}" no longer exists` }] };

                    const steps = flowDef.steps || [];
                    if (state.nextStepIndex < steps.length) {
                        state.completedStepIds.push(steps[state.nextStepIndex].id);
                        state.nextStepIndex++;
                        state.waitingAtStepId = undefined; // clear gate flag for next step
                    }

                    return getNextAction(state, flowDef);
                }

                // ── RESUME: continue after approval ──
                if (action === "resume") {
                    const token = params.flowToken;
                    if (!token) return { content: [{ type: "text", text: "flowToken required for resume" }] };

                    const state = loadFlowState(token);
                    if (!state) return { content: [{ type: "text", text: `Flow token not found: ${token}. The flow may have been cancelled from the dashboard.` }] };

                    // Guard: flow was cancelled from the dashboard
                    if (state.status === "cancelled") {
                        deleteFlowState(token);
                        return { content: [{ type: "text", text: `❌ Flow "${state.flowName}" was cancelled from the dashboard. Do not continue this flow. Inform the user it was cancelled.` }] };
                    }

                    if (params.approve === false) {
                        state.status = "cancelled";
                        saveToHistory(state);
                        deleteFlowState(token);
                        return {
                            content: [{ type: "text", text: `❌ Flow "${state.flowName}" cancelled at step "${state.waitingAtStepId}".` }],
                            details: { status: "cancelled", flowName: state.flowName },
                        };
                    }

                    // Guard: only resume flows that are waiting or already approved by the dashboard
                    if (state.status !== "waiting_for_approval" && !(state.status === "running" && state.waitingAtStepId)) {
                        return { content: [{ type: "text", text: `Flow "${state.flowName}" is not waiting for approval (status: ${state.status}). Use action="step_complete" to advance running flows.` }] };
                    }

                    // Approved — mark as running, keep waitingAtStepId so getNextAction knows gate was approved
                    state.status = "running";
                    saveFlowState(state);

                    const flowDef = loadFlowDef(state.flowName);
                    if (!flowDef) return { content: [{ type: "text", text: `Flow "${state.flowName}" no longer exists` }] };

                    return getNextAction(state, flowDef);
                }

                return { content: [{ type: "text", text: `Unknown action: ${action}. Use run, step_complete, or resume.` }] };
            },
        },
        { optional: true },
    );

    api.logger.info(`[agent-dashboard] Will start standalone server on port ${port}`);
}

