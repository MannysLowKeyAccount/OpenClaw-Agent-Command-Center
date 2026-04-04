```
   ___                    ____ _
  / _ \ _ __   ___ _ __  / ___| | __ ___      __
 | | | | '_ \ / _ \ '_ \| |   | |/ _` \ \ /\ / /
 | |_| | |_) |  __/ | | | |___| | (_| |\ V  V /
  \___/| .__/ \___|_| |_|\____|_|\__,_| \_/\_/
       |_|        Agent Command Center v1.0
```

A standalone dashboard plugin for [OpenClaw](https://github.com/openclaw) — full
visibility and control over your agents, sessions, provider keys, channels, tasks,
and configuration from a single browser tab.

![Main dashboard](docs/images/screenshot-main.png)

<table>
<tr>
<td><img src="docs/images/screenshot-agent-drawer.png" alt="Agent drawer" /></td>
<td><img src="docs/images/screenshot-models.png" alt="Models & API" /></td>
</tr>
<tr>
<td><img src="docs/images/screenshot-channels.png" alt="Channels" /></td>
<td><img src="docs/images/screenshot-tasks.png" alt="Tasks" /></td>
</tr>
</table>

<details>
<summary>Mobile view</summary>
<img src="docs/images/screenshot-mobile.png" alt="Mobile" width="300" />
</details>

---

## Features

- Interactive relationship graph — pan, zoom, pinch-to-zoom on mobile
- Agent management — create, edit, delete, configure models, tools, workspace files
- Session chat — spawn sessions, send messages through the gateway
- Models & API status — live probe of every provider (keys, OAuth, rate limits, billing)
- Channels — Discord, Telegram, Slack, WhatsApp, Signal, and more
- Recurring tasks and heartbeat schedules with calendar views
- Raw JSON config editor with validation
- Live log tailing via SSE
- Health checks with dismissable banners
- PWA support — add to home screen on iOS/Android
- Fully responsive

📐 [Architecture & how it works](docs/ARCHITECTURE.md) · 📡 [API Reference](docs/API_REFERENCE.md)

---

## Installation

```bash
openclaw plugins install -l ./path/to/openclaw-agent-command-center   # link for dev
openclaw plugins install ./path/to/openclaw-agent-command-center      # copy-install
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
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

| Option           | Default                   | Description                                                                 |
|------------------|---------------------------|-----------------------------------------------------------------------------|
| `port`           | `19900`                   | HTTP port for the dashboard server                                          |
| `title`          | `OpenClaw Command Center` | Page title and PWA name                                                     |
| `allowedOrigins` | `[]`                      | Extra origins allowed to call the API (e.g. `["http://your-server:19900"]`) |

Restart the gateway, then open **http://localhost:19900**.

---

## Security

On first load you'll be prompted to create a username and password (stored hashed with
scrypt in `~/.openclaw/extensions/openclaw-agent-dashboard/.credentials`). All subsequent
visits and API calls require authentication via session cookie or `Authorization: Bearer <token>`.

Cross-origin requests are blocked unless the origin is in `allowedOrigins`.

To reset credentials:

```bash
rm ~/.openclaw/extensions/openclaw-agent-dashboard/.credentials
```

---

## Development

```bash
npm install
npm run build      # compile TypeScript to dist/
npm run dev        # watch mode
npm test           # run vitest
```

CSS and client JS (`dashboard.css`, `dashboard.js.txt`) are served from `src/` at
runtime — changes don't require a rebuild, just a browser refresh. Only `*.ts` changes
need `tsc`.



---

## Disclaimer

This plugin is provided as-is with no warranty. It reads and writes files under
`~/.openclaw/` including your main configuration. Back up your OpenClaw configuration
before installing or deploying.
