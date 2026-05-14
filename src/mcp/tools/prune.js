import { prune } from "../../orchestrator/prune.js";
import { SAFE_ID_PATTERN } from "../_validation.js";

export const pruneTool = {
	name: "prune",
	description:
		"Clean up a completed run's git worktrees and lazy-dev/<run>/* branches. Run dir " +
		"(usage.json, review.md, status.json, envelopes, diff.patch) is preserved for " +
		"forensics. Refuses if the run is still active — cancel it first. " +
		"Returns: { run_id, worktrees_removed, worktrees_failed, branches_removed, branches_failed, run_dir_preserved }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Run id to prune. Must be in phase done or cancelled.",
			},
		},
		required: ["run_id"],
	},
	async handler({ run_id }, ctx) {
		return prune({ runId: run_id, projectDir: ctx.projectDir });
	},
};
