```
   ___                    ____ _
  / _ \ _ __   ___ _ __  / ___| | __ ___      __
 | | | | '_ \ / _ \ '_ \| |   | |/ _` \ \ /\ / /
 | |_| | |_) |  __/ | | | |___| | (_| |\ V  V /
  \___/| .__/ \___|_| |_|\____|_|\__,_| \_/\_/
       |_|        Agent Command Center
```

OpenClaw’s browser dashboard for managing agents, chats, channels, **Global Skills**, **Plugins**, tasks, and config from one place.

![Dashboard overview](screenshots/dashboard-overview.png)

<table>
<tr>
<td><img src="screenshots/agent-drawer.png" alt="Agent drawer" /></td>
<td><img src="screenshots/global-skills.png" alt="Global Skills page" /></td>
</tr>
<tr>
<td><img src="screenshots/plugins.png" alt="Plugins page" /></td>
<td></td>
</tr>
</table>

## Highlights

- Interactive agent graph with a right-side agent drawer
- Manage agents, channels, tasks, logs, and raw config
- Install and manage shared **Global Skills** and per-agent skills
- View and manage **Plugins** from the UI
- Staged/deferred restart workflow for grouped config changes
- Responsive, mobile-friendly UI / PWA-style experience

## Install

```bash
openclaw plugins install ./path/to/openclaw-agent-command-center
```

Add it to `~/.openclaw/openclaw.json`, then restart the gateway and open `http://localhost:19900`.

On first load you create a local username and password. After that, the dashboard requires login on every visit.

## What You Can Do

- See all agents and relationships in an interactive graph
- Open the agent drawer to edit identity, tools, channels, files, relationships, and orchestrator settings
- Manage channels, bindings, tasks, logs, and raw config from the browser
- Install and manage per-agent skills and shared **Global Skills**
- View, install, and remove supported **Plugins** from the UI
- Batch config edits with the staged/deferred restart workflow
- Use the dashboard comfortably on desktop and narrower/mobile viewports

## Skills And Plugins

Skills can be installed per agent or shared globally. The dashboard supports creating, editing, enabling, disabling, and installing skills directly from the UI, including managed global skills.

Plugins have a dedicated management page for listing installed plugins, installing new ones, and removing supported user-managed plugins.

See the full guides:

- [Skills Guide](docs/SKILLS.md)
- [Task Flow Orchestrator](docs/TASK_FLOW_ORCHESTRATOR.md)
- [API Reference](docs/API_REFERENCE.md)
- [Architecture](docs/ARCHITECTURE.md)

## Deploy

Build first, then use the deploy script:

```bash
npm run build
python scripts/deploy.py
```

The script reads local connection details from `.deploy.env`.

For setup details, config options, and deployment notes, see [Setup & Configuration](docs/SETUP.md).

## Development

```bash
npm install
npm run build
npm test
```

CSS and dashboard JS are refreshable in the browser. TypeScript/server changes need a rebuild.
