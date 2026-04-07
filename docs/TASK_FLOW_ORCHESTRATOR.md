# Task Flow Orchestrator

The Orchestrator tab lets you define multi-step agent pipelines (Task Flows) directly
from the dashboard. Each flow is a sequence of steps, where each step delegates work
to a specific agent. Steps can optionally require human approval before proceeding.

## What is it?

Task Flow Orchestration chains multiple agents together into a repeatable pipeline.
Instead of manually coordinating agents, you define a flow once and the system handles
step-by-step execution, state tracking, and approval gates automatically.

This is useful when you have a multi-agent setup where different agents specialize in
different tasks (coding, reviewing, deploying, etc.) and you want them to work together
in a defined sequence.

## How it works

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

When a step has "Pause for approval" enabled, the flow enters a `waiting_for_approval`
state. The user can approve or deny from the dashboard's Flows tab or through the chat
interface.

## Prerequisites

1. At least two agents configured (one orchestrator + one or more worker agents)
2. The orchestrating agent has `run_task_flow` in its `tools.alsoAllow` list (auto-added when you save a flow)
3. Target agents referenced in flow steps are configured as subagents of the orchestrator
4. The orchestrator's AGENTS.md file contains workflow policy instructions (generated snippet provided on save)
5. The gateway is restarted after saving a new flow so the tool becomes available

## Sample AGENTS.md for a coding orchestrator

This is the kind of file you'd place in your orchestrator agent's workspace directory.
The dashboard generates a tailored version of this when you save a flow.

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

## Sample workflow definition

Create a flow in the Orchestrator tab or write a `.flow.ts` file in `Tasks/`.
Here's the `coding_pipeline` example:

```typescript
// Tasks/coding_pipeline.flow.ts (auto-generated by the dashboard)
type CoderImplementResult = { status: string; summary?: string };
type CodeReviewResult = { status: string; summary?: string };
type SecurityAuditResult = { status: string; summary?: string };
type DeployPrepResult = { status: string; summary?: string };

export async function startCodingPipelineFlow(ctx: ToolContext) {
    const task = ctx.input.task;
    const taskFlow = ctx.api.runtime.taskFlow.fromToolContext(ctx);

    const flow = await taskFlow.createManaged({
        controllerId: "coding-orchestrator/start_coding_pipeline",
        goal: "Execute coding workflow: implement, review, security audit, and deploy preparation",
    });

    try {
        const coder_implement = await flow.runTask<CoderImplementResult>({
            id: "coder_implement",
            agentId: "coding",
            input: { task, instructions: ["Implement the requested code changes"] },
        });

        const code_review = await flow.runTask<CodeReviewResult>({
            id: "code_review",
            agentId: "code-reviewer",
            input: { task, instructions: ["Review implementation for quality and correctness"] },
        });

        const security_audit = await flow.runTask<SecurityAuditResult>({
            id: "security_audit",
            agentId: "code-security",
            input: { task, instructions: ["Perform security and safety review of the implementation"] },
        });

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

## Managing flows from the Tasks view

The Tasks page has two tabs: **Flows** and **Scheduled**.

Under Flows you can:
- See pending approval gates and approve/deny them individually or clear all at once
- View execution history — completed and cancelled flows are retained for 7 days
- Clear all history or delete stuck/failed executions individually

When you click **✓ Approve** on a pending flow, the dashboard updates the flow state,
sends the approval to the orchestrator agent's active session, and the agent automatically
resumes — no manual nudging required.

Execution history is stored in `~/.openclaw/extensions/openclaw-agent-dashboard/flow-history/`
as JSON files. Entries older than 7 days are automatically pruned.

## Setting up agents for Task Flow

### Orchestrator agent

**AGENTS.md** must include:
- A workflow policy section telling the agent to call `run_task_flow`
- The state machine loop: `run` → `step_complete` → `resume`
- Per-agent spawning instructions with artifact paths
- A `sessionKey` parameter when calling `run_task_flow`

The orchestrator also needs:
- `run_task_flow` in its `tools.alsoAllow` (auto-added when you save a flow)
- `sessions_spawn`, `sessions_send`, `sessions_list`, `sessions_history` in `tools.alsoAllow`
- Target agents listed in `subagents.allowAgents`

### Worker agents

Worker agents handle the actual work delegated by the orchestrator. Each worker should
have skills installed that match its responsibilities.

**AGENTS.md** should specify:
- The agent's role and what it receives tasks for
- Where to write output artifacts (absolute path)
- That it should use `write_file` to create files, not just show code in chat

**TOOLS.md** should list:
- Available tools (`write_file`, `read_file`, `shell`, etc.)
- The artifact output directory

**Skills** — install relevant skills on each worker agent. For example:
- `code-devops` agent: a "Git Operations" skill for repo creation and pushing
- `code-reviewer` agent: a "Code Review Standards" skill with your team's review checklist
- `code-security` agent: a "Security Audit" skill with your security policies

See the [Skills Guide](SKILLS.md) for how to create and manage skills.

**BOOTSTRAP.md** (optional) can ensure the artifacts directory exists:
```markdown
# Bootstrap
On session start, ensure the artifacts directory exists:
mkdir -p /path/to/artifacts
```

### Graph indicator

Agents with `run_task_flow` in their `tools.alsoAllow` display a 👑 crown on their
icon in the relationship graph, making it easy to identify orchestrators.
