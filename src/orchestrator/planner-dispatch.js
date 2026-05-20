#!/usr/bin/env node
// planner-dispatch.js
//
// Build the dispatch prompt for the planner agent. Symmetric to
// dispatch / review_build / merger_envelope: every subagent dispatch prompt
// comes from an orchestrator function, never hand-written by the wrangler.
//
// The wrangler picks `effort` based on brief complexity; effort is passed
// in the dispatch prompt, not encoded in the agent name.
//
// Importable (MCP) or runnable (CLI).
//
// CLI:
//   node src/orchestrator/planner-dispatch.js <run-id> [effort]

import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readJsonSafe } from "../mcp/_io.js";
import { requireSafeId } from "../mcp/_validation.js";

export const PLANNER_EFFORTS = new Set(["medium", "high", "xhigh", "max"]);

export function plannerDispatch({ runId, projectDir, effort = "high" }) {
	requireSafeId(runId, "run_id");
	if (!PLANNER_EFFORTS.has(effort)) {
		throw new Error(
			`unknown planner effort: ${effort}. Pick one of ${Array.from(PLANNER_EFFORTS).join(", ")}.`,
		);
	}
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	if (!existsSync(runDir)) throw new Error(`run ${runId} not found at ${runDir}`);
	const briefPath = join(runDir, "brief.md");
	if (!existsSync(briefPath)) throw new Error(`brief missing at ${briefPath}`);

	const agentNamespaced = "lazy-dev:planner";

	const statusPath = join(runDir, "status.json");
	const status = readJsonSafe(statusPath) || {};
	let gitInitBlock = "";
	if (status.needs_git_init) {
		delete status.needs_git_init;
		atomicWrite(statusPath, JSON.stringify(status, null, 2));
		gitInitBlock =
			"\n\nIMPORTANT — GIT INIT REQUIRED:\n" +
			"The project directory is NOT a git repository. Worktrees (used for all specialist tasks) " +
			"require git. You MUST make T-0001 a git-init scaffolding task with these properties:\n" +
			'  - "git_init": true  (flag on the task object, tells the dispatcher to skip worktree creation)\n' +
			'  - agent: "code-small", effort: "low"\n' +
			"  - goal: initialize git repo and make an initial commit of existing files\n" +
			"  - completion_criteria: a shell check that `git rev-parse --git-dir` exits 0, " +
			"and a shell check that `git log --oneline -1` exits 0\n" +
			'  - scope.allowed_paths: [".gitignore"]\n' +
			"  - DO NOT include a diff_scope criterion (there is no git history to diff against)\n" +
			"  - All other tasks MUST depend on T-0001.\n";
	}

	return {
		agent_namespaced: agentNamespaced,
		model: "opus",
		effort,
		brief_path: briefPath,
		run_dir: runDir,
		dispatch_prompt:
			`Brief: ${briefPath}\nRun dir: ${runDir}\nEffort: ${effort || "high"}\n\n` +
			"The user has explicitly requested you create these two files:\n" +
			`  1. ${runDir}/master-spec.md\n` +
			`  2. ${runDir}/tasks.json\n\n` +
			"These files MUST exist on disk before you emit the sentinel. " +
			"Use absolute paths. Prefer Bash (cat > path << 'HEREDOC') for .md files." +
			gitInitBlock,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const runId = process.argv[2];
	const effort = process.argv[3] || "high";
	if (!runId) {
		console.log(
			JSON.stringify({ ok: false, detail: "usage: planner-dispatch.js <run-id> [effort]" }),
		);
		process.exit(0);
	}
	try {
		const result = plannerDispatch({ runId, projectDir, effort });
		console.log(JSON.stringify({ ok: true, ...result }));
	} catch (err) {
		console.log(JSON.stringify({ ok: false, detail: err.message }));
	}
}
