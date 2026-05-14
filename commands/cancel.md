---
description: Cancel the active lazy-dev run.
argument-hint: [run-id]
---

Cancel a lazy-dev run.

- If `$ARGUMENTS` is a single run_id token, call `mcp__lazy-dev__cancel({ run_id: "$ARGUMENTS" })`.
- If `$ARGUMENTS` is empty:
  1. Call `mcp__lazy-dev__status({})` to list recent runs (sorted newest-first).
  2. If `runs` is empty, print `"No runs to cancel."` and stop.
  3. Otherwise call `mcp__lazy-dev__cancel({ run_id: runs[0].run_id })`.
- If `$ARGUMENTS` looks unlike a run id (contains spaces or other unusual shape), call `mcp__lazy-dev__status({})`, print the list, and ask the user which run to cancel.

Every `mcp__lazy-dev__*` response is `{ schema_version, ok, ...payload-or-error }` — check `ok` first; on `ok: false`, print `error` and stop.

On success print: `"Run <run_id> cancelled (was <prev_phase>)."`
