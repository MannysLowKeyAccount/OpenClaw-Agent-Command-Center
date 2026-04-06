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
and multi-agent orchestration from a single browser tab.

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
- **Task Flow Orchestrator** — design, save, and run multi-step agent pipelines with approval gates
- Raw JSON config editor with validation
- Live log tailing via SSE
- Health checks with dismissable banners
- PWA support — add to home screen on iOS/Android
- Fully responsive

📐 [Architecture & how it works](docs/ARCHITECTURE.md) · 📡 [API Reference](docs/API_REFERENCE.md)

---

## Task Flow Orchestrator

The Orchestrator tab lets you define multi-step agent pipelines (Task Flows) directly from the dashboard. Each flow is a sequence of steps, where each step delegates work to a specific agent. Steps can optionally require human approval before proceeding.

### What is it?

Task Flow Orchestration is a way to chain multiple agents together into a repeatable pipeline. Instead of manually coordinating agents, you define a flow once and the system handles step-by-step execution, state tracking, and approval gates automatically.

This is useful when you have a multi-agent setup where different agents specialize in different tasks (coding, reviewing, deploying, etc.) and you want them to work together in a defined sequence.

### How it works

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  User sends  │────▶│  Orchestrator │────▶│  run_task_flow│────▶│  Returns     │
│  request     │     │  agent        │     │  action=run   │     │  Step 1      │
└─────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                                                      │
                    ┌──────────────────────────────────────────────────┘
                    ▼
              ┌───────────┐    ┌──────────────┐    ┌───────────────┐
              │ Execute    │───▶│ step_complete │───▶│ Returns       │
              │ via spawn  │    │              │    │ next step     │
              └───────────┘    └──────────────┘    │ or approval   │
                                                    │ gate          │
                                                    └───────┬───────┘
                                                            │
                         ┌──────────────────────────────────┘
                         ▼
                   ┌──────────┐     ┌──────────────┐     ┌──────────────┐
                   │ ⏸ Paused  │────▶│ User approves │────▶│ resume       │
                   │ (if gate) │     │ or denies     │     │ approve=true │
                   └──────────┘     └──────────────┘     └──────────────┘
```

**State machine:** `run` → execute step → `step_complete` → (next step | approval gate | completed)

When a step has "Pause for approval" enabled, the flow enters a `waiting_for_approval` state. The user can approve or deny from the dashboard's Flows tab or through the chat interface.

### Prerequisites

Before using the Orchestrator, make sure:

1. You have at least two agents configured (one orchestrator + one or more worker agents)
2. The orchestrating agent has `run_task_flow` in its `tools.alsoAllow` list (auto-added when you save a flow)
3. Target agents referenced in flow steps are configured as subagents of the orchestrator
4. The orchestrator's AGENTS.md file contains workflow policy instructions (generated snippet provided on save)
5. The gateway is restarted after saving a new flow so the tool becomes available

### Sample AGENTS.md for a coding orchestrator

This is the kind of file you'd place in your orchestrator agent's workspace directory. The dashboard generates a tailored version of this when you save a flow.

```markdown
# Workflow policy

You are a coordination agent, not an implementation agent.

For requests that match this workflow:
- Do not perform the work yourself.
- Call the `run_task_flow` tool.
- Pass:
  - flowName: `coding_pipeline`
  - task summary

Execution policy:
1. coder_implement (agent: coding) — Implement the requested code changes
2. code_review (agent: code-reviewer) — Review implementation for quality and correctness
3. security_audit (agent: code-security) — Perform security and safety review
4. deploy_prep (agent: code-devops) — Prepare deployment artifacts [requires human approval]

Approval policy:
- Steps requiring human approval: deploy_prep.
- When the flow pauses for approval, it returns a resumeToken.
  Tell the user the flow is waiting and which step needs approval.
- To continue after approval, call `run_task_flow` with
  action="resume", the resumeToken, and approve=true.
- To deny, call with approve=false to cancel the flow.
- The user can also approve from the Dashboard.
- Any destructive change, production deployment, secret rotation,
  infrastructure mutation, or irreversible action requires explicit user approval.

Your responsibilities:
- classify the request
- start the workflow by calling `run_task_flow` with action="run"
- the tool returns ONE step at a time — execute it via `sessions_spawn`,
  then call `run_task_flow` with action="step_complete" and the flowToken
- repeat until the flow completes or pauses for approval
- when the flow pauses for approval, tell the user and wait for their decision
- when approved, call `run_task_flow` with action="resume" and the flowToken
- surface failures
- summarize final outputs

