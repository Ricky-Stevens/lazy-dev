---
description: Show active run state.
---

Call `mcp__lazy-dev__status({})`.

Every `mcp__lazy-dev__*` response is `{ schema_version, ok, ...payload-or-error }`. On `ok: false`, print the `error` field and stop.

On success the payload is `{ runs: [{ run_id, phase, review_pass, integration_test }, ...] }` (newest-first).

- If `runs` is empty, print `"No runs. Start one with /lazy-dev:run <task>."`
- Otherwise print one line per run: `<run_id> — phase=<phase>, review_pass=<n>, integration=<pass|fail|skipped|n/a>`.
