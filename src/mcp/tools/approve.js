import { join } from "node:path";
import { atomicWrite } from "../_io.js";
import { withRunLock } from "../_lock.js";
import { resolveRunDir } from "../_paths.js";
import { requireSafeId, SAFE_ID_PATTERN } from "../_validation.js";

export const approveTool = {
	name: "approve",
	description:
		"Write approval.md to unblock specialists after a plan approval gate (action=show_gate or " +
		"await_user). To reject the plan, call the cancel tool instead of this one. " +
		"Returns: { phase: 'approved' }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Run id from create_run.",
			},
		},
		required: ["run_id"],
	},
	async handler({ run_id }, ctx) {
		requireSafeId(run_id, "run_id");
		const runDir = resolveRunDir(ctx.projectDir, run_id);
		return withRunLock(runDir, () => {
			atomicWrite(join(runDir, "approval.md"), "User-approved via lazy-dev__approve.\n");
			return { phase: "approved" };
		});
	},
};