You must not:
- implement work directly when the workflow applies
- skip any flow steps
- bypass approval gates — always ask the user before resuming
- approve a paused flow without explicit user consent
```

### Sample workflow definition

Create a flow in the Orchestrator tab or write a `.flow.ts` file in `Tasks/`. Here's the `coding_pipeline` example that ships with the project:

```typescript
// Tasks/coding_pipeline.flow.ts (auto-generated by the dashboard)
type CoderImplementResult = { status: string; summary?: string };
type CodeReviewResult = { status: string; summary?: string };
type SecurityAuditResult = { status: string; summary?: string };
type DeployPrepResult = { status: string; summary?: string };

// ... SDK types omitted for brevity ...

export async function startCodingPipelineFlow(ctx: ToolContext) {
    const task = ctx.input.task;
    const taskFlow = ctx.api.runtime.taskFlow.fromToolContext(ctx);

    const flow = await taskFlow.createManaged({
        controllerId: "coding-orchestrator/start_coding_pipeline",
        goal: "Execute coding workflow: implement, review, security audit, and deploy preparation",
    });

    try {
        // Step 1: Implement the requested code changes
        const coder_implement = await flow.runTask<CoderImplementResult>({
            id: "coder_implement",
            agentId: "coding",
            input: { task, instructions: ["Implement the requested code changes"] },
        });

        // Step 2: Review implementation for quality and correctness
        const code_review = await flow.runTask<CodeReviewResult>({
            id: "code_review",
            agentId: "code-reviewer",
            input: { task, instructions: ["Review implementation for quality and correctness"] },
        });

        // Step 3: Perform security and safety review
        const security_audit = await flow.runTask<SecurityAuditResult>({
            id: "security_audit",
            agentId: "code-security",
            input: { task, instructions: ["Perform security and safety review of the implementation"] },
        });

        // Step 4: Approval gate before deployment
        await taskFlow.setWaiting({
            currentStep: "deploy_prep",
            waitJson: { kind: "approval" },
        });

        const deploy_prep = await flow.runTask<DeployPrepResult>({
            id: "deploy_prep",
            agentId: "code-devops",
            input: { task, instructions: ["Prepare deployment artifacts or deploy if explicitly allowed"] },
        });

        await flow.complete({ result: { status: "SUCCESS", task } });
    } catch (error) {
        await flow.fail({ reason: "Unhandled exception" });
    }
}
```

### Managing flows from the Tasks view

The Tasks page has two tabs: **Flows** and **Scheduled**.

Under Flows you can:
- See pending approval gates and approve/deny them individually or clear all at once
- View execution history — completed and cancelled flows are retained for 7 days with timestamps, step chains, and task descriptions
- Clear all history with the "Clear History" button
- Delete stuck or failed executions individually or in bulk

When you click **✓ Approve** on a pending flow, the dashboard:
1. Updates the flow state file to `running`
2. Sends the approval message directly to the orchestrator agent's active session
3. The agent automatically resumes the flow and executes the remaining steps — no manual nudging required

Execution history is stored in `~/.openclaw/extensions/openclaw-agent-dashboard/flow-history/` as JSON files. Entries older than 7 days are automatically pruned when the history is loaded.

### Setting up agents for Task Flow

To use the Task Flow Orchestrator, you need to configure your agents' workspace files. Here's what each agent needs:

#### Orchestrator agent (e.g. `coding-orchestrator`)

**AGENTS.md** must include:
- A workflow policy section telling the agent to call `run_task_flow`
- The state machine loop: `run` → `step_complete` → `resume`
- Per-agent spawning instructions with artifact paths
- A `sessionKey` parameter when calling `run_task_flow` (enables dashboard approval routing)

Key sections to include:

```markdown
## Workflow policy

For coding requests:
- Call the `run_task_flow` tool to orchestrate the pipeline.

### How the tool works (state machine)

1. **Start**: Call `run_task_flow` with `action: "run"`, `flowName: "coding_pipeline"`,
   `task: "<description>"`, and `sessionKey: "<your current session ID>"`
2. **Execute step**: Use `sessions_spawn` to delegate to the specified agent
3. **Advance**: Call `run_task_flow` with `action: "step_complete"`, `flowToken: "<token>"`
4. **Repeat** until the flow completes or pauses for approval
5. **Approval gate**: Tell the user and wait. When approved, call `run_task_flow`
   with `action: "resume"`, `flowToken: "<token>"`, `approve: true`

### Spawning instructions per agent

- **coding**: "Write all output files to /path/to/artifacts/ using write_file."
- **code-reviewer**: "Review the files at /path/to/artifacts/."
- **code-security**: "Audit the files at /path/to/artifacts/ for security issues."
- **code-devops**: "Prepare deployment for files at /path/to/artifacts/.
   Use the default gh credentials (do NOT specify an org unless the user named one)."
