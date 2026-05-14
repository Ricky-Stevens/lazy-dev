import { doctor } from "../../orchestrator/doctor.js";
import { SAFE_ID_PATTERN } from "../_validation.js";

export const doctorTool = {
	name: "doctor",
	description:
		"Diagnostic dump for a run: status, per-task markers, gate log tail, recent payloads, " +
		"usage totals, branch state. Omit run_id entirely (do not pass empty string) to pick " +
		"the most recent run. " +
		"Returns: { report } — a markdown string to print verbatim.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description:
					"Optional. Run id from create_run. Omit to pick the most recent run (do not pass empty string).",
			},
		},
	},
	async handler({ run_id }, ctx) {
		const report = doctor({ runId: run_id, projectDir: ctx.projectDir });
		return { report };
	},
};
