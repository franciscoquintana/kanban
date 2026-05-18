# OpenClaude agent (qwen via local proxy)

> Branch: `feature/openclaude-agent`. Not merged to `main`.

## What this change does

Registers `openclaude` as a launch-supported agent in kanban's catalog. The binary
is `openclaude-qwen`, a thin shell wrapper around the [openclaude](https://github.com/Gitlawb/openclaude)
CLI (a fork of Claude Code re-pointed at OpenAI-compatible endpoints). The wrapper
points openclaude at a local `kilo-nvidia-proxy` serving the free
`opencode/qwen3.6-plus-free` model from opencode.ai/zen.

## Why

Two-phase delegation per work unit:

- **Planning cards** run with `agentId="claude"` (Opus) — design, decisions,
  acceptance criteria. Expensive but high-quality.
- **Execution cards** run with `agentId="openclaude"` (qwen) — mechanical
  implementation of the plan. Free / very cheap. Linked back to the planning card
  via `kanban task link`.

See `AGENTS.md` → "Two-phase delegation: planning vs execution".

## Code changes

| File | Change |
|---|---|
| `src/core/api-contract.ts` | Added `"openclaude"` to `runtimeAgentIdSchema` enum. |
| `src/core/agent-catalog.ts` | New entry in `RUNTIME_AGENT_CATALOG` + added id to `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`. Binary: `openclaude-qwen`. |
| `src/commands/task.ts` | Updated `--agent-id` CLI help text on `create` and `update` to list `openclaude`. |
| `src/terminal/session-manager.ts` | `buildTerminalEnvironment(...)` now injects `KANBAN_TASK_ID` into the agent process env so planning cards know their own id (needed to link children back). |
| `AGENTS.md` | "Two-phase delegation" section. |
| `.gitignore` | Ignores `.claude/logs/`. |
| `.claude/commands/plan-and-delegate.md` | Slash-command shortcut for bootstrapping a planning card from an interactive Claude Code session. |
| `docs/openclaude-agent.md` | This file. |

## System requirements

1. **openclaude** installed:
   ```sh
   npm install --prefix ~/.local -g @gitlawb/openclaude@0.13.0
   ```
   (Use `--prefix` to avoid sudo. Ensure `~/.local/bin` is in `$PATH`.)

2. **Wrapper** at `~/.local/bin/openclaude-qwen` (kanban looks up `openclaude-qwen`
   via `isBinaryAvailableOnPath()`):

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   export CLAUDE_CODE_USE_OPENAI=1
   export OPENAI_BASE_URL="${KILO_PROXY_URL:-http://localhost:3199}/v1"
   export OPENAI_API_KEY="${KILO_PROXY_API_KEY:-anything}"
   export OPENAI_MODEL="opencode/qwen3.6-plus-free"
   export CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS='{"opencode/qwen3.6-plus-free":256000}'
   export CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS='{"opencode/qwen3.6-plus-free":16000}'
   exec openclaude "$@"
   ```

   `chmod +x ~/.local/bin/openclaude-qwen`.

3. **kilo-nvidia-proxy** running on `localhost:3199` (override via `KILO_PROXY_URL`
   env var). The proxy must expose `opencode/qwen3.6-plus-free` in its
   `/v1/models` listing. See `~/sandra-projects/kilo-nvidia-proxy`.

## Usage

### Direct execution card (no planning phase)

```sh
kanban task create --agent-id openclaude \
  --prompt "<detailed mechanical plan>"
```

### Two-phase (recommended)

```sh
# 1. Create a planning card (Opus)
kanban task create --agent-id claude --start-in-plan-mode \
  --title "Add feature X" \
  --prompt "GOAL: <high-level goal>. Plan-and-delegate per AGENTS.md."

# 2. Start it from the UI. Opus reads, designs, then runs (inside its PTY):
kanban task create --agent-id openclaude \
  --prompt "<sub-task 1 detailed plan>"
kanban task link --task-id "$KANBAN_TASK_ID" --linked-task-id "<child-id-1>"
# ...repeat per sub-task...
```

## Risks

- **openclaude is young** (v0.13.0, 2026-04). Pin to an exact version; the
  `installUrl` in the catalog entry lets you reinstall if it breaks.
- **Free-tier rate limits** (HTTP 429 from `opencode.ai/zen`) can interrupt a
  long card. Mitigation: start with one openclaude card at a time; if stable,
  scale.
- **Upstream returns HTTP 500 on `stream: false`** for qwen. openclaude streams
  by default in its agent loop, so this is not normally hit.
- **Patch is local** (not upstreamed to anomalyco/kanban). When pulling main,
  rebase: `git rebase main` on `feature/openclaude-agent`.
