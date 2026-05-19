import { dispatch } from "../../orchestrator/dispatch.js";
import { SAFE_ID_PATTERN } from "../_validation.js";

export const dispatchTool = {
	name: "dispatch",
	description:
		"Prepare a specialist dispatch: merge approved deps into main, create a worktree, " +
		"write envelope.json. Call for each id in plan_next's dispatch.ids response. " +
		"Returns: { agent, agent_namespaced, model, task_id, worktree, envelope_path, dispatch_prompt }. " +
		"Agent-dispatch using agent_namespaced as subagent_type, model as the model parameter, and dispatch_prompt as the prompt.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Run id returned by create_run.",
			},
			task_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Task id from tasks.json (e.g. T-0001).",
			},
		},
		required: ["run_id", "task_id"],
	},
	async handler({ run_id, task_id }, ctx) {
		try {
			return dispatch({ runId: run_id, taskId: task_id, projectDir: ctx.projectDir });
		} catch (err) {
			if (err.dep_conflict) {
				return {
					dep_conflict: true,
					dep_id: err.dep_id,
					task_id: err.task_id,
					conflicted_files: err.conflicted_files,
					detail: err.message,
				};
			}
			throw err;
		}
	},
};
