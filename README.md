# lazy-dev

[![CI](https://github.com/Ricky-Stevens/lazy-dev/actions/workflows/ci.yml/badge.svg)](https://github.com/Ricky-Stevens/lazy-dev/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Ricky-Stevens/lazy-dev/graph/badge.svg)](https://codecov.io/gh/Ricky-Stevens/lazy-dev)
[![Semgrep](https://img.shields.io/badge/security-semgrep-blue)](https://github.com/Ricky-Stevens/lazy-dev/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/Ricky-Stevens/lazy-dev/releases)
[![Bun](https://img.shields.io/badge/runtime-Bun%201.3%2B-f9f1e1)](https://bun.sh)

A Claude Code plugin for big tasks. You keep working in your main thread - when something needs a plan, decomposition, parallel specialists, and a review, hand it to lazy-dev.

## The problem

Your main Claude Code session is great for quick edits, questions, and focused tasks. But when work gets bigger - a new feature across multiple files, a refactor, a migration - you hit friction:

- **Credit burn.** The model gets stuck in test-fix-break loops and eats your plan window.
- **Context bloat.** Long tasks compress into lossy summaries. Fidelity drops.
- **Overpriced trivia.** Opus-level reasoning on a lint fix or a docs update.
- **No off-ramp.** Once a big task starts in the main thread, you're riding it out.

## What lazy-dev does

You give it a brief. It plans the work, asks for your approval, fans out to specialist agents in isolated git worktrees, reviews their output, and merges the results back. Your main thread stays free the entire time.

Each specialist runs at the right cost tier:
- **Haiku** for docs and formatting
- **Sonnet** for most code tasks
- **Opus** for planning, review, and complex multi-file work; where it earns its rate

Effort levels are tuned per agent too (low/medium/high/max), so you're not paying for max reasoning on straightforward work.

If anything goes wrong, the run stops and tells you. No silent retries, no runaway loops. Circuit breakers kill oscillation before it eats credits.

## How is this different from Superpowers?

Superpowers takes over your entire session with ambient orchestration. lazy-dev stays out of your way.

| | Superpowers | lazy-dev |
|---|---|---|
| **Activation** | Ambient - always on | Explicit - you invoke `/lazy-dev:run` when you're ready |
| **Main thread** | Occupied | Free - keep working while lazy-dev runs |
| **Cancellation** | Hard to stop mid-run | `/lazy-dev:cancel` at any time |
| **Cost control** | Single model | Right-sized models + effort levels per task |
| **Speed** | Can be slow due to single-thread orchestration | Parallel fan-out across isolated worktrees |

Use Superpowers when you want hands-off ambient assistance on everything. Use lazy-dev when you want to keep your main thread for quick work and only escalate the big stuff.

## Install

```
/plugin marketplace add https://github.com/Ricky-Stevens/lazy-dev
/plugin install lazy-dev
```

Note: Claude's `/reload-plugins` may not always work - try opening a new session if you hit issues.

## Usage

Three commands. That's it.

| Command | What it does |
|---|---|
| `/lazy-dev:run <brief>` | Plan, approve, fan-out, review, merge. The full pipeline. |
| `/lazy-dev:status` | Check what's running and where it's at. |
| `/lazy-dev:cancel` | Stop a run. In-flight work finishes, pending tasks are cancelled. |

### Example

```
/lazy-dev:run Add a rate limiter to the API routes. Use a sliding window algorithm, add tests, and update the API docs.
```

lazy-dev will:
1. Plan the work and show you the task breakdown
2. Wait for your go/cancel
3. Fan out specialists in parallel worktrees
4. Review all output against the plan
5. Merge results back to your branch

## How it works

```
/lazy-dev:run <brief>
  brief  →  planner (Opus)  →  spec + task breakdown
                             ↓
                    approval gate  (go / cancel)
                             ↓
       ┌── parallel fan-out (isolated worktrees) ──┐
       │  T-0001 code-small (Sonnet)               │
       │  T-0002 code-big (Opus)                   │
       │  T-0003 docs (Haiku)                      │
       └──── each verified by Ralph gate ──────────┘
                             ↓
                    reviewer (Opus)
                             ↓
                    merge --no-ff per task
                             ↓
                    integration test (if configured)
                             ↓
                    done
```

The **Ralph gate** is a hook that fires after every specialist stops. It parses the completion sentinel, runs verifiers (lint, test, scope check), and writes APPROVED/FAILED markers. Three strikes on the same task and the circuit breaker trips - no infinite loops.

## Configuration

Settings are merged in order, with later sources overriding earlier ones:

1. Plugin defaults (built-in)
2. `~/.claude/settings.json` under the `lazy-dev` key
3. `<project>/.claude/settings.json` under the `lazy-dev` key
4. `<project>/.lazy-dev/settings.json` (standalone, no nesting under a key)

Config is snapshotted at run start. Mid-run edits to any source do not affect an active run.

```jsonc
{
  "parallelism": { "max_parallel": 3 },
  "ralph": { "max_iter": 3 },
  "budget": {
    "per_task": { "max_input_tokens": 100000, "max_output_tokens": 20000 },
    "per_run": { "max_input_tokens": 400000, "max_output_tokens": 80000 },
    "warn_at_pct": 70
  },
  "safety": {
    "forbidden_paths_global": [".env", ".env.*", "**/*.pem", "**/*.key"]
  }
}
```

### Custom verifiers

Drop a shell script at `<project>/.lazy-dev/verifiers/<name>.sh` to override a built-in verifier. `<name>` must match the first token of the verifier command you want to replace (e.g., `lint.sh` overrides the built-in lint verifier). Your script runs with the worktree as cwd.

## Requirements

- [Claude Code](https://claude.com/claude-code) v2.1.100+
- [Bun](https://bun.sh) 1.3+
- Git (recommended; non-git projects use an rsync fallback)
- WSL Ubuntu or macOS (no Windows-native support yet)

## Contributing

MIT licensed. PRs welcome.

```bash
bun install
bun test
bun run lint
```
