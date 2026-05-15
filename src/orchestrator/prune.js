#!/usr/bin/env node
// prune.js
// Clean up a completed run's worktrees and branches. Preserves the run dir
// (for forensics / usage.json / review.md reference); only removes the
// per-task git worktrees and the lazy-dev/<run>/* branches created for it.
//
// Importable (MCP) or runnable (CLI).
//
// CLI:
//   node src/orchestrator/prune.js <run-id>

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { withRunLock } from "../mcp/_lock.js";
import { requireSafeId } from "../mcp/_validation.js";

// Core cleanup logic — no lock, no phase guard.
// Called directly by auto-cleanup (which already holds the run lock) and
// indirectly by the public prune() wrapper.
export function pruneCore({ runId, projectDir }) {
	requireSafeId(runId, "run_id");
	const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || projectDir;
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);

	const worktreesRemoved = [];
	const worktreesFailed = [];
	const worktreesDir = join(projectDir, ".lazy-dev", "worktrees", runId);
	if (existsSync(worktreesDir)) {
		for (const entry of readdirSync(worktreesDir)) {
			const lastDash = entry.lastIndexOf("-");
			const taskId = lastDash > 0 ? entry.slice(0, lastDash) : entry;
			try {
				execFileSync(
					"bash",
					[join(pluginRoot, "src/orchestrator/worktree.sh"), "remove", runId, taskId],
					{ cwd: projectDir, encoding: "utf8", timeout: 30_000 },
				);
				worktreesRemoved.push(entry);
			} catch (err) {
				worktreesFailed.push({ entry, reason: err.message });
			}
		}
	}

	// Remove the now-empty run-level worktree directory.
	if (existsSync(worktreesDir) && readdirSync(worktreesDir).length === 0) {
		try {
			rmdirSync(worktreesDir);
		} catch {}
	}

	// Clean up stale .git/worktrees/ entries left by manually-deleted worktrees.
	try {
		execFileSync("git", ["-C", projectDir, "worktree", "prune"], {
			encoding: "utf8",
			timeout: 10_000,
		});
	} catch {}

	const branchesRemoved = [];
	const branchesFailed = [];
	try {
		const out = execFileSync("git", ["-C", projectDir, "branch", "--list", `lazy-dev/${runId}/*`], {
			encoding: "utf8",
			timeout: 10_000,
		});
		const branches = out
			.split("\n")
			.map((b) => b.replace(/^\s*\*?\s*/, "").trim())
			.filter(Boolean);
		for (const b of branches) {
			try {
				execFileSync("git", ["-C", projectDir, "branch", "-D", b], {
					encoding: "utf8",
					timeout: 10_000,
				});
				branchesRemoved.push(b);
			} catch (err) {
				branchesFailed.push({ branch: b, reason: err.message });
			}
		}
	} catch {
		// Not a git repo or git unavailable — silently skip branch cleanup.
	}

	return {
		run_id: runId,
		worktrees_removed: worktreesRemoved,
		worktrees_failed: worktreesFailed,
		branches_removed: branchesRemoved,
		branches_failed: branchesFailed,
		run_dir_preserved: runDir,
	};
}

export function prune({ runId, projectDir }) {
	requireSafeId(runId, "run_id");
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	if (!existsSync(runDir)) throw new Error(`run ${runId} not found at ${runDir}`);

	const runStatus = readRunPhase(runDir);
	if (runStatus && runStatus !== "done" && runStatus !== "cancelled") {
		throw new Error(
			`refusing to prune: run phase is ${runStatus}. Cancel first (mcp__lazy-dev__cancel) if you want to abort.`,
		);
	}

	return withRunLock(runDir, () => pruneCore({ runId, projectDir }));
}

function readRunPhase(runDir) {
	const statusPath = join(runDir, "status.json");
	if (!existsSync(statusPath)) return null;
	try {
		return JSON.parse(readFileSync(statusPath, "utf8"))?.phase || null;
	} catch {
		return null;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const runId = process.argv[2];
	if (!runId) {
		console.log(JSON.stringify({ ok: false, detail: "usage: prune.js <run-id>" }));
		process.exit(0);
	}
	try {
		const result = prune({ runId, projectDir });
		console.log(JSON.stringify({ ok: true, ...result }));
	} catch (err) {
		console.log(JSON.stringify({ ok: false, detail: err.message }));
	}
}
