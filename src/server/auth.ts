// Dashboard authentication — credentials file + session tokens
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const DASHBOARD_DIR = join(homedir(), ".openclaw", "extensions", "openclaw-agent-dashboard");
const CREDENTIALS_PATH = join(DASHBOARD_DIR, ".credentials");

const MAX_AUTH_BODY = 10_240; // 10KB

// ─── Rate limiter ───

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export const _loginAttempts = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of _loginAttempts) {
        if (entry.resetAt <= now) _loginAttempts.delete(ip);
    }
}, RATE_LIMIT_CLEANUP_INTERVAL_MS).unref();

function getClientIP(req: IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
        const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
        return first.trim();
    }
    return req.socket.remoteAddress ?? "unknown";
}

function isRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = _loginAttempts.get(ip);
    if (!entry || entry.resetAt <= now) return false;
    return entry.count >= RATE_LIMIT_MAX;
}

function recordFailedAttempt(ip: string): void {
    const now = Date.now();
    const entry = _loginAttempts.get(ip);
    if (!entry || entry.resetAt <= now) {
        _loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
        entry.count++;
    }
}

function resetAttempts(ip: string): void {
    _loginAttempts.delete(ip);
}

// Session store: persisted to disk so sessions survive gateway restarts
const SESSIONS_PATH = join(DASHBOARD_DIR, ".sessions");
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function _loadSessions(): Map<string, number> {
    try {
        if (existsSync(SESSIONS_PATH)) {
            const raw = JSON.parse(readFileSync(SESSIONS_PATH, "utf-8"));
            const now = Date.now();
            const map = new Map<string, number>();
            for (const [token, expiry] of Object.entries(raw)) {
                if (typeof expiry === "number" && expiry > now) map.set(token, expiry);
            }
            return map;
        }
    } catch { }
    return new Map();
}

function _saveSessions(): void {
    try {
        if (!existsSync(DASHBOARD_DIR)) mkdirSync(DASHBOARD_DIR, { recursive: true });
        const obj: Record<string, number> = {};
        sessions.forEach((expiry, token) => { obj[token] = expiry; });
        writeFileSync(SESSIONS_PATH, JSON.stringify(obj), "utf-8");
    } catch { }
}

const sessions = _loadSessions();

// ─── Credential helpers ───

function hashPassword(password: string): string {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const derived = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
}

interface Credentials {
    username: string;
    passwordHash: string;
}

function readCredentials(): Credentials | null {
    if (!existsSync(CREDENTIALS_PATH)) return null;
    try {
        const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
        if (raw.username && raw.passwordHash) return raw as Credentials;
        return null;
    } catch {
        return null;
    }
}

export function writeCredentials(username: string, password: string): void {
    if (!existsSync(DASHBOARD_DIR)) mkdirSync(DASHBOARD_DIR, { recursive: true });
    const creds: Credentials = { username, passwordHash: hashPassword(password) };
    writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), "utf-8");
}

// ─── Session helpers ───

function createSession(): string {
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    _saveSessions();
    return token;
}

function isValidSession(token: string): boolean {
    const expiry = sessions.get(token);
    if (!expiry) return false;
    if (Date.now() > expiry) {
        sessions.delete(token);
        _saveSessions();
        return false;
    }
    return true;
}

function destroySession(token: string): void {
    sessions.delete(token);
    _saveSessions();
}

function getTokenFromRequest(req: IncomingMessage): string | null {
    // Check Authorization header first (for curl / API clients)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        return authHeader.slice(7);
    }
    // Check cookie
    const cookies = req.headers.cookie ?? "";
    const match = cookies.match(/(?:^|;\s*)oc_session=([a-f0-9]+)/);
    return match ? match[1] : null;
}

// ─── Secure request detection ───

function isSecureRequest(req: IncomingMessage): boolean {
    return req.headers["x-forwarded-proto"] === "https";
}

// ─── Public API ───

export function isSetupRequired(): boolean {
    return readCredentials() === null;
}

export function isAuthenticated(req: IncomingMessage): boolean {
    const token = getTokenFromRequest(req);
    return token !== null && isValidSession(token);
}

