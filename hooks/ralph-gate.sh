#!/usr/bin/env bash
# ralph-gate.sh — thin wrapper that pipes SubagentStop payload to gate.js.
#
# Claude Code hooks use bash as the command entrypoint. This wrapper resolves
# the plugin root from the env and exec's bun against gate.js. gate.js
# requires Bun for Bun.Glob support.

set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$PLUGIN_ROOT" ]; then
  echo "error: CLAUDE_PLUGIN_ROOT not set" >&2
  exit 0  # never exit non-zero from a hook
fi

# Pipe stdin (the payload JSON) directly to gate.js.
# gate.js handles its own payload logging internally.
exec bun "${PLUGIN_ROOT}/src/ralph/gate.js"
