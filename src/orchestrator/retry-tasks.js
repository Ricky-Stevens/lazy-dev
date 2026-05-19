#!/usr/bin/env node
// retry-tasks.js
// Resets one or more tasks for re-dispatch after a reviewer CHANGES_REQUESTED verdict.
//
// For each task:
//   - Extracts per-task reviewer notes from review.md
//   - Patches envelope.json with a reviewer_notes field
//   - Removes APPROVED marker and state.json
//   - Writes a RETRY marker
// Then:
//   - Archives review.md → review-prev.md
//   - Resets status.json phase to "specialists"
//
// CLI:
//   node src/orchestrator/retry-tasks.js <run-id> <task-id> [<task-id> ...]

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readJsonBounded } from "../mcp/_io.js";
import { withRunLock } from "../mcp/_lock.js";
import { JSON_MAX_BYTES, requireSafeId, requireSafeIdArray } from "../mcp/_validation.js";

export function retryTasks({ runId, taskIds, projectDir }) {
	requireSafeId(runId, "run_id");
	requireSafeIdArray(taskIds, "task_ids");

	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	return withRunLock(runDir, () => {
		const reviewMdPath = join(runDir, "review.md");
		const perTaskNotes = existsSync(reviewMdPath)
			? parsePerTaskNotes(readFileSync(reviewMdPath, "utf8"))
			: {};

		const reset = [];
		for (const taskId of taskIds) {
			const taskDir = join(runDir, "tasks", taskId);
			const envelopePath = join(taskDir, "envelope.json");
			if (!existsSync(envelopePath)) {
				throw new Error(`envelope missing for task ${taskId}`);
			}
			const envelope = readJsonBounded(envelopePath, JSON_MAX_BYTES);
			if (envelope === null) {
				throw new Error(`envelope missing or unreadable for task ${taskId}`);
			}
			envelope.reviewer_notes =
				perTaskNotes[taskId] || "See review.md for reviewer findings on this task.";
			atomicWrite(envelopePath, JSON.stringify(envelope, null, 2));

			rmSync(join(taskDir, "APPROVED"), { force: true });
			rmSync(join(taskDir, "FAILED"), { force: true });
			rmSync(join(taskDir, "state.json"), { force: true });
			rmSync(join(taskDir, "state.json.lock"), { force: true });

			writeFileSync(
				join(taskDir, "RETRY"),
				JSON.stringify({
					at: new Date().toISOString(),
					reason: perTaskNotes[taskId] ? "reviewer_changes_requested" : "user_retry",
				}),
			);
			reset.push(taskId);
		}

		if (existsSync(reviewMdPath)) {
			try {
				renameSync(reviewMdPath, join(runDir, "review-prev.md"));
			} catch {}
		}

		const statusPath = join(runDir, "status.json");
		const status = readJsonBounded(statusPath, JSON_MAX_BYTES) ?? {};
		status.phase = "specialists";
		atomicWrite(statusPath, JSON.stringify(status, null, 2));

		return { reset };
	});
}

function parsePerTaskNotes(md) {
	const notes = {};
	const parts = md.split(/^(?=##\s+T-\d{4,})/m);
	for (const part of parts) {
		const m = part.match(/^##\s+(T-\d{4,})/);
		if (m) notes[m[1]] = part.slice(m[0].length).trim();
	}
	return notes;
}

// ── CLI entry ───────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	const runId = process.argv[2];
	const taskIds = process.argv.slice(3);
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	if (!runId || taskIds.length === 0) {
		console.log(
			JSON.stringify({ ok: false, detail: "usage: retry-tasks.js <run-id> <task-id> [...]" }),
		);
		process.exit(0);
	}
	try {
		const result = retryTasks({ runId, taskIds, projectDir });
		console.log(JSON.stringify({ ok: true, ...result }));
	} catch (err) {
		console.log(JSON.stringify({ ok: false, detail: err.message }));
	}
}
