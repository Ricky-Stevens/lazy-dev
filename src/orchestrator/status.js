#!/usr/bin/env node
// status.js — compact run-status dump.
// Importable (MCP) or runnable (CLI).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJsonSafe } from "../mcp/_io.js";
import { requireSafeId, STATUS_MAX_RUNS } from "../mcp/_validation.js";
import { readUsage } from "../ralph/usage.js";

export function statusForRun({ runId, projectDir }) {
	requireSafeId(runId, "run_id");
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	if (!existsSync(runDir)) throw new Error(`run ${runId} not found`);

	const status = readJsonSafe(join(runDir, "status.json")) || { phase: "unknown" };
	const tasksDir = join(runDir, "tasks");
	let approved = 0;
	let failed = 0;
	let running = 0;
	const failedTasks = [];
	if (existsSync(tasksDir)) {
		for (const tid of readdirSync(tasksDir)) {
			const td = join(tasksDir, tid);
			if (existsSync(join(td, "APPROVED"))) {
				approved++;
			} else if (existsSync(join(td, "FAILED"))) {
				failed++;
				try {
					const f = JSON.parse(readFileSync(join(td, "FAILED"), "utf8"));
					failedTasks.push({ id: tid, reason: f.reason, detail: f.details });
				} catch {
					failedTasks.push({ id: tid, reason: "unknown" });
				}
			} else if (existsSync(join(td, "envelope.json"))) {
				running++;
			}
		}
	}

	const worktreeDir = join(projectDir, ".lazy-dev", "worktrees", runId);
	const worktrees = existsSync(worktreeDir) ? readdirSync(worktreeDir).length : 0;
	const usage = readUsage(projectDir, runId);

	return {
		run_id: runId,
		phase: status.phase,
		tasks: { approved, failed, running },
		failed_tasks: failedTasks,
		worktrees,
		usage: {
			input_tokens: usage.totals.input_tokens,
			output_tokens: usage.totals.output_tokens,
			by_agent: Object.fromEntries(
				Object.entries(usage.by_agent).map(([k, v]) => [
					k,
					{ calls: v.calls, input: v.input_tokens, output: v.output_tokens },
				]),
			),
		},
	};
}

export function listRuns({ projectDir }) {
	const runsDir = join(projectDir, ".lazy-dev", "runs");
	if (!existsSync(runsDir)) return { runs: [] };
	const entries = readdirSync(runsDir)
		.filter((e) => !e.startsWith("_"))
		.map((e) => ({ e, mt: statSync(join(runsDir, e)).mtimeMs }))
		.sort((a, b) => b.mt - a.mt)
		.slice(0, STATUS_MAX_RUNS);

	const runs = entries.map(({ e }) => {
		const status = readJsonSafe(join(runsDir, e, "status.json")) || {};
		return {
			run_id: e,
			phase: status.phase || "unknown",
			review_pass: status.review_pass || 0,
			integration_test: status.integration_test || null,
		};
	});
	return { runs };
}

// ── CLI entry ───────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const runId = process.argv[2];
	try {
		if (runId) {
			const result = statusForRun({ runId, projectDir });
			console.log(JSON.stringify({ ok: true, ...result }));
		} else {
			const result = listRuns({ projectDir });
			console.log(JSON.stringify({ ok: true, ...result }));
		}
	} catch (err) {
		console.log(JSON.stringify({ ok: false, detail: err.message }));
	}
}
