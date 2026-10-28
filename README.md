# pi-delegate

A [pi](https://github.com/earendil-works/pi) extension for delegating work to specialized subagents in isolated context windows.

Each subagent runs as a separate `pi` process in the parent's working directory. Tasks can run individually, in parallel, or in the background while the parent continues working.

## Features

- Five bundled agent profiles (`scout`, `architect`, `worker`, `interrogator`, and `comment-critic`)
- A `team-lead` skill for plan-driven, review-gated multi-agent delivery, with task routing to investigation, bug-fix, and refactoring playbooks
- Additional agent profiles defined as Markdown files
- Automatic model selection with `fast`, `standard`, and `heavy` tiers
- Per-agent, per-task, and per-invocation model overrides
- Per-agent, per-task, and per-invocation thinking-level overrides
- Per-invocation and per-task working-directory overrides for git worktrees
- Parallel execution with up to four concurrent agents
- A `consensus` tool: N independent solvers, arbiter merge, optional debate rounds
- Background jobs that report back to the parent session automatically and accept targeted steering
- Streaming progress, token usage, cost, and child transcript rendering
- Nested delegation limited to two levels and background-only below the parent

## Install

```bash
pi install git:github.com/metalgrid/pi-delegate
```

Restart pi or run `/reload` in an existing session. To try it without adding it to your settings:

```bash
pi -e git:github.com/metalgrid/pi-delegate
```

Update or remove it with:

```bash
pi update git:github.com/metalgrid/pi-delegate
pi remove git:github.com/metalgrid/pi-delegate
```

> [!WARNING]
> Pi extensions and delegated agents run with your user permissions. Review this extension and limit each agent's tools to operations you trust.

On first load, the extension copies its bundled profiles into `~/.pi/agent/agents/`. Existing files are never overwritten, so local customizations remain intact.

## Team-lead workflow

The package includes a `team-lead` skill that coordinates complex work through planning, task-isolation analysis, lead-managed git worktrees, background implementation delegates, review/fix loops, a senior final review, and sensible history squashing. The skill first routes each task: read-only questions go to an investigation playbook, defects to a reproduce-first bug-fix playbook, and behavior-preserving changes to a refactoring playbook, each read on demand from `skills/team-lead/playbooks/`. Non-trivial diffs also get an adversarial pass from the `interrogator` profile and a comment pass from `comment-critic` during final review.

Invoke it explicitly with:

```text
/skill:team-lead Implement the requested feature
```

The skill requires implementation and corrective workers to run as background delegates. While they run, the lead stays in stand-by and resumes review when the extension reports completion. Worktree creation, integration, cleanup, and history rewriting remain the lead's responsibility; the skill requires explicit safety checks before destructive or shared-history operations.

## Configure agents

The bundled profiles work out of the box. Add or customize profiles in `~/.pi/agent/agents/`; each profile is a Markdown file with YAML-like frontmatter followed by the agent's system prompt:

```markdown
---
name: scout
description: Fast, read-only codebase reconnaissance
tier: fast
tools: read, grep, find, bash
---

Quickly investigate the requested area. Do not modify files. Return concise findings with exact file paths.
```

Supported fields:

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Name passed to the `delegate` tool. |
| `description` | no | Summary shown when available agents are listed. |
| `tier` | no | `fast`, `standard`, or `heavy`; defaults to `standard`. |
| `tools` | no | Comma-separated pi tools available to the child. If omitted, pi's defaults apply. |
| `model` | no | Fixed `provider/model-id` override for this agent. |
| `thinking` | no | Fixed thinking level for this agent: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |

The Markdown body is appended to the child pi process's system prompt. Agent names must be unique.

### Model selection

The model is chosen in this order:

1. A model set on an individual parallel task
2. The invocation's top-level model
3. The agent profile's `model`
4. A model selected from pi's available models for the agent's tier
5. The parent's current model

The tier heuristic favors a cheaper non-reasoning model for `fast`, a median model for `standard`, and a high-ranked reasoning model for `heavy`. Set an explicit model whenever deterministic routing matters.

### Delegation model eligibility

Run `/delegate:models` in interactive TUI mode to open a searchable checkbox modal for the chat models currently available from Pi's configured providers. Classifier and image-generation models are not included.

- Type to search; use ↑/↓ to move and Space or Enter to toggle eligibility.
- **Ctrl+S** saves; **Escape** cancels without writing changes.
- `[x]` means eligible. All models start eligible, including newly discovered models.

Selections are saved atomically in `<agent-dir>/delegate-models.json` (`~/.pi/agent/delegate-models.json` by default; honors `PI_CODING_AGENT_DIR`). Disabled `provider/model-id` identities remain saved even when their provider or model temporarily disappears. Invalid or unreadable preferences fail closed with an actionable error; repair or remove the file rather than silently resetting it.

Eligibility applies to tier selection, the parent-model fallback, task/invocation/profile overrides, consensus solvers and their arbiter, and nested delegation. Explicit overrides must use an **exact, case-sensitive `provider/model-id`** from Pi's chat catalog, optionally followed by `:thinking`; bare IDs and fuzzy aliases are rejected. The child provider is pinned explicitly. A literal model ID containing a colon takes precedence over interpreting it as a thinking suffix.

If no eligible model can be selected, delegation fails before launching a child instead of letting Pi choose an unapproved default. Preferences are reread for each invocation and immediately before each child launch, including queued children and later consensus rounds. Saving changes does not terminate already-running children. These preferences control this extension's selection, not arbitrary model calls or configuration changes made by other extensions.

### Thinking level

Children run as fresh processes and never inherit the parent's current thinking level. The child's thinking level is chosen in this order:

1. A level set on an individual parallel task
2. The invocation's top-level `thinking`
3. The agent profile's `thinking`
4. Pi's configured startup thinking level (`defaultThinkingLevel` / `modelThinkingLevels` in settings)

Levels match pi's `--thinking` flag: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. As a shorthand, a `:<level>` suffix on a `model` value (for example `provider/model-id:high`) is also accepted because model values pass through to `--model` unchanged.

## Use

Ask pi naturally:

```text
Delegate a quick codebase survey to scout.

Run scout on the API and architect on the data model in parallel.

Start a worker in the background to add tests while we inspect the bug.
```

The extension exposes five tools.

### `delegate`

Single task:

```json
{
  "agent": "scout",
  "task": "Find where authentication is configured"
}
```

Parallel tasks:

```json
{
  "cwd": "/repo",
  "tasks": [
    {
      "agent": "scout",
      "task": "Map the request flow"
    },
    {
      "agent": "worker",
      "task": "Implement the approved API change",
      "cwd": "/repo/.worktrees/api-change",
      "model": "provider/model-id",
      "thinking": "high"
    }
  ],
  "background": true
}
```

Top-level `model`, `thinking`, and `cwd` are defaults for tasks without their own values. A relative `cwd` resolves from the parent session's directory and must exist. Parallel batches run at most four children concurrently; additional tasks are queued.

Set `thinking` to pin a child's reasoning effort; per-task values override the top-level value. Without it, children start at pi's configured default thinking level.

Background jobs automatically inject a completion message into the parent session and trigger a new turn. The parent agent should continue independent work or end its response instead of polling with `delegate_status`, `sleep`, or wait loops.

### `delegate_message`

Each background child receives a stable child ID when the job starts. Queued parallel children cannot be messaged until they launch. The parent can send one active child a new instruction:

```json
{
  "jobId": "delegate-...",
  "childId": "delegate-...:1",
  "message": "Prioritize the failing integration test and do not alter the public API.",
  "delivery": "steer"
}
```

Call this through `delegate_message`. `delivery` defaults to `"steer"`, which queues the instruction after the child finishes its current tool turn; use `"followUp"` to queue it after the current run settles. Completed children cannot be messaged.

### `delegate_terminate`

Stop one active background child:

```json
{
  "jobId": "delegate-...",
  "childId": "delegate-...:1"
}
```

Queued and completed children cannot be terminated individually. Termination marks the child result as aborted; the remaining children in a parallel job continue running.

### `delegate_status`

Inspect one background job:

```json
{
  "jobId": "delegate-..."
}
```

Omit `jobId` to list all jobs started in the current session. Jobs are session-scoped and are aborted when that session shuts down.

Interactive job viewer:

```text
/delegate:tasks
```

Use `↑`/`↓` and Enter to select a job and view its live child output. In the output view, use `↑`/`↓`, Page Up/Down, Home/End to scroll; Escape or Left returns to the list, and Escape from the list closes the modal. The viewer is read-only: it never sends input to or cancels a child session.

### `consensus`

Have several solvers work the same task independently, then merge their answers into one stable result:

```json
{
  "agent": "architect",
  "task": "Design the migration plan from config v1 to v2",
  "n": 3,
  "rounds": 2,
  "models": ["provider/a", "provider/b"]
}
```

Round 0 spawns `n` independent solvers (2–5, default 3). An arbiter child then merges all proposals into one result and reports material disagreement as dissent notes. With `rounds > 1` (max 3), a divided verdict triggers a broadcast debate round: every solver receives the anonymized competing proposals plus the arbiter's notes and produces a revised proposal; the arbiter merges again. The loop stops as soon as the arbiter reports consensus or the rounds budget is spent.

The parent receives only the merged result and the dissent notes; per-child transcripts stay in the tool details. Each round costs `n + 1` model calls, so keep `n` small unless the stakes justify more. `models` cycles per solver — diverse models make consensus more meaningful. `thinking` applies to solvers and the arbiter. `cwd` sets the working directory for all children. Consensus runs in the foreground only and cannot run inside a delegated child session.

Slash command equivalent:

```text
/consensus [--agent <name>] [--n <2-5>] [--rounds <1-3>] [--thinking <level>] <task>
```

Defaults are `architect`, `n 3`, `rounds 1`. The command instructs the agent to invoke the tool with those parameters, so the call and its result stay visible in the transcript.

## How it works

Children inherit the parent's environment, normal extension discovery, and skill discovery, and run in the resolved child working directory. They run in RPC mode without saving a session so background children can receive steering messages. The selected agent prompt is written to a permission-restricted temporary file and passed through `--append-system-prompt`; the file is removed when the child exits.

Child output returned to the parent is capped to keep the parent context manageable. The complete captured child transcript remains available in the tool details and expanded TUI view.

## Requirements

- A working `pi` installation
- At least one configured and authenticated model
- Write access to `~/.pi/agent/agents/` on first load so missing bundled profiles can be installed

## Development

Load the checkout directly:

```bash
pi -e ./index.ts
```

Run the focused regression suite with the installed Pi package (including its bundled `jiti` and peer packages):

```bash
PI_PACKAGE_DIR=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent npm test
```

If those packages already resolve locally, `npm test` is sufficient. Tests use an isolated agent directory and a fake RPC child, never real credentials or paid model calls.

A quick non-interactive load check is:

```bash
pi --no-extensions -e ./index.ts --list-models
```
