```
   ___                    ____ _
  / _ \ _ __   ___ _ __  / ___| | __ ___      __
 | | | | '_ \ / _ \ '_ \| |   | |/ _` \ \ /\ / /
 | |_| | |_) |  __/ | | | |___| | (_| |\ V  V /
  \___/| .__/ \___|_| |_|\____|_|\__,_| \_/\_/
       |_|        Agent Command Center v1.0
```

A dashboard plugin for [OpenClaw](https://github.com/openclaw) that gives you a single
place to manage your agents, chat sessions, channels, skills, tasks, and multi-agent
workflows — all from your browser.

![Dashboard overview](screenshots/desktop-main.png)

<table>
<tr>
<td><img src="screenshots/desktop-drawer.png" alt="Channels and agent bindings" /></td>
<td><img src="screenshots/desktop-tasks.png" alt="Task flows and scheduling" /></td>
</tr>
<tr>
<td colspan="2"><img src="screenshots/skills-installed.png" alt="Skills management" /></td>
</tr>
</table>

---

## What you can do

- See all your agents and how they connect in an interactive graph
- Create, edit, and delete agents and their configurations
- Chat with agents directly through the dashboard (with per-message timestamps)
- Monitor provider status and health across all your API keys
- Manage channels (Discord, Telegram, Slack, WhatsApp, Signal, and more)
- Install, create, and manage agent skills (per-agent or global)
- Schedule recurring tasks with calendar views
- Design and run multi-step agent pipelines with approval gates (Task Flow Orchestrator)
- Batch config changes without gateway restarts (deferred restart system)
- Edit your raw JSON config with built-in validation
- Tail logs in real time
- View subagent session logs (read-only)
- Works on mobile — add it to your home screen as a PWA

---

## Quick start

1. Install the plugin:

```bash
openclaw plugins install ./path/to/openclaw-agent-command-center
```

2. Add it to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["agent-dashboard"],
    "load": {
      "paths": ["/path/to/openclaw-agent-command-center"]
    },
    "entries": {
      "agent-dashboard": {
        "enabled": true,
        "config": {
          "port": 19900
        }
      }
    }
  }
}
```

3. Restart the gateway and open **http://localhost:19900**.

On first load you'll create a username and password. After that, every visit requires
login — your credentials are hashed and stored locally.

---

## Skills

Skills are reusable instruction sets that teach agents new capabilities. Each skill is
a `SKILL.md` file in a directory, and agents load them on demand via the `read` tool.

Skills can be scoped per-agent (workspace) or shared globally (managed). The dashboard
lets you create, edit, install, enable/disable, and delete skills from the UI.

See the full guide: [Skills Guide](docs/SKILLS.md)

---

## Task Flow Orchestrator

Chain multiple agents into repeatable pipelines. Define a flow once, and the system
handles step-by-step execution, state tracking, and human approval gates automatically.

```
User request → Coder agent → Code reviewer → Security audit → Deploy (requires approval)
```

Each step runs in sequence. If a step needs human sign-off, the flow pauses and waits
for you to approve or deny — either from the dashboard or through chat.

See the full guide: [Task Flow Orchestrator](docs/TASK_FLOW_ORCHESTRATOR.md)

---

## Deferred Restart

Config changes no longer trigger an immediate gateway restart. Instead, changes are
staged and a banner appears showing the pending change count. Click "Apply & Restart"
when you're ready to push all changes at once — or "Discard" to throw them away.

This applies to agent edits, channel changes, binding updates, skill toggles, model
config, API key changes, and raw config edits.

---

## Documentation

| Document | What's in it |
|----------|-------------|
| [Setup & Configuration](docs/SETUP.md) | Installation, deployment, config options, security |
| [Architecture](docs/ARCHITECTURE.md) | How the dashboard works under the hood, data flow, source layout |
| [API Reference](docs/API_REFERENCE.md) | Every REST endpoint the dashboard exposes |
| [Skills Guide](docs/SKILLS.md) | Creating, installing, and managing agent skills |
| [Task Flow Orchestrator](docs/TASK_FLOW_ORCHESTRATOR.md) | Multi-agent pipeline design, approval gates, agent setup |

---

## Deployment

The deploy script (`scripts/deploy.py`) handles building, uploading, and restarting:

```bash
npm run build
python scripts/deploy.py            # full deploy
python scripts/deploy.py --no-build # skip build step
```

The script reads connection details from `.deploy.env` (not committed to git).
Create your own from this template:

```env
DEPLOY_HOST=your-server-ip
DEPLOY_USER=your-username
DEPLOY_PASS=your-password
DASHBOARD_URL=http://your-server-ip:19900/
```

What gets deployed:
- `dist/` — compiled TypeScript
- `src/assets/` — CSS, JS, icons
- `openclaw.plugin.json` — plugin manifest
- `package.json` — package metadata and tool declarations

---

## Development

```bash
npm install
npm run build      # compile TypeScript
npm test           # run tests
```

CSS and client JS are hot-reloadable — just refresh the browser. Only TypeScript changes
need a rebuild.

---

## Disclaimer

This plugin is provided as-is with no warranty. It reads and writes files under
`~/.openclaw/` including your main configuration. Back up your OpenClaw configuration
before installing or deploying.
