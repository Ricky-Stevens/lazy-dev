import { listRuns, statusForRun } from "../../orchestrator/status.js";
import { SAFE_ID_PATTERN } from "../_validation.js";

export const statusTool = {
	name: "status",
	description:
		"Without run_id: list the last 10 runs. Returns: { runs: [{run_id, phase, review_pass, integration_test}] } (newest-first). " +
		"With run_id: detailed status for that run. Returns: { run_id, phase, tasks: {approved, failed, running}, failed_tasks, worktrees, usage }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Optional. Omit (do not pass empty string) to list all runs.",
			},
		},
	},
	async handler({ run_id }, ctx) {
		if (run_id) return statusForRun({ runId: run_id, projectDir: ctx.projectDir });
		return listRuns({ projectDir: ctx.projectDir });
	},
};
