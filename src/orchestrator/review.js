#!/usr/bin/env node
// review.js
//
// Builds the review envelope for the reviewer dispatch, and (on a second call)
// parses review.md for the verdict.
//
// Importable (MCP) or runnable (CLI).
//
// CLI:
//   node src/orchestrator/review.js build   <run-id>
//   node src/orchestrator/review.js verdict <run-id>

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { atomicWrite, IOError, readJsonBounded } from "../mcp/_io.js";
import { JSON_MAX_BYTES, requireSafeId } from "../mcp/_validation.js";
import { parsePerTaskVerdicts } from "../shared/parse-verdicts.js";

// Canonical effort ladder for the reviewer. Bare `lazy-dev:reviewer` is "high"
// (current default); xhigh/max are variants. No 'medium' for reviewer — review
// is a security/spec gate and we don't want to under-resource it.
export const REVIEWER_EFFORTS = new Set(["high", "xhigh", "max"]);

export function reviewBuild({ runId, projectDir, effort = "high" }) {
	requireSafeId(runId, "run_id");
	if (!REVIEWER_EFFORTS.has(effort)) {
		throw new Error(
			`unknown reviewer effort: ${effort}. Pick one of ${Array.from(REVIEWER_EFFORTS).join(", ")}.`,
		);
	}
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);

	const tasksJsonPath = join(runDir, "tasks.json");
	if (!existsSync(tasksJsonPath)) {
		throw new Error(`tasks.json missing at ${tasksJsonPath}`);
	}
	const tasksJson = readJsonBounded(tasksJsonPath, JSON_MAX_BYTES);
	if (tasksJson === null) {
		throw new IOError(`tasks.json missing or unreadable at ${tasksJsonPath}`);
	}
	const tasks = tasksJson?.tasks || [];
	const gitAvailable = isGitRepo(projectDir);
	const tasksWithDiffs = [];
	for (const t of tasks) {
		const worktreePath = findWorktreePath(projectDir, runId, t.id);
		const diffPatch = join(runDir, "tasks", t.id, "diff.patch");
		if (worktreePath) {
			writeDiffPatch(worktreePath, diffPatch, gitAvailable);
		}
		const sentinelPath = findSentinelPath(runDir, t.id);
		const sentinelSummary = sentinelPath ? readSentinelSummary(sentinelPath) : null;
		tasksWithDiffs.push({
			id: t.id,
			agent: t.agent,
			title: t.title || t.goal || "",
			diff_patch: diffPatch,
			sentinel_summary: sentinelSummary,
			worktree_path: worktreePath,
		});
	}

	const prevReviewPath = join(runDir, "review-prev.md");
	const isRetry = existsSync(prevReviewPath);

	const envelope = {
		run_id: runId,
		master_spec: join(runDir, "master-spec.md"),
		tasks_json: join(runDir, "tasks.json"),
		tasks: tasksWithDiffs,
		previous_review: isRetry ? prevReviewPath : null,
	};
	const envPath = join(runDir, "review-envelope.json");
	atomicWrite(envPath, JSON.stringify(envelope, null, 2));

	const retryLine = isRetry
		? ` This is a retry pass — read ${prevReviewPath} first, then verify each prior CHANGES_REQUESTED item is addressed. If a concern persists, restate it concisely; do not re-explain full context.`
		: "";

	const agentNamespaced = effort === "high" ? "lazy-dev:reviewer" : `lazy-dev:reviewer-${effort}`;

	return {
		agent_namespaced: agentNamespaced,
		effort,
		envelope_path: envPath,
		dispatch_prompt:
			`Envelope: ${envPath}\n\n` +
			`Read the envelope, the master-spec, and each task's diff_patch. Follow the reviewer rubric. Write review.md at .lazy-dev/runs/${runId}/review.md and end with the sentinel.${retryLine}`,
		retry: isRetry,
	};
}

export function reviewVerdict({ runId, projectDir }) {
	requireSafeId(runId, "run_id");
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	const path = join(runDir, "review.md");
	if (!existsSync(path)) throw new Error("review.md missing");
	const md = readFileSync(path, "utf8");
	const vm = md.match(/^\*\*Verdict:\*\*\s*(PASS_ALL|CHANGES_REQUESTED|BLOCK)/im);
	if (!vm) throw new Error("could not parse Verdict line");
	const per_task = parsePerTaskVerdicts(md);
	return { verdict: vm[1].toUpperCase(), per_task };
}

function resolveBaseRef(worktreePath) {
	// HEAD~1 is the reliable base for worktrees (no upstream configured).
	try {
		return execFileSync("git", ["rev-parse", "HEAD~1"], {
			cwd: worktreePath,
			encoding: "utf8",
			timeout: 10_000,
		}).trim();
	} catch {
		return null;
	}
}

function writeDiffPatch(worktreePath, diffPatch, gitAvailable) {
	try {
		if (gitAvailable) {
			const baseRef = resolveBaseRef(worktreePath);
			const diffArgs = baseRef ? ["diff", `${baseRef}...HEAD`] : ["diff", "HEAD~1...HEAD"];
			const diff = execFileSync("git", diffArgs, {
				cwd: worktreePath,
				encoding: "utf8",
				timeout: 60_000,
				maxBuffer: 10 * 1024 * 1024,
			});
			writeFileSync(diffPatch, diff);
		} else {
			const files = listWorktreeFiles(worktreePath);
			writeFileSync(
				diffPatch,
				`# Non-git worktree — file listing (read files directly for content)\n${files.join("\n")}\n`,
			);
		}
	} catch {
		writeFileSync(diffPatch, "");
	}
}

function findWorktreePath(projectDir, runId, taskId) {
	const wroot = join(projectDir, ".lazy-dev", "worktrees", runId);
	if (!existsSync(wroot)) return null;
	const entries = readdirSync(wroot);
	const match = entries.find((e) => e.startsWith(`${taskId}-`) || e === taskId);
	return match ? join(wroot, match) : null;
}

function findSentinelPath(runDir, taskId) {
	const approved = join(runDir, "tasks", taskId, "APPROVED");
	if (existsSync(approved)) return approved;
	return null;
}

function readSentinelSummary(approvedPath) {
	try {
		const raw = JSON.parse(readFileSync(approvedPath, "utf8"));
		return raw?.sentinel?.summary || null;
	} catch {
		return null;
	}
}

function isGitRepo(dir) {
	try {
		execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}

function listWorktreeFiles(dir) {
	const results = [];
	function walk(d) {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (
				e.name === "node_modules" ||
				e.name === ".lazy-dev" ||
				e.name === ".git" ||
				e.name.startsWith(".lazy-dev-")
			)
				continue;
			const full = join(d, e.name);
			if (e.isDirectory()) walk(full);
			else results.push(relative(dir, full));
		}
	}
	walk(dir);
	return results;
}

// ── CLI entry ───────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	const mode = process.argv[2];
	const runId = process.argv[3];
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	if (!runId || !mode) {
		console.log(JSON.stringify({ ok: false, detail: "usage: review.js <build|verdict> <run-id>" }));
		process.exit(0);
	}
	try {
		if (mode === "build") {
			console.log(JSON.stringify({ ok: true, ...reviewBuild({ runId, projectDir }) }));
		} else if (mode === "verdict") {
			console.log(JSON.stringify({ ok: true, ...reviewVerdict({ runId, projectDir }) }));
		} else {
			console.log(JSON.stringify({ ok: false, detail: `unknown mode: ${mode}` }));
		}
	} catch (err) {
		console.log(JSON.stringify({ ok: false, detail: err.message }));
	}
}
