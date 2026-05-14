import { join } from "node:path";
import { atomicWrite, readJsonSafe } from "../_io.js";
import { withRunLock } from "../_lock.js";
import { resolveRunDir } from "../_paths.js";
import { requireSafeId, SAFE_ID_PATTERN } from "../_validation.js";

export const cancelRunTool = {
	name: "cancel",
	description:
		"Set a run's phase to cancelled. Idempotent. Worktrees + artifacts are preserved for " +
		"inspection; only status.json changes. Use this to reject at an approval gate. " +
		"Returns: { phase: 'cancelled', prev_phase }.",
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
			const statusPath = join(runDir, "status.json");
			const current = readJsonSafe(statusPath) || {};
			const prev_phase = current.phase || null;
			current.phase = "cancelled";
			atomicWrite(statusPath, JSON.stringify(current, null, 2));
			return { phase: "cancelled", prev_phase };
		});
	},
};
