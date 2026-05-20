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
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { withGitLock } from "../mcp/_git-lock.js";
import { atomicWrite, readJsonSafe } from "../mcp/_io.js";
import { withRunLock } from "../mcp/_lock.js";
import { requireSafeId } from "../mcp/_validation.js";

function resolveAgentMeta(agentName, fallbackRoot) {
	const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || fallbackRoot || process.cwd();
	const agentFile = join(pluginRoot, "agents", `${agentName}.md`);
	try {
		const content = readFileSync(agentFile, "utf8");
		let model = null;
		const mm = content.match(/^model:\s*(.+)$/m);
		if (mm) {
			const full = mm[1].trim();
			if (full.includes("opus")) model = "opus";
			else if (full.includes("sonnet")) model = "sonnet";
			else if (full.includes("haiku")) model = "haiku";
		}
		let effort = null;
		const em = content.match(/^effort:\s*(.+)$/m);
		if (em) effort = em[1].trim();
		return { model, effort };
	} catch {
		return { model: null, effort: null };
	}
}

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

	// On re-dispatch (retry), collect stale worktree/branch info for cleanup.
	// Actual cleanup happens inside withGitLock to prevent races with concurrent merges.
	const isRedispatch = existsSync(join(runDir, "tasks", taskId, "envelope.json"));
	let staleWorktree = null;
	let staleBranch = null;
	if (isRedispatch) {
		const prevEnvelope = readJsonSafe(join(runDir, "tasks", taskId, "envelope.json"));
		const oldWorktree = prevEnvelope?.worktree_path;
		const oldBranch = prevEnvelope?.worktree_branch;
		const lazyDevPrefix = resolve(join(projectDir, ".lazy-dev"));
		if (
			oldWorktree &&
			oldWorktree !== projectDir &&
			resolve(oldWorktree).startsWith(lazyDevPrefix) &&
			existsSync(oldWorktree)
		) {
			staleWorktree = oldWorktree;
		}
		if (oldBranch && /^[a-zA-Z0-9_./~^@{}-]+$/.test(oldBranch)) {
			staleBranch = oldBranch;
		}
	}

	// git_init tasks run directly in the project directory — no worktree
	// creation (git doesn't exist yet, that's the whole point of the task).
	const isGitInit = !!task.git_init;
	const worktreePath = isGitInit
		? projectDir
		: withGitLock(projectDir, () => {
				// Clean up stale worktree + branch inside the git lock to prevent
				// races with concurrent merge operations.
				if (staleWorktree) {
					try {
						execFileSync("git", ["worktree", "remove", "--force", staleWorktree], {
							cwd: projectDir,
							stdio: ["ignore", "pipe", "pipe"],
							timeout: 30_000,
						});
					} catch {
						rmSync(staleWorktree, { recursive: true, force: true });
						try {
							execFileSync("git", ["worktree", "prune"], {
								cwd: projectDir,
								stdio: "ignore",
								timeout: 10_000,
							});
						} catch {}
					}
				}
				if (staleBranch) {
					try {
						execFileSync("git", ["branch", "-D", staleBranch], {
							cwd: projectDir,
							stdio: ["ignore", "pipe", "pipe"],
							timeout: 10_000,
						});
					} catch {}
				}

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
							const conflictFiles = (err.stdout || "")
								.split("\n")
								.map((l) => l.trim())
								.filter(Boolean);
							try {
								execFileSync("git", ["merge", "--abort"], {
									cwd: projectDir,
									stdio: "ignore",
									timeout: 10_000,
								});
							} catch {
								try {
									execFileSync("git", ["reset", "--hard", "HEAD"], {
										cwd: projectDir,
										stdio: "ignore",
										timeout: 10_000,
									});
								} catch {}
							}
							throw Object.assign(
								new Error(
									`cannot dispatch ${taskId}: merging dependency ${depId} produced conflicts in: ${conflictFiles.join(", ")}. Resolve the conflicts in your main branch (between ${depId}'s changes and current state), then retry the dispatch.`,
								),
								{
									dep_conflict: true,
									dep_id: depId,
									task_id: taskId,
									conflicted_files: conflictFiles,
								},
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
		const worktreeBranch = isGitInit ? undefined : `lazy-dev/${runId}/${sanitized}`;
		const envelopeBody = {
			...task,
			run_id: runId,
			task_id: taskId,
			worktree_path: worktreePath,
			...(worktreeBranch ? { worktree_branch: worktreeBranch } : {}),
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
		rmSync(join(taskDir, "DISPATCHING"), { force: true });

		const { model, effort: fileEffort } = resolveAgentMeta(task.agent, pluginRoot);
		const effort = task.effort || fileEffort;
		const effortHints = {
			low: " — move fast, this is mechanical work.",
			medium: ".",
			high: " — reason carefully, check edge cases.",
			max: " — this is architecturally critical. Take all the time you need.",
		};
		const effortLine = effort ? `\nEffort: ${effort}${effortHints[effort] || "."}` : "";
		const envelope = readJsonSafe(envelopePath);
		const retryLine = envelope?.reviewer_notes
			? "\n\nThis is a RETRY. Your envelope contains reviewer_notes with specific feedback from the previous review. Read reviewer_notes before starting work."
			: "";
		const dispatchPrompt =
			`Envelope: ${envelopePath}\nWorktree: ${worktreePath}${effortLine}${retryLine}` +
			"\n\nRead your envelope and execute your system-prompt contract. Include task_id in the sentinel.";
		return {
			agent: task.agent,
			agent_namespaced: `lazy-dev:${task.agent}`,
			model,
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
