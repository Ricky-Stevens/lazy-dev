// gate-resolve.js — task resolution and scope checking for the Ralph gate.
//
// Extracted from gate.js to keep file sizes manageable.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getBunGlob } from "./bun-glob.js";
import { cheapHash } from "./hash.js";

// Strategy 1: specialist includes task_id in the sentinel body.
export function resolveFromSentinel(projectDir, parsed) {
	if (parsed.kind !== "completed" || !parsed.body?.task_id) return null;
	const taskId = parsed.body.task_id;
	if (typeof taskId !== "string" || !/^[\w.:-]+$/.test(taskId)) return null;
	const runsDir = join(projectDir, ".lazy-dev", "runs");
	if (!existsSync(runsDir)) return null;
	const entries = readdirSync(runsDir)
		.filter((e) => !e.startsWith("_"))
		.map((e) => ({ e, mt: statSync(join(runsDir, e)).mtimeMs }))
		.sort((a, b) => b.mt - a.mt);
	for (const { e } of entries) {
		const envPath = join(runsDir, e, "tasks", taskId, "envelope.json");
		if (existsSync(envPath)) return { runId: e, taskId };
	}
	return null;
}

// Strategy 2: extract from worktree cwd path. Only fires when the cwd
// literally contains the worktrees marker.
export function resolveTaskFromCwd(projectDir, cwd) {
	const marker = "/.lazy-dev/worktrees/";
	const idx = cwd.indexOf(marker);
	if (idx === -1) return null;

	const afterMarker = cwd.slice(idx + marker.length);
	const parts = afterMarker.split("/").filter(Boolean);
	if (parts.length < 2) return null;

	const runId = parts[0];
	const taskDirName = parts[1];
	const lastDash = taskDirName.lastIndexOf("-");
	const taskId = lastDash > 0 ? taskDirName.slice(0, lastDash) : taskDirName;

	const envelopePath = join(
		projectDir,
		".lazy-dev",
		"runs",
		runId,
		"tasks",
		taskId,
		"envelope.json",
	);
	if (!existsSync(envelopePath)) {
		const altPath = join(
			projectDir,
			".lazy-dev",
			"runs",
			runId,
			"tasks",
			taskDirName,
			"envelope.json",
		);
		if (existsSync(altPath)) return { runId, taskId: taskDirName };
		return null;
	}
	return { runId, taskId };
}

// Convention-based worktree path derivation — fallback when the envelope
// is missing worktree_path (legacy envelopes).
export function deriveWorktreePath(projectDir, runId, taskId) {
	const runWorktrees = join(projectDir, ".lazy-dev", "worktrees", runId);
	if (!existsSync(runWorktrees)) return null;
	try {
		for (const entry of readdirSync(runWorktrees)) {
			if (entry === taskId || entry.startsWith(`${taskId}-`)) {
				return join(runWorktrees, entry);
			}
		}
	} catch {
		// Worktree dir may not exist or may be unreadable.
	}
	return null;
}

// Most-recently-modified run dir. Used for attributing per-run agent
// usage (planner/reviewer) when the sentinel has no task_id.
export function findMostRecentRun(projectDir) {
	const runsDir = join(projectDir, ".lazy-dev", "runs");
	if (!existsSync(runsDir)) return null;
	try {
		const entries = readdirSync(runsDir)
			.filter((e) => !e.startsWith("_"))
			.map((e) => ({ e, mt: statSync(join(runsDir, e)).mtimeMs }))
			.sort((a, b) => b.mt - a.mt);
		return entries[0]?.e || null;
	} catch {
		return null;
	}
}

export function resolveBaseRef(worktree, envelope) {
	if (envelope?.worktree_branch) {
		const branch = String(envelope.worktree_branch);
		if (/^[a-zA-Z0-9_./~^@{}-]+$/.test(branch)) {
			try {
				return execFileSync("git", ["rev-parse", `${branch}^`], {
					cwd: worktree,
					encoding: "utf8",
					timeout: 30_000,
				}).trim();
			} catch {
				// Branch ref parse failure; fall through to merge-base.
			}
		}
	}
	try {
		return execFileSync("git", ["merge-base", "HEAD", "@{upstream}"], {
			cwd: worktree,
			encoding: "utf8",
			timeout: 30_000,
		}).trim();
	} catch {
		try {
			return execFileSync("git", ["rev-parse", "HEAD~1"], {
				cwd: worktree,
				encoding: "utf8",
				timeout: 30_000,
			}).trim();
		} catch {
			return null;
		}
	}
}

// Checks changed files against allowed_paths globs. Returns
// { diffHash, violation: string[]|null }.
export function checkScope(worktree, gitBaseRef, allowedPaths) {
	if (!gitBaseRef) return { diffHash: null, violation: null };
	try {
		const diffOut = execFileSync("git", ["diff", `${gitBaseRef}...HEAD`], {
			cwd: worktree,
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 10 * 1024 * 1024,
		});
		const diffHash = cheapHash(diffOut);

		if (allowedPaths.length === 0) return { diffHash, violation: null };

		const changedFiles = execFileSync("git", ["diff", "--name-only", `${gitBaseRef}...HEAD`], {
			cwd: worktree,
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 10 * 1024 * 1024,
		})
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);

		if (changedFiles.length > 0) {
			const G = getBunGlob();
			const allowed = allowedPaths.map((p) => new G(p));
			const outside = changedFiles.filter((f) => !allowed.some((g) => g.match(f)));
			if (outside.length > 0) return { diffHash, violation: outside };
		}
		return { diffHash, violation: null };
	} catch {
		return { diffHash: null, violation: null };
	}
}