```

The orchestrator also needs:
- `run_task_flow` in its `tools.alsoAllow` (auto-added when you save a flow from the dashboard)
- `sessions_spawn`, `sessions_send`, `sessions_list`, `sessions_history` in `tools.alsoAllow`
- Target agents listed in `subagents.allowAgents`

#### Worker agents (e.g. `coding`, `code-reviewer`, `code-security`, `code-devops`)

**AGENTS.md** should specify:
- The agent's role and what it receives tasks for
- Where to write output artifacts (absolute path)
- That it should use `write_file` to create files, not just show code in chat

**TOOLS.md** should list:
- Available tools (`write_file`, `read_file`, `shell`, etc.)
- The artifact output directory
- A reminder to always use `write_file` to create code

**BOOTSTRAP.md** (optional) can ensure the artifacts directory exists:
```markdown
# Bootstrap
On session start, ensure the artifacts directory exists:
mkdir -p /path/to/artifacts
```

#### Graph indicator

Agents with `run_task_flow` in their `tools.alsoAllow` display a 👑 crown on their icon in the relationship graph, making it easy to identify which agents are orchestrators.

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
| `bind`           | `0.0.0.0`                 | Bind address (`127.0.0.1` to restrict to local only)                        |

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

## Project Structure

```
src/
  server/              Server-side code
    index.ts           Plugin entry point (registers service, tool, RPC)
    api.ts             API route handler (3000+ lines of endpoints)
    auth.ts            Authentication (scrypt hashing, session tokens)
    dashboard.ts       Dashboard HTML builder
    resolve-asset.ts   Asset path resolver (works in dev and dist)
  orchestrator/        Task Flow Orchestrator logic
    types.ts           Shared type definitions (TaskFlowDefinition, etc.)
    utils.ts           Validation, sorting, tool ID helpers
    codegen.ts         Code generation (.flow.ts files, AGENTS.md snippets)
    codegen.test.ts    Tests for codegen (unit + property-based)
    utils.test.ts      Tests for utils (unit + property-based)
  assets/              Static assets served at runtime
    dashboard.css      Dashboard stylesheet
    dashboard.js.txt   Client-side JavaScript (served inline in HTML)
    favicon.png        Favicon
    ios_icon.png       iOS home screen icon
    logo.png           Logo
  __tests__/           Integration tests
    index.test.ts      Plugin registration tests
Tasks/                 Task Flow definitions (mirrors server-side path)
  coding_pipeline.flow.ts   Example flow definition
scripts/               Deployment and operations scripts
  deploy.py            SSH deployment to remote server
  fix_deploy.py        Emergency fix deployment
  check_gateway.py     Remote gateway status checker
docs/                  Documentation and screenshots
  ARCHITECTURE.md      Architecture overview
  API_REFERENCE.md     Full API documentation
  images/              Dashboard screenshots
```

---

## API Reference Summary

All endpoints are under `/api/` and require authentication.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/overview` | Full dashboard data (agents, config, sessions, bindings) |
| GET | `/api/health` | Provider health check (API key validity, rate limits) |
| GET | `/api/models/status` | Provider status with billing and model lists |
| GET | `/api/config/raw` | Raw `openclaw.json` content |
| PUT | `/api/config` | Update configuration |
| POST | `/api/agents` | Create a new agent |
| PUT | `/api/agents/:id` | Update an agent |
| DELETE | `/api/agents/:id` | Delete an agent |
| GET | `/api/tasks` | List recurring tasks |
| POST | `/api/tasks` | Create a recurring task |
| GET | `/api/tasks/flows` | List workflow executions and pending approvals |
| POST | `/api/tasks/flows/save` | Save a Task Flow definition (.flow.ts) |
| POST | `/api/tasks/flows/resume` | Approve or deny a pending flow |
| DELETE | `/api/tasks/flows/:name` | Delete a flow definition |
| POST | `/api/sessions/spawn` | Spawn a new agent session |
| POST | `/api/gateway/restart` | Restart the gateway |
| GET | `/api/logs` | SSE endpoint for live log tailing |

See [docs/API_REFERENCE.md](docs/API_REFERENCE.md) for full details.

---

## Development

```bash
npm install
npm run build      # compile TypeScript to dist/
npm run dev        # watch mode
npm test           # run vitest (106 tests including property-based)
```

CSS and client JS (`src/assets/dashboard.css`, `src/assets/dashboard.js.txt`) are served
from `src/assets/` at runtime — changes don't require a rebuild, just a browser refresh.
Only `*.ts` changes need `tsc`.

---

## Disclaimer

This plugin is provided as-is with no warranty. It reads and writes files under
`~/.openclaw/` including your main configuration. Back up your OpenClaw configuration
before installing or deploying.