// Handle POST /auth/setup — first-time credential creation
export function handleSetup(req: IncomingMessage, res: ServerResponse): void {
    if (!isSetupRequired()) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Credentials already configured" }));
        return;
    }
    let body = "";
    req.on("data", (c: any) => {
        if (body.length + c.length > MAX_AUTH_BODY) {
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Payload too large" }));
            req.destroy();
            return;
        }
        body += c;
    });
    req.on("end", () => {
        try {
            const { username, password } = JSON.parse(body);
            if (!username || !password || username.length < 1 || password.length < 8) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Username required, password must be at least 8 characters" }));
                return;
            }
            writeCredentials(username, password);
            const token = createSession();
            const secure = isSecureRequest(req) ? "; Secure" : "";
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Set-Cookie", `oc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
            res.end(JSON.stringify({ ok: true, token }));
        } catch {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Invalid request body" }));
        }
    });
}

// Handle POST /auth/login
export function handleLogin(req: IncomingMessage, res: ServerResponse): void {
    const creds = readCredentials();
    if (!creds) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "No credentials configured — use setup first" }));
        return;
    }

    const ip = getClientIP(req);
    if (isRateLimited(ip)) {
        res.statusCode = 429;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Too many failed login attempts. Try again later." }));
        return;
    }

    let body = "";
    req.on("data", (c: any) => {
        if (body.length + c.length > MAX_AUTH_BODY) {
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Payload too large" }));
            req.destroy();
            return;
        }
        body += c;
    });
    req.on("end", () => {
        try {
            const { username, password } = JSON.parse(body);
            if (username !== creds.username || !verifyPassword(password, creds.passwordHash)) {
                recordFailedAttempt(ip);
                res.statusCode = 401;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Invalid username or password" }));
                return;
            }
            resetAttempts(ip);
            const token = createSession();
            const secure = isSecureRequest(req) ? "; Secure" : "";
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Set-Cookie", `oc_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
            res.end(JSON.stringify({ ok: true, token }));
        } catch {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Invalid request body" }));
        }
    });
}

// Handle POST /auth/logout
export function handleLogout(req: IncomingMessage, res: ServerResponse): void {
    const token = getTokenFromRequest(req);
    if (token) destroySession(token);
    const secure = isSecureRequest(req) ? "; Secure" : "";
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Set-Cookie", `oc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
    res.end(JSON.stringify({ ok: true }));
}

// Serve the login/setup HTML page
export function serveLoginPage(res: ServerResponse, title: string, isSetup: boolean): void {
    const heading = isSetup ? "Create Dashboard Account" : "Sign In";
    const subtitle = isSetup
        ? "Set up a username and password to secure your dashboard."
        : "Enter your credentials to continue.";
    const endpoint = isSetup ? "/auth/setup" : "/auth/login";
    const buttonText = isSetup ? "Create Account" : "Sign In";
    const usernameVal = isSetup ? "" : "";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — ${heading}</title>
<link rel="stylesheet" href="/login.css">
</head>
<body>
<div class="card">
<h1>${heading}</h1>
<p class="sub">${subtitle}</p>
<div class="err" id="err"></div>
<form id="form">
<label for="username">Username</label>
<input id="username" name="username" type="text" autocomplete="username" required value="${usernameVal}" />
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="${isSetup ? "new-password" : "current-password"}" required minlength="${isSetup ? 8 : 1}" />
<button type="submit" id="btn">${buttonText}</button>
</form>
</div>
<script>
document.getElementById("form").addEventListener("submit",function(e){
  e.preventDefault();
  var btn=document.getElementById("btn");
  var err=document.getElementById("err");
  btn.disabled=true;err.style.display="none";
  fetch("${endpoint}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:document.getElementById("username").value,password:document.getElementById("password").value})})
  .then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})})
  .then(function(r){
    if(!r.ok){err.textContent=r.data.error||"Login failed";err.style.display="block";btn.disabled=false;return}
    window.location.href="/";
  })
  .catch(function(){err.textContent="Network error";err.style.display="block";btn.disabled=false});
});
</script>
</body>
</html>`;
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
}
