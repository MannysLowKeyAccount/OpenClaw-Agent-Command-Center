# Skills

Skills are reusable instruction sets that teach agents new capabilities. Each skill
lives in its own directory with a `SKILL.md` file containing frontmatter metadata and
markdown instructions.

## How skills work

1. Skills are stored as directories containing a `SKILL.md` file
2. The dashboard generates a `SKILLS.md` index in the agent's workspace listing all
   enabled skills with paths to their instruction files
3. When a user request matches a skill, the agent uses its `read` tool to load the
   full `SKILL.md` instructions on demand
4. The agent follows the skill's instructions to handle the request

## Skill scopes

| Scope | Location | Visibility |
|-------|----------|------------|
| Workspace (per-agent) | `~/.openclaw/workspace-{agentId}/skills/{name}/` | Only the owning agent |
| Managed (global) | `~/.openclaw/skills/{name}/` | All agents (unless disabled per-agent) |

Workspace skills take precedence — if both scopes have a skill with the same directory
name, the workspace version is used.

## SKILL.md format

```markdown
---
name: My Skill
description: What this skill does in one line
---

# My Skill

Instructions for the agent go here. Use standard markdown.

## When to Use
- Scenario A
- Scenario B

## Steps
1. Do this first
2. Then do that

## Commands
```bash
example-command --flag value
```
```

The frontmatter fields:
- `name` (required) — display name
- `description` — short description shown in the skills list

## Creating a skill from the dashboard

1. Open an agent's drawer → **Tools / Skills** tab
2. Click **+ New Skill**
3. Fill in the name, description, scope, and instructions
4. Click **Create Skill**

The skill is immediately available. The dashboard auto-generates the `SKILLS.md` index
and ensures the agent has the `read` tool enabled.

## Installing skills

The dashboard supports installing skills from external sources:

- **ClawHub** — the OpenClaw skill registry
- **skills.sh** — community skill packages
- **GitHub** — direct repository URL

From the Skills tab, click **Install** and select the source.

## Enabling and disabling

Each skill can be toggled on/off per agent. Disabling a skill removes it from that
agent's `SKILLS.md` index without deleting the skill files.

## How SKILLS.md is generated

When skills change, the dashboard writes a `SKILLS.md` file to the agent's workspace:

```markdown
# Active Skills

Read the skill file before acting when a request matches a skill below.

- **Brainstorming** — Generate creative ideas and solutions
  → `~/.openclaw/skills/brainstorming/SKILL.md`
- **Code Review** — Review code for quality and best practices
  → `skills/code-review/SKILL.md`
```

The agent's system prompt includes this file. When a request matches a skill, the agent
reads the full `SKILL.md` via the `read` tool.

## Example: creating a "Git Operations" skill

### 1. Create the skill directory and file

**Workspace scope** (agent-specific):
```
~/.openclaw/workspace-coding/skills/git-ops/SKILL.md
```

**Managed scope** (shared across agents):
```
~/.openclaw/skills/git-ops/SKILL.md
```

### 2. Write the SKILL.md

```markdown
---
name: Git Operations
description: Create repos, manage branches, commit and push code
---

# Git Operations

When the user asks to create a repository, push code, or manage git operations,
follow these steps.

## Creating a new GitHub repository

1. Create the repo using the GitHub CLI:
   ```bash
   gh repo create {repo-name} --public --clone
   ```
2. Add the project files to the repo
3. Commit and push:
   ```bash
   git add -A
   git commit -m "Initial commit"
   git push -u origin main
   ```

## Branch management

- Create feature branches: `git checkout -b feature/{name}`
- Always push to a named branch, never force-push to main
```

### 3. Verify in the dashboard

Open the agent's **Tools / Skills** tab. The skill should appear in the list.
Toggle it on if it's not already enabled.

## Interaction with the Task Flow Orchestrator

Skills and task flows complement each other:

- **Skills** teach individual agents how to do specific tasks
- **Task flows** coordinate multiple agents in sequence

For example, a `code-devops` agent might have a "Git Operations" skill that teaches
it how to create repos and push code. The task flow orchestrator delegates the
`deploy_prep` step to this agent, which then uses its skill to execute the work.

The orchestrator agent itself doesn't need skills for the tasks it delegates — it
only needs the `run_task_flow` tool and its `AGENTS.md` workflow policy.
