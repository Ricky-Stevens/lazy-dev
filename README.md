# lazy-dev

[![CI](https://github.com/Ricky-Stevens/lazy-dev/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricky-Stevens/lazy-dev/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Ricky-Stevens/lazy-dev/graph/badge.svg)](https://codecov.io/gh/Ricky-Stevens/lazy-dev)
[![Semgrep](https://img.shields.io/badge/security-semgrep-blue)](https://github.com/Ricky-Stevens/lazy-dev/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.2.0-blue)](https://github.com/Ricky-Stevens/lazy-dev/releases)
[![Bun](https://img.shields.io/badge/runtime-Bun%201.3%2B-f9f1e1)](https://bun.sh)

A Claude Code plugin for big tasks. You keep working in your main thread -- when something needs a plan, decomposition, parallel specialists, and a review, hand it to lazy-dev.

## Install

```bash
/plugin marketplace add https://github.com/Ricky-Stevens/lazy-dev
/plugin install lazy-dev
```

**Note:** Claude's `/reload-plugins` can be a bit sketchy - try opening a new session if you hit issues.

### Update

To pull the latest version:

1. Open `/plugins`
2. Go to **Marketplaces** tab → select the lazy-dev marketplace → **Update marketplace**
3. Inside the marketplace, go to **Browse Plugins** → select lazy-dev → **Update**
4. Run `/reload-plugins` or restart your session

### Uninstall

```bash
/plugin uninstall lazy-dev
```

### Local development

```bash
claude --plugin-dir /path/to/lazy-dev
```

---


## The problem

Your main Claude Code session is great for quick edits, questions, and focused tasks. But when work gets bigger -- a new feature across multiple files, a refactor, a migration -- you hit friction:

- **Credit burn.** The model gets stuck in test-fix-break loops and eats your plan window.
- **Context bloat.** Long tasks compress into lossy summaries. Fidelity drops.
- **No cost control.** Same model, same effort, whether it's a docs update or an API reshape.
- **No off-ramp.** Once a big task starts in the main thread, you're riding it out.

## What lazy-dev does

You type `/lazy-dev:run` with a brief. It plans the work, asks for your approval, fans out to specialist agents in isolated git worktrees, reviews their output, and merges the results back. Your main thread stays free the entire time.

### Right-sized models

Each agent runs on the cheapest model that can do the job:

| Model | Agents |
|---|---|
| Haiku | docs, format |
| Sonnet | code-small (narrow edits, up to 3 files), research, merger, wrangler |
| Opus | code-big (multi-file), planner, reviewer, debug |

### Effort variants

Model choice alone isn't enough -- the same Opus agent is overkill at max reasoning for a rename sweep, and underpowered at low effort for an API reshape. lazy-dev ships 19 agents across 5 effort levels (`low`, `medium`, `high`, `xhigh`, `max`). The planner picks the right variant per task based on complexity.

A boilerplate propagation gets `code-big-low`. A tricky cross-cutting invariant gets `code-big-high`. You pay for reasoning where it matters.

### Circuit breakers

The Ralph gate fires after every specialist stops. It parses the completion sentinel, runs verifiers (lint, test, scope check), and writes APPROVED or FAILED markers. If a specialist hits the same failure twice, or produces the same diff twice, the run stops. Default 3 iterations per task, hard cap at 10. No runaway loops.

## When lazy-dev isn't the right tool

- **Small tasks.** If you can describe and finish it in one message, just do it in your main thread.
- **Inherently sequential work.** lazy-dev parallelises across independent tasks. If every step depends on the previous one, the overhead isn't worth it.
- **Exploratory work.** lazy-dev needs a clear brief to plan against. If you're still figuring out what to build, work in your main thread first and hand it off once the shape is clear.

## How is this different from Superpowers?

Both projects orchestrate multi-agent work for Claude Code. They solve similar problems differently.

Superpowers is a full framework that reshapes how you work with Claude across a session. lazy-dev is a plugin with three slash commands. You reach for it when a specific task is big enough, and your main thread stays yours the rest of the time.

What lazy-dev specifically does differently:

- **Effort variants.** 5 effort levels per agent role, not just model choice. The planner picks the variant per task based on complexity.
- **Ralph gate.** A verification hook with circuit breakers (same-failure-twice stop, same-diff-twice stop, max iterations) that kills oscillation automatically.
- **Explicit invocation.** lazy-dev only activates when you call `/lazy-dev:run`. Nothing ambient, nothing persistent between runs.

If you want a framework that transforms your whole workflow, use Superpowers. If you want a lightweight plugin you invoke for big tasks and forget about, use lazy-dev. They can coexist.

## Usage

Three commands.

| Command | What it does |
|---|---|
| `/lazy-dev:run <brief>` | Plan, approve, fan-out, review, merge. The full pipeline. |
| `/lazy-dev:status` | Check what's running and where it's at. |
| `/lazy-dev:cancel [run-id]` | Stop a run. In-flight work finishes, pending tasks are cancelled. |

### Example

```
/lazy-dev:run Add a rate limiter to the API routes. Use a sliding window algorithm, add tests, and update the API docs.
```

lazy-dev will:
1. Plan the work and show you the task breakdown
2. Wait for your approval (small, low-risk plans auto-approve)
3. Fan out specialists in parallel worktrees (up to 8 for independent tasks)
4. Run each specialist through the Ralph gate
5. Review all output against the master spec
6. Merge results back to your branch (`--no-ff`)
7. Run integration tests if a test runner is detected

### Custom verifiers

Drop a shell script at `<project>/.lazy-dev/verifiers/<name>.sh` to override a built-in verifier. `<name>` must match the first token of the verifier command (e.g., `lint.sh` overrides the built-in lint verifier). Your script runs with the worktree as cwd.

## Requirements

- Claude Code
- [Bun](https://bun.sh) 1.3+
- Git (recommended; non-git projects use an rsync fallback with sha256-based conflict detection)
- Bash 4+ (merge uses associative arrays; macOS ships 3.2 -- install via `brew install bash`)
- WSL Ubuntu or macOS (no Windows-native support yet)

## Contributing

MIT licensed. PRs welcome.

```bash
bun install
bun test
bun run lint
```
