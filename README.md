# pi-delegate

A [pi](https://github.com/earendil-works/pi) extension for delegating work to specialized subagents in isolated context windows.

Each subagent runs as a separate `pi` process in the parent's working directory. Tasks can run individually, in parallel, or in the background while the parent continues working.

## Features

- Agent profiles defined as Markdown files
- Automatic model selection with `fast`, `standard`, and `heavy` tiers
- Per-agent, per-task, and per-invocation model overrides
- Parallel execution with up to four concurrent agents
- Background jobs that report back to the parent session automatically
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

## Configure agents

Create agent profiles in `~/.pi/agent/agents/`. Each profile is a Markdown file with YAML-like frontmatter followed by the agent's system prompt:

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

The Markdown body is appended to the child pi process's system prompt. Agent names must be unique.

### Model selection

The model is chosen in this order:

1. A model set on an individual parallel task
2. The invocation's top-level model
3. The agent profile's `model`
4. A model selected from pi's available models for the agent's tier
5. The parent's current model

The tier heuristic favors a cheaper non-reasoning model for `fast`, a median model for `standard`, and a high-ranked reasoning model for `heavy`. Set an explicit model whenever deterministic routing matters.

## Use

Ask pi naturally:

```text
Delegate a quick codebase survey to scout.

Run scout on the API and architect on the data model in parallel.

Start a worker in the background to add tests while we inspect the bug.
```

The extension exposes two tools.

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
  "tasks": [
    {
      "agent": "scout",
      "task": "Map the request flow"
    },
    {
      "agent": "architect",
      "task": "Review the authorization design",
      "model": "provider/model-id"
    }
  ],
  "background": true
}
```

The top-level `model` is the default for tasks without their own model. Parallel batches run at most four children concurrently; additional tasks are queued.

### `delegate_status`

Inspect one background job:

```json
{
  "jobId": "delegate-..."
}
```

Omit `jobId` to list all jobs started in the current session. Jobs are session-scoped and are aborted when that session shuts down.

## How it works

Children inherit the parent's working directory, environment, normal extension discovery, and skill discovery. They run in JSON mode without saving a session. The selected agent prompt is written to a permission-restricted temporary file and passed through `--append-system-prompt`; the file is removed when the child exits.

Child output returned to the parent is capped to keep the parent context manageable. The complete captured child transcript remains available in the tool details and expanded TUI view.

## Requirements

- A working `pi` installation
- At least one configured and authenticated model
- One or more agent profiles in `~/.pi/agent/agents/`

## Development

Load the checkout directly:

```bash
pi -e ./index.ts
```

A quick non-interactive load check is:

```bash
pi --no-extensions -e ./index.ts --list-models
```
