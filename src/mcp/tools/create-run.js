import { createRun } from "../../orchestrator/create-run.js";
import { BRIEF_MAX_BYTES } from "../_validation.js";

export const createRunTool = {
	name: "create_run",
	description:
		"Create a new lazy-dev run. Writes brief.md and status.json(phase:plan) atomically. " +
		"First tool the orchestrator calls on every /run invocation. " +
		"Returns: { run_id, run_dir }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			brief: {
				type: "string",
				description: "The user's task description. Plain text. Max 256 KB.",
				maxLength: BRIEF_MAX_BYTES,
				minLength: 1,
			},
		},
		required: ["brief"],
	},
	async handler({ brief }, ctx) {
		return createRun({ brief, projectDir: ctx.projectDir });
	},
};
