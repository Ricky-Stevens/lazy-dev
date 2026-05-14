import { mergerEnvelope } from "../../orchestrator/merge-conflicts.js";
import { SAFE_ID_PATTERN } from "../_validation.js";

export const mergerEnvelopeTool = {
	name: "merger_envelope",
	description:
		"Fetch the dispatch prompt + envelope path for one merger invocation. Call when plan_next " +
		"emits action=dispatch_merger, passing the response.merge_id. " +
		"Returns: { agent_namespaced, envelope_path, dispatch_prompt }. Agent-dispatch using " +
		"agent_namespaced as subagent_type and dispatch_prompt as the prompt.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Run id from create_run.",
			},
			merge_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Merge id from plan_next dispatch_merger action (e.g. M-0001-T-0001).",
			},
		},
		required: ["run_id", "merge_id"],
	},
	async handler({ run_id, merge_id }, ctx) {
		return mergerEnvelope({ runId: run_id, mergeId: merge_id, projectDir: ctx.projectDir });
	},
};
