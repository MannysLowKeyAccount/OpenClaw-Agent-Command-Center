# OpenClaw Agent Dashboard Plugin

A comprehensive dashboard plugin for OpenClaw that provides a single-pane-of-glass view for managing your AI agent ecosystem.

## Features

- **Agent Management** — Create, edit, delete agents. View and edit associated markdown files.
- **Session Management** — View active sessions, spawn new ones, terminate sessions, view conversations, send messages.
- **Relationship Mapping** — Visual drag-and-drop graph showing agent relationships and dependencies.
- **Configuration Management** — Edit channels, permissions, plugins, and raw `openclaw.json` with gateway restart.
- **Overview Dashboard** — At-a-glance stats for agents, sessions, channels, and relationships.

## Installation

```bash
# Link for development
openclaw plugins install -l ./path/to/openclaw-agent-dashboard

# Or copy-install
openclaw plugins install ./path/to/openclaw-agent-dashboard
```

## Configuration

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "agent-dashboard": {
        "enabled": true,
        "config": {
          "title": "OpenClaw Command Center"
        }
      }
    }
  }
}
```

Restart the gateway, then open: **http://127.0.0.1:18789/dashboard**

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
