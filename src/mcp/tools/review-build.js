import { reviewBuild } from "../../orchestrator/review.js";
import { SAFE_ID_PATTERN } from "../_validation.js";

export const reviewBuildTool = {
	name: "review_build",
	description:
		"Assemble the reviewer's envelope + dispatch prompt. Walks each task's worktree, " +
		"emits a diff.patch per task, writes review-envelope.json. Retry-aware: includes " +
		"review-prev.md guidance when present. `effort` picks the reviewer variant: 'high' " +
		"(default, standard review), 'xhigh' (cross-subsystem diffs), 'max' (architectural — " +
		"expensive). Call when plan_next emits action=dispatch_reviewer. " +
		"Returns: { agent_namespaced, model, effort, envelope_path, dispatch_prompt, retry }. " +
		"Agent-dispatch using agent_namespaced as subagent_type, model as the model parameter, and dispatch_prompt as the prompt.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Run id from create_run.",
			},
			effort: {
				type: "string",
				enum: ["high", "xhigh", "max"],
				description:
					"Reviewer effort. Defaults to 'high'. Use 'xhigh' for cross-subsystem runs, 'max' for architectural changes.",
			},
		},
		required: ["run_id"],
	},
	async handler({ run_id, effort }, ctx) {
		return reviewBuild({ runId: run_id, projectDir: ctx.projectDir, effort });
	},
};
