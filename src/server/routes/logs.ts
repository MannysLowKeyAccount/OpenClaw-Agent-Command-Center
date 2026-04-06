import { readFileSync, existsSync, readdirSync, statSync, watchFile, unwatchFile, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    json,
    readConfig,
    execAsync,
    OPENCLAW_DIR,
} from "../api-utils.js";

// ─── Log file discovery ───
function _findLogFile(): string | null {
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const candidates = [
        `/tmp/openclaw/openclaw-${dateStr}.log`,
        `/tmp/openclaw/openclaw.log`,
        join(OPENCLAW_DIR, "logs", `openclaw-${dateStr}.log`),
        join(OPENCLAW_DIR, "logs", "openclaw.log"),
        join(OPENCLAW_DIR, "openclaw.log"),
    ];
    for (const f of candidates) {
        if (existsSync(f)) return f;
    }
    const tmpDir = "/tmp/openclaw";
    if (existsSync(tmpDir)) {
        try {
            const files = readdirSync(tmpDir).filter(f => f.endsWith(".log")).sort().reverse();
            if (files.length > 0) return join(tmpDir, files[0]);
        } catch { }
    }
    return null;
}

// ─── Journald log reader (fallback when no log file exists) ───
async function _readJournaldLogs(lines: number, unit?: string): Promise<{ lines: string[]; source: string } | null> {
    const unitName = unit || "openclaw-gateway.service";
    try {
        const out = await execAsync(`journalctl --user -u ${unitName} --no-pager -n ${lines} --output=short-iso 2>/dev/null || journalctl -u ${unitName} --no-pager -n ${lines} --output=short-iso 2>/dev/null`, { timeout: 8000 });
        const result = (out || "").trim();
        if (!result || result.includes("No journal files")) return null;
        return { lines: result.split("\n").filter(Boolean), source: `journald (${unitName})` };
    } catch {
        return null;
    }
}

// ─── Route handler ───
export async function handleLogRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
): Promise<boolean> {
    const method = req.method ?? "GET";

    // ─── GET /api/logs — tail the openclaw log file (or journald) ───
    if (path === "/logs" && method === "GET") {
        const lines = parseInt(url.searchParams?.get("lines") || "200", 10);
        const config = readConfig();
        const logFile = config.logging?.file || _findLogFile();

        // Try file-based logs first
        if (logFile && existsSync(logFile)) {
            try {
                const content = readFileSync(logFile, "utf-8");
                const allLines = content.split("\n");
                const tail = allLines.slice(-lines).filter(Boolean);
                json(res, 200, { lines: tail, logFile, totalLines: allLines.length });
                return true;
            } catch (e: any) {
                json(res, 200, { lines: [], logFile, error: e.message });
                return true;
            }
        }

        // Fallback: try journald
        const journald = await _readJournaldLogs(lines);
        if (journald) {
            json(res, 200, { lines: journald.lines, logFile: journald.source, totalLines: journald.lines.length });
            return true;
        }

        json(res, 200, { lines: [], logFile: logFile || "not found", error: "No log file found and journald not available. If OpenClaw runs as a systemd service, check: journalctl --user -u openclaw-gateway.service -f" });
        return true;
    }

    // ─── GET /api/logs/stream — SSE stream for live log tailing ───
    if (path === "/logs/stream" && method === "GET") {
        const config = readConfig();
        const logFile = config.logging?.file || _findLogFile();

        // If we have a log file, use file-based streaming
        if (logFile && existsSync(logFile)) {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            });
            res.write("data: " + JSON.stringify({ type: "connected", logFile }) + "\n\n");

            let lastSize = 0;
            try { lastSize = statSync(logFile).size; } catch { }

            const onFileChange = () => {
                try {
                    const st = statSync(logFile);
                    if (st.size <= lastSize) { lastSize = st.size; return; }
                    const fd = openSync(logFile, "r");
                    const buf = Buffer.alloc(st.size - lastSize);
                    readSync(fd, buf, 0, buf.length, lastSize);
                    closeSync(fd);
                    lastSize = st.size;
                    const newLines = buf.toString("utf-8").split("\n").filter(Boolean);
                    for (const line of newLines) {
                        res.write("data: " + JSON.stringify({ type: "line", text: line }) + "\n\n");
                    }
                } catch { }
            };

            watchFile(logFile, { interval: 1000 }, onFileChange);
            req.on("close", () => { unwatchFile(logFile, onFileChange); });
            return true;
        }

        // Fallback: stream from journald using `journalctl -f`
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });
        res.write("data: " + JSON.stringify({ type: "connected", logFile: "journald (openclaw-gateway.service)" }) + "\n\n");

        const journalProc = exec(
            "journalctl --user -u openclaw-gateway.service -f --no-pager --output=short-iso 2>/dev/null || journalctl -u openclaw-gateway.service -f --no-pager --output=short-iso 2>/dev/null",
            { encoding: "utf-8" }
        );
        let journalBuf = "";
        journalProc.stdout?.on("data", (chunk: string) => {
            journalBuf += chunk;
            const lines = journalBuf.split("\n");
            journalBuf = lines.pop() || "";
            for (const line of lines) {
                if (line.trim()) {
                    res.write("data: " + JSON.stringify({ type: "line", text: line }) + "\n\n");
                }
            }
        });
        journalProc.on("error", () => {
            res.write("data: " + JSON.stringify({ type: "line", text: "[dashboard] journalctl not available" }) + "\n\n");
        });
        req.on("close", () => {
            journalProc.kill();
        });
        return true;
    }

    return false;
}
