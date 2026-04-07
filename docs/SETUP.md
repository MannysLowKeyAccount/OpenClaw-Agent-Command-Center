# Setup & Configuration

## Installation

```bash
# Link for development
openclaw plugins install -l ./path/to/openclaw-agent-command-center

# Copy-install for production
openclaw plugins install ./path/to/openclaw-agent-command-center
```

## Configuration

Add the plugin to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["agent-dashboard"],
    "load": {
      "paths": ["/home/youruser/.openclaw/extensions/openclaw-agent-dashboard"]
    },
    "entries": {
      "agent-dashboard": {
        "enabled": true,
        "config": {
          "port": 19900,
          "title": "OpenClaw Command Center"
        }
      }
    }
  }
}
```

Restart the gateway, then open **http://localhost:19900**.

### Options

| Option           | Default                   | Description                                                                 |
|------------------|---------------------------|-----------------------------------------------------------------------------|
| `port`           | `19900`                   | HTTP port for the dashboard server                                          |
| `title`          | `OpenClaw Command Center` | Page title and PWA name                                                     |
| `allowedOrigins` | `[]`                      | Extra origins allowed to call the API (e.g. `["http://your-server:19900"]`) |
| `bind`           | `0.0.0.0`                 | Bind address (`127.0.0.1` to restrict to local only)                        |

## Security

On first load you'll be prompted to create a username and password. Credentials are
stored hashed with scrypt in `~/.openclaw/extensions/openclaw-agent-dashboard/.credentials`.

All subsequent visits and API calls require authentication via session cookie or
`Authorization: Bearer <token>`.

Cross-origin requests are blocked unless the origin is in `allowedOrigins`.

To reset credentials:

```bash
rm ~/.openclaw/extensions/openclaw-agent-dashboard/.credentials
```

## Deployment

### Prerequisites

- Python 3 with `paramiko` installed (`pip install paramiko`)
- SSH access to the target server
- OpenClaw gateway running on the target server

### Deploy script

The `scripts/deploy.py` script handles the full deploy cycle:

```bash
npm run build                        # compile TypeScript
python scripts/deploy.py             # build + sync + restart
python scripts/deploy.py --no-build  # skip build (already compiled)
python scripts/deploy.py --no-restart # sync files without restarting
```

### Deploy environment

Create a `.deploy.env` file in the project root (this file is gitignored):

```env
DEPLOY_HOST=your-server-ip
DEPLOY_USER=your-ssh-username
DEPLOY_PASS=your-ssh-password
DASHBOARD_URL=http://your-server-ip:19900/
```

### What gets deployed

| Local path | Remote path | Purpose |
|-----------|-------------|---------|
| `dist/` | `~/.openclaw/extensions/openclaw-agent-dashboard/dist/` | Compiled server code |
| `src/assets/` | `~/.openclaw/extensions/openclaw-agent-dashboard/src/assets/` | CSS, JS, icons |
| `openclaw.plugin.json` | `~/.openclaw/extensions/openclaw-agent-dashboard/openclaw.plugin.json` | Plugin manifest |
| `package.json` | `~/.openclaw/extensions/openclaw-agent-dashboard/package.json` | Package metadata |

Test files (`__tests__/`, `*.test.js`) are excluded from deployment.

### Port handling

The dashboard server registers `SIGTERM`/`SIGINT` handlers and calls
`closeAllConnections()` on shutdown to release the port immediately. The keep-alive
timeout is set to 3 seconds to prevent lingering connections during restarts.

If the port is still in use on startup, the server retries with exponential backoff
(1s, 2s, 4s) before giving up.

## Development

```bash
npm install
npm run build      # compile TypeScript to dist/
npm run dev        # watch mode
npm test           # run vitest
```

CSS and client JS (`src/assets/dashboard.css`, `src/assets/dashboard.js.txt`) are served
from `src/assets/` at runtime — changes don't require a rebuild, just a browser refresh.
Only `*.ts` changes need `tsc`.

## Project structure

```
src/
  server/              Server-side code
    index.ts           Plugin entry point, HTTP server, tool registration
    api.ts             API route dispatcher
    api-utils.ts       Config I/O, deferred staging, helpers
    auth.ts            Authentication (scrypt hashing, session tokens)
    dashboard.ts       Dashboard HTML builder
    resolve-asset.ts   Asset path resolver
    routes/            Route handlers (agents, config, sessions, skills, tasks, etc.)
  orchestrator/        Task Flow Orchestrator logic
    types.ts           Shared type definitions
    utils.ts           Validation, sorting, tool ID helpers
    codegen.ts         Code generation (.flow.ts files, AGENTS.md snippets)
  assets/              Static assets served at runtime
    dashboard.css      Dashboard stylesheet
    dashboard.js.txt   Client-side JavaScript
    login.css          Login page styles
    favicon.png        Favicon
    ios_icon.png       iOS home screen icon
    logo.png           Logo
scripts/               Deployment scripts (gitignored)
docs/                  Documentation
screenshots/           UI screenshots for docs
```
