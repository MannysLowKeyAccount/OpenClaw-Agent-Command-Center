# API Reference

These are the dashboard's own REST endpoints served on the dashboard HTTP server
(default port 19900). They are not part of the core OpenClaw gateway API.

The dashboard UI consumes these internally — they're also usable directly for scripting
or integration.

## Deferred writes

Most mutation endpoints accept a `?defer=1` query parameter. When set, the change is
staged in memory instead of written to disk. This prevents a gateway restart after each
change. Use `POST /api/config/commit` to write all staged changes at once.

## Overview

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/overview`                   | Full dashboard payload (agents, config, sessions, gateway status) |
| `GET`    | `/api/overview?fast=1`            | Lightweight version (no session scan, no gateway probe) |

## Agents

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/agents/:id`                 | Single agent with enriched metadata            |
| `PUT`    | `/api/agents/:id`                 | Update agent config (`?defer=1` supported)     |
| `POST`   | `/api/agents`                     | Create a new agent (`?defer=1` supported)      |
| `DELETE` | `/api/agents/:id`                 | Delete an agent and its bindings (`?defer=1`)  |
| `GET`    | `/api/agents/:id/md/:file`        | Read a workspace markdown file                 |
| `PUT`    | `/api/agents/:id/md/:file`        | Write a workspace markdown file                |
| `DELETE` | `/api/agents/:id/md/:file`        | Delete a workspace markdown file               |
| `POST`   | `/api/agents/:id/md/:file/generate` | Generate markdown from notes via model       |
| `POST`   | `/api/agents/:id/generate-all`    | Generate all workspace MD files from description |

## Sessions

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/sessions`                   | List all sessions                              |
| `GET`    | `/api/sessions/agent/:agentId`    | List sessions for an agent (includes subagents)|
| `GET`    | `/api/sessions/:key`              | Get session with full message history          |
| `POST`   | `/api/sessions/:key/message`      | Send a message to an agent via gateway         |
| `POST`   | `/api/sessions/:key/clear`        | Clear session messages (keep header)           |
| `POST`   | `/api/sessions/spawn`             | Create a new dashboard session                 |
| `DELETE` | `/api/sessions/:key`              | Delete a session and all its files             |

## Configuration

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/config`                     | Read parsed config (returns staged if pending) |
| `GET`    | `/api/config/raw`                 | Read raw config JSON (returns staged if pending)|
| `PUT`    | `/api/config`                     | Write config (`?defer=1` supported)            |
| `POST`   | `/api/config/restart`             | Restart the OpenClaw gateway                   |
| `POST`   | `/api/config/validate`            | Validate config structure                      |
| `GET`    | `/api/config/pending`             | Check for staged changes                       |
| `POST`   | `/api/config/commit`              | Write staged config to disk (triggers restart) |
| `DELETE` | `/api/config/pending`             | Discard staged changes                         |

## Channels & Bindings

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/bindings`                   | List channel bindings                          |
| `PUT`    | `/api/bindings`                   | Replace all bindings (`?defer=1` supported)    |
| `PUT`    | `/api/channels/:name`             | Update a channel (`?defer=1` supported)        |
| `DELETE` | `/api/channels/:name`             | Remove a channel (`?defer=1` supported)        |

## Skills

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/skills/:agentId`            | List all skills for an agent                   |
| `GET`    | `/api/skills/:agentId/:dirName`   | Read a skill's SKILL.md content                |
| `PUT`    | `/api/skills/:agentId/:dirName`   | Create or update a skill (`?defer=1` supported)|
| `DELETE` | `/api/skills/:agentId/:dirName`   | Delete a skill                                 |
| `PATCH`  | `/api/skills/:agentId/:dirName`   | Toggle skill enabled/disabled (`?defer=1`)     |
| `POST`   | `/api/skills/:agentId/install`    | Install a skill from registry/GitHub           |

## Tasks & Flows

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/tasks`                      | List tasks and heartbeats                      |
| `POST`   | `/api/tasks`                      | Create a recurring task                        |
| `DELETE` | `/api/tasks/:id`                  | Cancel a task (`?defer=1` for heartbeats)      |
| `POST`   | `/api/tasks/:id/run`              | Force-run a cron job now                       |
| `POST`   | `/api/tasks/:id/edit`             | Edit a cron job                                |
| `POST`   | `/api/tasks/flows/save`           | Save a flow definition (`?defer=1` supported)  |
| `GET`    | `/api/tasks/flows`                | List workflow execution records                |
| `GET`    | `/api/tasks/flows/pending`        | List active flows (running + waiting)          |
| `GET`    | `/api/tasks/flows/history`        | List completed/cancelled flows (7-day retention)|
| `DELETE` | `/api/tasks/flows/history`        | Clear all execution history                    |
| `DELETE` | `/api/tasks/flows/active`         | Clear all active flow state                    |
| `POST`   | `/api/tasks/flows/cancel`         | Cancel a specific active flow                  |
| `POST`   | `/api/tasks/flows/resume`         | Approve or deny a paused flow                  |
| `GET`    | `/api/tasks/flows/definitions`    | List all registered flow definitions           |
| `GET`    | `/api/tasks/flows/definition/:agentId` | Load flow definition for an agent         |
| `DELETE` | `/api/tasks/flows/definition/:agentId/:flowName` | Delete a flow definition      |

## Models & Providers

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/models/status`              | Cached provider status (keys, models, billing) |
| `POST`   | `/api/models/status/refresh`      | Force re-scan all providers                    |
| `GET`    | `/api/health`                     | Live health check (gateway + all providers)    |

## Tools

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/tools/discover`             | Cached tool registry                           |
| `POST`   | `/api/tools/discover`             | Force re-scan tools                            |

## Logs

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/logs`                       | Tail log file                                  |
| `GET`    | `/api/logs/stream`                | SSE live log stream                            |

## Dashboard

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `GET`    | `/api/dashboard/icons`            | Get custom agent icons                         |
| `PUT`    | `/api/dashboard/icons`            | Set a custom agent icon                        |

## Auth

| Method   | Path                              | Description                                    |
|----------|-----------------------------------|------------------------------------------------|
| `POST`   | `/api/auth/reveal`                | Reveal full API key or OAuth token             |
| `POST`   | `/api/auth/refresh`               | Refresh an OAuth token                         |
| `DELETE` | `/api/auth/profile`               | Remove an auth profile (`?defer=1` supported)  |
| `POST`   | `/api/auth/envkey`                | Add or update an API key in .env               |
| `DELETE` | `/api/auth/envkey`                | Remove an API key from .env                    |
