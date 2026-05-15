import { plannerDispatch } from "../../orchestrator/planner-dispatch.js";
import { SAFE_ID_PATTERN } from "../_validation.js";

export const plannerDispatchTool = {
	name: "planner_dispatch",
	description:
		"Build the planner dispatch prompt. Call when plan_next emits action=dispatch_planner. " +
		"`effort` picks the planner variant: 'medium' (routine <=3 files), 'high' (default, standard " +
		"feature work), 'xhigh' (cross-subsystem), 'max' (architectural / migrations — expensive). " +
		"Returns: { agent_namespaced, model, effort, brief_path, run_dir, dispatch_prompt }. Agent-dispatch " +
		"using agent_namespaced as subagent_type, model as the model parameter, and dispatch_prompt as the prompt.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Run id returned by create_run.",
			},
			effort: {
				type: "string",
				enum: ["medium", "high", "xhigh", "max"],
				description:
					"Planner effort. Defaults to 'high'. Use 'medium' for routine small work; 'xhigh' for cross-subsystem; 'max' for architectural (costs scale steeply — justify the choice).",
			},
		},
		required: ["run_id"],
	},
	async handler({ run_id, effort }, ctx) {
		return plannerDispatch({ runId: run_id, projectDir: ctx.projectDir, effort });
	},
};
