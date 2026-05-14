import { planNext } from "../../orchestrator/plan-next.js";
import { SAFE_ID_PATTERN } from "../_validation.js";

export const planNextTool = {
	name: "plan_next",
	description:
		"Advance the run state machine and return the next action. Call in a loop until " +
		"action is 'summarise' or 'surface'. Serialised per-run via advisory lock. " +
		"Returns: { phase, action, ...action-specific fields }. Actions: dispatch_planner, " +
		"show_gate, await_user, dispatch, wait, blocked, dispatch_reviewer, auto_retry, " +
		"run_merge, dispatch_merger, run_integration_test, summarise, surface.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Run id returned by create_run.",
			},
		},
		required: ["run_id"],
	},
	async handler({ run_id }, ctx) {
		return planNext({ runId: run_id, projectDir: ctx.projectDir });
	},
};
