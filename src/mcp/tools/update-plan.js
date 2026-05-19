import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readJsonBounded } from "../_io.js";
import { withRunLock } from "../_lock.js";
import { resolveRunDir } from "../_paths.js";
import { JSON_MAX_BYTES, MARKDOWN_MAX_BYTES, SAFE_ID_PATTERN } from "../_validation.js";
import { buildGateSummary } from "../../orchestrator/extract-plan-summary.js";
import { validatePlan } from "../../orchestrator/validate-plan.js";
import { readRunConfig } from "../../orchestrator/settings.js";

export const updatePlanTool = {
	name: "update_plan",
	description:
		"Update the plan (tasks.json and optionally master-spec.md) during the approval gate. " +
		"Validates the updated plan before persisting. Returns { ok, summary, warnings } on success " +
		"(summary contains refreshed plan_summary and tasks for re-presentation) or { ok: false, errors } " +
		"if validation fails (previous plan unchanged).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Run id from create_run.",
			},
			tasks_json: {
				type: "string",
				description: "Updated tasks.json content as a JSON string.",
			},
			master_spec_md: {
				type: "string",
				description: "Updated master-spec.md content. Optional — omit to keep existing.",
			},
		},
		required: ["run_id", "tasks_json"],
	},
	async handler({ run_id, tasks_json, master_spec_md }, ctx) {
		if (Buffer.byteLength(tasks_json, "utf8") > JSON_MAX_BYTES) {
			throw new Error(`tasks_json exceeds ${JSON_MAX_BYTES} byte limit`);
		}
		if (master_spec_md && Buffer.byteLength(master_spec_md, "utf8") > MARKDOWN_MAX_BYTES) {
			throw new Error(`master_spec_md exceeds ${MARKDOWN_MAX_BYTES} byte limit`);
		}

		const runDir = resolveRunDir(ctx.projectDir, run_id);

		let plan;
		try {
			plan = JSON.parse(tasks_json);
		} catch (e) {
			return { ok: false, errors: [`invalid JSON: ${e.message}`] };
		}

		const cfg = readRunConfig(ctx.projectDir, run_id);
		const result = validatePlan(plan, {
			forbiddenPathsGlobal: cfg.safety?.forbidden_paths_global || [],
			mergeSafePaths: cfg.safety?.merge_safe_paths || [],
		});

		if (!result.ok) {
			return { ok: false, errors: result.errors, warnings: result.warnings || [] };
		}

		return withRunLock(runDir, () => {
			const statusPath = join(runDir, "status.json");
			const status = readJsonBounded(statusPath, JSON_MAX_BYTES);
			if (!status || (status.phase !== "approve" && status.phase !== "plan")) {
				throw new Error(
					`plan can only be updated during plan/approve phase (current: ${status?.phase || "unknown"})`,
				);
			}

			atomicWrite(join(runDir, "tasks.json"), JSON.stringify(plan, null, 2));
			if (master_spec_md) {
				atomicWrite(join(runDir, "master-spec.md"), master_spec_md);
			}

			const specPath = join(runDir, "master-spec.md");
			const tasksJsonPath = join(runDir, "tasks.json");
			const summary = buildGateSummary(run_id, specPath, tasksJsonPath, plan.tasks);

			return {
				ok: true,
				warnings: result.warnings || [],
				summary,
			};
		});
	},
};
