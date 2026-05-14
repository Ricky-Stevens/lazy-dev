#!/usr/bin/env node
// merge-conflicts.js
//
// Orchestrates per-file merger dispatches when `git merge` conflicts.
//
// Importable (MCP) or runnable (CLI).
//
// CLI:
//   node src/orchestrator/merge-conflicts.js prepare <run-id> <task-id>
//     (reads conflict file list on stdin)
//   node src/orchestrator/merge-conflicts.js envelope <run-id> <merge-id>
//     (prints dispatch info for one merger invocation)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readJsonSafe } from "../mcp/_io.js";
import { withRunLock } from "../mcp/_lock.js";
import { requireSafeId } from "../mcp/_validation.js";

export function mergerPrepare({ runId, taskId, conflictedFiles, projectDir }) {
	requireSafeId(runId, "run_id");
	requireSafeId(taskId, "task_id");
	if (!Array.isArray(conflictedFiles) || conflictedFiles.length === 0) {
		throw new Error("conflicted_files must be a non-empty array");
	}
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	return withRunLock(runDir, () =>
		mergerPrepareLocked({ runId, taskId, conflictedFiles, projectDir }),
	);
}

// Lock-free inner for callers that already hold the run lock (e.g. plan_next's
// mergePhase calls mergerPrepare after a conflicting merge; re-acquiring would
// deadlock because the advisory lock is not re-entrant).
export function mergerPrepareLocked({ runId, taskId, conflictedFiles, projectDir }) {
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	const tasksJsonPath = join(runDir, "tasks.json");
	if (!existsSync(tasksJsonPath)) {
		throw new Error(`tasks.json missing at ${tasksJsonPath}`);
	}
	const plan = readJsonSafe(tasksJsonPath);
	if (!plan) throw new Error(`tasks.json is corrupt or unreadable at ${tasksJsonPath}`);
	const tasks = plan?.tasks || [];
	const incomingTask = tasks.find((t) => t.id === taskId);
	const branch = `lazy-dev/${runId}/${taskId}`;

	const mergesDir = join(runDir, "merges");
	mkdirSync(mergesDir, { recursive: true });

	const existingMax = readdirSync(mergesDir).reduce((max, name) => {
		const m = /^M-(\d{4})-/.exec(name);
		if (!m) return max;
		const n = Number.parseInt(m[1], 10);
		return n > max ? n : max;
	}, 0);

	const mergeIds = [];
	for (let i = 0; i < conflictedFiles.length; i++) {
		const mergeId = `M-${String(existingMax + i + 1).padStart(4, "0")}-${taskId}`;
		const mdir = join(mergesDir, mergeId);
		mkdirSync(mdir, { recursive: true });
		const envelope = {
			id: mergeId,
			task_id: mergeId,
			run_id: runId,
			title: `Resolve merge conflict in ${conflictedFiles[i]}`,
			agent: "merger",
			file: conflictedFiles[i],
			base_branch: detectDefaultBranch(projectDir),
			incoming_branch: branch,
			current_branch: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
				cwd: projectDir,
				encoding: "utf8",
				timeout: 10_000,
			}).trim(),
			context: {
				master_spec: join(runDir, "master-spec.md"),
				related_task_id: taskId,
				related_task_title: incomingTask?.title || "",
			},
			scope: { allowed_paths: [conflictedFiles[i]] },
			completion_criteria: [
				{
					id: "no_conflict_markers",
					kind: "grep",
					pattern: "^(<{7}|={7}|>{7})",
					in_file: conflictedFiles[i],
					must_match: false,
				},
				{ id: "file_exists_after", kind: "file_exists", path: conflictedFiles[i] },
			],
			budget: { max_iter: 2 },
			no_change_policy: { same_diff_twice: "stop", same_failure_twice: "stop" },
			dispatched_at: new Date().toISOString(),
		};
		atomicWrite(join(mdir, "envelope.json"), JSON.stringify(envelope, null, 2));
		mergeIds.push(mergeId);
	}
	return { merge_ids: mergeIds };
}

export function mergerEnvelope({ runId, mergeId, projectDir }) {
	requireSafeId(runId, "run_id");
	requireSafeId(mergeId, "merge_id");
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	const envPath = join(runDir, "merges", mergeId, "envelope.json");
	if (!existsSync(envPath)) throw new Error(`merge envelope missing: ${envPath}`);
	return {
		agent_namespaced: "lazy-dev:merger",
		envelope_path: envPath,
		dispatch_prompt: `Envelope: ${envPath}\n\nRead the envelope, read the master-spec, resolve the single conflicted file, end with the sentinel.`,
	};
}

function detectDefaultBranch(dir) {
	for (const attempt of [
		() =>
			execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
				cwd: dir,
				encoding: "utf8",
				timeout: 5_000,
			})
				.trim()
				.replace(/^origin\//, ""),
		() =>
			execFileSync("git", ["config", "init.defaultBranch"], {
				cwd: dir,
				encoding: "utf8",
				timeout: 5_000,
			}).trim(),
	]) {
		try {
			const r = attempt();
			if (r) return r;
		} catch {}
	}
	return "main";
}

function readStdin() {
	return new Promise((resolve) => {
		let buf = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (d) => {
			buf += d;
		});
		process.stdin.on("end", () => resolve(buf));
	});
}

// ── CLI entry ───────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	const mode = process.argv[2];
	const runId = process.argv[3];
	const arg2 = process.argv[4];
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

	(async () => {
		try {
			if (mode === "prepare") {
				if (!runId || !arg2) {
					console.log(JSON.stringify({ ok: false, detail: "usage: prepare <run-id> <task-id>" }));
					return;
				}
				const conflictText = await readStdin();
				const conflictedFiles = conflictText
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean);
				const result = mergerPrepare({ runId, taskId: arg2, conflictedFiles, projectDir });
				console.log(JSON.stringify({ ok: true, ...result }));
			} else if (mode === "envelope") {
				if (!runId || !arg2) {
					console.log(JSON.stringify({ ok: false, detail: "usage: envelope <run-id> <merge-id>" }));
					return;
				}
				const result = mergerEnvelope({ runId, mergeId: arg2, projectDir });
				console.log(JSON.stringify({ ok: true, ...result }));
			} else {
				console.log(JSON.stringify({ ok: false, detail: "unknown mode" }));
			}
		} catch (err) {
			console.log(JSON.stringify({ ok: false, detail: err.message }));
		}
	})();
}
