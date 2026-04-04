// OpenClaw Agent Dashboard — HTML builder
// JS is in a separate file (dashboard.js.txt) read at module load time

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolveAsset } from "./resolve-asset.js";

const DASHBOARD_JS = readFileSync(resolveAsset("dashboard.js.txt"), "utf-8");

// CSS is read fresh on first request (not at module load time, to survive hot-reloads)
let _cssCache: string | null = null;
let _cssMtime: number = 0;
function getDashboardCSS(): string {
  const cssPath = resolveAsset("dashboard.css");
  try {
    const stat = existsSync(cssPath) ? statSync(cssPath).mtimeMs : 0;
    if (!_cssCache || stat !== _cssMtime) {
      _cssCache = readFileSync(cssPath, "utf-8");
      _cssMtime = stat;
    }
  } catch {
    if (!_cssCache) _cssCache = "";
  }
  return _cssCache;
}

// Favicon is small enough to inline; logo + iOS icon served as separate URLs
const FAVICON_B64 = readFileSync(resolveAsset("favicon.png")).toString("base64");

function logoImgTag(size: number): string {
  return '<img src="/logo.png" width="' + size + '" height="' + size + '" alt="OpenClaw" class="logo-img" loading="eager">';
}

export function buildDashboardHTML(title: string): string {
  const t = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
    + '<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover, user-scalable=no">\n'
    // PWA / iOS Home Screen support
    + '<meta name="screen-orientation" content="portrait">\n'
    + '<meta name="apple-mobile-web-app-capable" content="yes">\n'
    + '<meta name="apple-mobile-web-app-status-bar-style" content="black">\n'
    + '<meta name="apple-mobile-web-app-title" content="' + t + '">\n'
    + '<meta name="mobile-web-app-capable" content="yes">\n'
    + '<meta name="theme-color" content="#0b0b10">\n'
    + '<link rel="manifest" href="/manifest.json">\n'
    + '<link rel="apple-touch-icon" sizes="180x180" href="/ios-icon.png">\n'
    + '<title>' + t + '</title>\n'
    + '<link rel="icon" type="image/png" href="data:image/png;base64,' + FAVICON_B64 + '">\n'
    + '<link rel="stylesheet" href="/dashboard.css">\n</head>\n<body>\n'
    // Topbar — lean: logo + primary actions only
    + '<header id="topbar">'
    + '<div class="topbar-left clickable" onclick="closePagePanel();closeDrawer();" title="Back to main view"><span class="logo">' + logoImgTag(40) + '</span><h1>' + t + '</h1></div>\n'
    + '<div class="topbar-right">'
    + '<button class="btn btn-accent btn-sm" onclick="showCreateAgent()">+ Agent</button>\n'
    + '<button class="btn btn-sm" onclick="showModelsAndApi()">Models & API</button>\n'
    + '<button class="btn btn-sm" onclick="showChannelsPage()">Channels</button>\n'
    + '<button class="btn btn-sm" onclick="showTasksPage()">Tasks</button>\n'
    + '<button class="btn btn-sm" onclick="showLogs()">Logs</button>\n'
    + '<div class="topbar-sep"></div>'
    + '<button class="btn btn-sm" onclick="showRawConfig()" title="Edit config">\u2699</button>\n'
    + '<button class="btn btn-warn btn-sm" onclick="restartGateway()" title="Restart gateway">\u21bb</button>'
    + '</div>'
    + '<button class="hamburger-btn" onclick="openMobileNav()" aria-label="Open menu">☰</button>'
    + '</header>\n'
    + '<div id="progress-bar" class="progress-bar"></div>\n'
    // Main content — graph + agent list
    + '<div id="main-content" class="main-content">'
    + '<div id="map-canvas" class="map-canvas"><div class="empty map-empty-center"><span class="spin"></span></div>'
    + '<div id="zoom-controls" class="zoom-controls">'
    + '<button class="zoom-btn" onclick="zoomMap(0.2)">+</button>'
    + '<span id="zoom-label" class="zoom-label">100%</span>'
    + '<button class="zoom-btn" onclick="zoomMap(-0.2)">−</button>'
    + '<button class="zoom-btn" onclick="resetMapView()" title="Reset view">⌖</button>'
    + '</div>'
    + '</div>\n'
    + '<aside id="agent-list" class="agent-list"><div class="agent-list-head"><span>Agents</span><button class="graph-toggle" id="graph-toggle" onclick="toggleGraph()">Hide Graph</button></div><div id="agent-list-body" class="agent-list-body"></div></aside>'
    + '</div>\n'
    // Footer — gateway status
    + '<footer id="statusbar">'
    + '<span id="gw-status" class="gw-badge">\u23f3 Loading...</span>'
    + '<div id="gw-details" class="status-detail"></div>'
    + '</footer>\n'
    // Agent drawer (slide-over panel on top of graph)
    + '<div id="agent-drawer" class="agent-drawer">'
    + '<div class="drawer-main" id="drawer-main"></div>'
    + '</div>\n'
    + '<div id="drawer-backdrop" class="drawer-backdrop" onclick="closeDrawer()"></div>\n'
    // Page panel (full-screen slide-out for Tasks, API Status, Models, Config, Create Agent)
    + '<div id="page-panel" class="page-panel">'
    + '<div class="page-panel-head"><h2 id="page-panel-title"></h2><button class="close-btn" onclick="closePagePanel()">\u00d7</button></div>'
    + '<div id="page-panel-body" class="page-panel-body"></div>'
    + '</div>\n'
    + '<div id="page-panel-backdrop" class="page-panel-backdrop" onclick="closePagePanel()"></div>\n'
    // Modal (small confirmations only)
    + '<div id="modal-bg" class="modal-bg" onclick="closeModal()">\n'
    + '<div class="modal" onclick="event.stopPropagation()">\n'
    + '<div class="modal-head"><h2 id="modal-title"></h2><button class="close-btn" onclick="closeModal()">\u00d7</button></div>\n'
    + '<div id="modal-body" class="modal-body"></div></div></div>\n'
    + '<div id="toasts"></div>\n'
    + '<div id="tip-float"></div>\n'
    // Mobile navigation drawer
    + '<div id="mobile-nav-backdrop" class="mobile-nav-backdrop" onclick="closeMobileNav()"></div>\n'
    + '<nav id="mobile-nav" class="mobile-nav" aria-label="Mobile navigation">'
    + '<div class="mobile-nav-head"><span>Menu</span><button class="close-btn" onclick="closeMobileNav()">\u00d7</button></div>'
    + '<div class="mobile-nav-items">'
    + '<button class="mobile-nav-item accent" onclick="closeMobileNav();showCreateAgent()"><span class="nav-icon">+</span>New Agent</button>'
    + '<button class="mobile-nav-item" onclick="closeMobileNav();showModelsAndApi()"><span class="nav-icon">🧠</span>Models & API</button>'
    + '<button class="mobile-nav-item" onclick="closeMobileNav();showChannelsPage()"><span class="nav-icon">📡</span>Channels</button>'
    + '<button class="mobile-nav-item" onclick="closeMobileNav();showTasksPage()"><span class="nav-icon">📋</span>Tasks</button>'
    + '<button class="mobile-nav-item" onclick="closeMobileNav();showLogs()"><span class="nav-icon">📜</span>Logs</button>'
    + '<div class="mobile-nav-divider"></div>'
    + '<button class="mobile-nav-item" onclick="closeMobileNav();showRawConfig()"><span class="nav-icon">\u2699</span>Edit Config</button>'
    + '<button class="mobile-nav-item warn" onclick="closeMobileNav();restartGateway()"><span class="nav-icon">\u21bb</span>Restart Gateway</button>'
    + '</div></nav>\n'
    + '<script>\n' + DASHBOARD_JS + '\n</' + 'script>\n'
    + '</body>\n</html>';
}

// CSS is exported so index.ts can serve it at /dashboard.css
export function getDashboardCSSContent(): string { return getDashboardCSS(); }