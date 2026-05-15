#!/usr/bin/env node
// planner-dispatch.js
//
// Build the dispatch prompt for the planner agent. Symmetric to
// dispatch / review_build / merger_envelope: every subagent dispatch prompt
// comes from an orchestrator function, never hand-written by the wrangler.
//
// The wrangler picks `effort` based on brief complexity; this function maps
// it to the right agent variant. "high" is the default (= bare `lazy-dev:planner`),
// other values resolve to `lazy-dev:planner-<effort>`.
//
// Importable (MCP) or runnable (CLI).
//
// CLI:
//   node src/orchestrator/planner-dispatch.js <run-id> [effort]

import { existsSync } from "node:fs";
import { join } from "node:path";
import { requireSafeId } from "../mcp/_validation.js";

// Canonical effort ladder for Opus-backed per-run agents.
// high is the default (bare agent); variants cover cheaper/pricier ends.
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

	const agentNamespaced = effort === "high" ? "lazy-dev:planner" : `lazy-dev:planner-${effort}`;

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
			"Use absolute paths. Prefer Bash (cat > path << 'HEREDOC') for .md files.",
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
