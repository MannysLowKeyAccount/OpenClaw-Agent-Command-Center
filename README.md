# OpenClaw Agent Command Center

OpenClaw’s browser dashboard for managing agents, chats, channels, skills, plugins, tasks, and config in one place.

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

## Setup and use with OpenClaw

1. Install the plugin into your OpenClaw setup:
   ```bash
   # Link for local development
   openclaw plugins install -l ./path/to/openclaw-agent-command-center

   # Copy-install for a regular OpenClaw install
   openclaw plugins install ./path/to/openclaw-agent-command-center
   ```
2. If your install requires manual registration, add the plugin to `~/.openclaw/openclaw.json`.
3. Restart the OpenClaw gateway.
4. Open `http://localhost:19900` and create your local username/password on first visit.

## What to do in the dashboard

- Start with the agent graph to see agents and relationships at a glance.
- Open an agent drawer to edit identity, tools, channels, files, relationships, and orchestrator settings.
- Manage channels, bindings, tasks, logs, and raw config from the browser.
- Use **Skills** to create, edit, enable, disable, or install per-agent and shared global skills.
- Use **Plugins** to view installed plugins and manage supported user-installed plugins.
- Batch config changes with the staged/deferred restart workflow.

## More docs

- [Skills Guide](docs/SKILLS.md)
- [Task Flow Orchestrator](docs/TASK_FLOW_ORCHESTRATOR.md)
- [API Reference](docs/API_REFERENCE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Setup & Configuration](docs/SETUP.md)
