#!/usr/bin/env node
// dispatch.js
//
// Materialises the state needed to dispatch a specialist for one task:
//   - ensures .lazy-dev/runs/<run-id>/tasks/<task-id>/envelope.json exists
//   - creates a git worktree for the task via worktree.sh
//   - returns the dispatch prompt text the wrangler passes to the Agent tool
//
// Importable (MCP) or runnable (CLI).
//
// CLI:
//   node src/orchestrator/dispatch.js <run-id> <task-id>

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withGitLock } from "../mcp/_git-lock.js";
import { atomicWrite, readJsonSafe } from "../mcp/_io.js";
import { withRunLock } from "../mcp/_lock.js";
import { requireSafeId } from "../mcp/_validation.js";

export function dispatch({ runId, taskId, projectDir }) {
	requireSafeId(runId, "run_id");
	requireSafeId(taskId, "task_id");

	const runDir = join(projectDir, ".lazy-dev", "runs", runId);

	// Read plan and validate under lock (fast — no subprocesses).
	const { task, deps } = withRunLock(runDir, () => {
		const tasksJsonPath = join(runDir, "tasks.json");
		if (!existsSync(tasksJsonPath)) {
			throw new Error(`tasks.json missing at ${tasksJsonPath}; planner must run first`);
		}
		const plan = readJsonSafe(tasksJsonPath);
		if (!plan) throw new Error(`tasks.json is corrupt or unreadable at ${tasksJsonPath}`);
		const t = plan.tasks?.find((t) => t.id === taskId);
		if (!t) throw new Error(`task ${taskId} not found in run state`);

		const d = t.depends_on || [];
		for (const depId of d) {
			if (!existsSync(join(runDir, "tasks", depId, "APPROVED"))) {
				throw new Error(
					`dependency ${depId} not approved; scheduler should not have released ${taskId}`,
				);
			}
		}
		return { task: t, deps: d };
	});

	const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || projectDir;

	// Git operations (dep merges + worktree creation) modify the main worktree.
	// Serialized via a project-level git lock to prevent concurrent dispatches
	// from colliding on git index/stash state.
	const worktreePath = withGitLock(projectDir, () => {
		for (const depId of deps) {
			try {
				execFileSync(
					"bash",
					[join(pluginRoot, "src/orchestrator/worktree.sh"), "merge", runId, depId],
					{
						encoding: "utf8",
						cwd: projectDir,
						stdio: ["ignore", "pipe", "pipe"],
						timeout: 10 * 60_000,
						maxBuffer: 10 * 1024 * 1024,
					},
				);
			} catch (err) {
				if (err.status === 3) {
					throw new Error(
						`cannot dispatch ${taskId}: merging dependency ${depId} produced conflicts — resolve first`,
					);
				}
				throw new Error(`failed to merge dependency ${depId}: ${err.message}`);
			}
		}

		return execFileSync(
			"bash",
			[join(pluginRoot, "src/orchestrator/worktree.sh"), "create", runId, taskId],
			{
				encoding: "utf8",
				cwd: projectDir,
				timeout: 2 * 60_000,
				maxBuffer: 1 * 1024 * 1024,
			},
		).trim();
	});

	// Write envelope under lock (fast — no subprocesses).
	return withRunLock(runDir, () => {
		const taskDir = join(runDir, "tasks", taskId);
		mkdirSync(taskDir, { recursive: true });
		const envelopePath = join(taskDir, "envelope.json");
		const dispatchedAt = new Date().toISOString();
		const sanitized = taskId.replace(/[^A-Za-z0-9_-]/g, "_");
		const worktreeBranch = `lazy-dev/${runId}/${sanitized}`;
		const envelopeBody = {
			...task,
			run_id: runId,
			task_id: taskId,
			worktree_path: worktreePath,
			worktree_branch: worktreeBranch,
			dispatched_at: dispatchedAt,
		};
		if (!existsSync(envelopePath)) {
			atomicWrite(envelopePath, JSON.stringify(envelopeBody, null, 2));
		} else {
			const existing = readJsonSafe(envelopePath);
			if (!existing) throw new Error(`envelope.json is corrupt or unreadable at ${envelopePath}`);
			const merged = {
				...existing,
				run_id: runId,
				task_id: taskId,
				worktree_path: worktreePath,
				dispatched_at: existing.dispatched_at || dispatchedAt,
				redispatched_at: existing.dispatched_at ? dispatchedAt : undefined,
			};
			atomicWrite(envelopePath, JSON.stringify(merged, null, 2));
		}

		rmSync(join(taskDir, "RETRY"), { force: true });

		const dispatchPrompt = `Envelope: ${envelopePath}\nWorktree: ${worktreePath}\n\nRead your envelope and execute your system-prompt contract. Include task_id in the sentinel.`;

		return {
			agent: task.agent,
			agent_namespaced: `lazy-dev:${task.agent}`,
			task_id: taskId,
			worktree: worktreePath,
			envelope_path: envelopePath,
			dispatch_prompt: dispatchPrompt,
		};
	});
}

// ── CLI entry ───────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const runId = process.argv[2];
	const taskId = process.argv[3];
	if (!runId || !taskId) {
		console.log(JSON.stringify({ ok: false, detail: "usage: dispatch.js <run-id> <task-id>" }));
		process.exit(0);
	}
	try {
		const result = dispatch({ runId, taskId, projectDir });
		console.log(JSON.stringify({ ok: true, ...result }));
	} catch (err) {
		console.log(JSON.stringify({ ok: false, detail: err.message }));
	}
}
