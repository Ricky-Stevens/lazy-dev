import { retryTasks } from "../../orchestrator/retry-tasks.js";
import { SAFE_ID_PATTERN } from "../_validation.js";

export const retryTasksTool = {
	name: "retry_tasks",
	description:
		"Reset the named tasks after a reviewer CHANGES_REQUESTED verdict. Archives review.md → " +
		"review-prev.md, patches each envelope with reviewer_notes, writes RETRY markers. " +
		"Call when plan_next emits action=auto_retry; pass the response.tasks array. " +
		"Returns: { reset: [task_id...] }. After this, call plan_next to re-enter specialist dispatch.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			run_id: {
				type: "string",
				pattern: SAFE_ID_PATTERN,
				description: "Run id from create_run.",
			},
			task_ids: {
				type: "array",
				minItems: 1,
				items: { type: "string", pattern: SAFE_ID_PATTERN },
				description: "Task ids to reset for retry (from auto_retry.tasks).",
			},
		},
		required: ["run_id", "task_ids"],
	},
	async handler({ run_id, task_ids }, ctx) {
		return retryTasks({ runId: run_id, taskIds: task_ids, projectDir: ctx.projectDir });
	},
};
