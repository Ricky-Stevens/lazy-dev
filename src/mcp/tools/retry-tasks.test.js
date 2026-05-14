import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryTasksTool } from "./retry-tasks.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "retry-tasks-tool-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("retryTasksTool", () => {
	test("has correct tool metadata", () => {
		expect(retryTasksTool.name).toBe("retry_tasks");
		expect(retryTasksTool.inputSchema.required).toEqual(["run_id", "task_ids"]);
		expect(retryTasksTool.inputSchema.properties.task_ids.type).toBe("array");
	});

	test("handler resets tasks for retry", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-retry");
		const taskDir = join(runDir, "tasks", "T-0001");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "review" }));
		writeFileSync(
			join(taskDir, "envelope.json"),
			JSON.stringify({ id: "T-0001", agent: "code-small" }),
		);
		writeFileSync(join(taskDir, "APPROVED"), "{}");

		const result = await retryTasksTool.handler(
			{ run_id: "run-retry", task_ids: ["T-0001"] },
			{ projectDir },
		);
		expect(result.reset).toEqual(["T-0001"]);
	});

	test("handler rejects empty task_ids", async () => {
		expect(
			retryTasksTool.handler({ run_id: "run-1", task_ids: [] }, { projectDir }),
		).rejects.toThrow();
	});
});
