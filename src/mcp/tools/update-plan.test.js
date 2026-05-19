import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updatePlanTool } from "./update-plan.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "update-plan-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function setupRun(runId, phase = "approve") {
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase }));
	writeFileSync(join(runDir, "master-spec.md"), "# Spec");
	const plan = {
		tasks: [
			{
				id: "T-0001",
				agent: "code-medium",
				title: "Test task",
				goal: "Do something",
				details: "Implementation details",
				scope: { allowed_paths: ["src/a.js"] },
				completion_criteria: [{ id: "x", kind: "shell", cmd: "true" }],
			},
		],
	};
	writeFileSync(join(runDir, "tasks.json"), JSON.stringify(plan));
	return runDir;
}

describe("updatePlanTool", () => {
	test("accepts valid updated plan", async () => {
		setupRun("run-up1");
		const updated = {
			tasks: [
				{
					id: "T-0001",
					agent: "code-small",
					effort: "low",
					title: "Simplified task",
					goal: "Do something simpler",
					details: "Just rename a variable",
					scope: { allowed_paths: ["src/a.js"] },
					completion_criteria: [{ id: "x", kind: "shell", cmd: "true" }],
				},
			],
		};
		const result = await updatePlanTool.handler(
			{ run_id: "run-up1", tasks_json: JSON.stringify(updated) },
			{ projectDir },
		);
		expect(result.ok).toBe(true);
		expect(result.summary).toBeDefined();
		expect(result.summary.task_count).toBe(1);
		expect(result.summary.tasks[0].agent).toBe("code-small");
		expect(result.summary.tasks[0].model).toBe("Haiku");
		expect(result.summary.tasks[0].effort).toBe("low");
		expect(result.summary.plan_summary).toBeDefined();

		const persisted = JSON.parse(
			readFileSync(join(projectDir, ".lazy-dev", "runs", "run-up1", "tasks.json"), "utf8"),
		);
		expect(persisted.tasks[0].agent).toBe("code-small");
	});

	test("rejects invalid JSON", async () => {
		setupRun("run-up2");
		const result = await updatePlanTool.handler(
			{ run_id: "run-up2", tasks_json: "{not valid" },
			{ projectDir },
		);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toContain("invalid JSON");
	});

	test("rejects plan with validation errors", async () => {
		setupRun("run-up3");
		const bad = { tasks: [{ id: "bad", agent: "nonexistent" }] };
		const result = await updatePlanTool.handler(
			{ run_id: "run-up3", tasks_json: JSON.stringify(bad) },
			{ projectDir },
		);
		expect(result.ok).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	test("rejects update outside approve phase", async () => {
		setupRun("run-up4", "specialists");
		const plan = {
			tasks: [
				{
					id: "T-0001",
					agent: "code-medium",
					title: "X",
					goal: "Y",
					details: "Z",
					scope: { allowed_paths: ["a.js"] },
					completion_criteria: [{ id: "x", kind: "shell", cmd: "true" }],
				},
			],
		};
		await expect(
			updatePlanTool.handler(
				{ run_id: "run-up4", tasks_json: JSON.stringify(plan) },
				{ projectDir },
			),
		).rejects.toThrow("plan can only be updated during plan/approve phase");
	});

	test("updates master-spec when provided and returns refreshed summary", async () => {
		setupRun("run-up5");
		const plan = {
			tasks: [
				{
					id: "T-0001",
					agent: "code-medium",
					title: "X",
					goal: "Y",
					details: "Z",
					scope: { allowed_paths: ["a.js"] },
					completion_criteria: [{ id: "x", kind: "shell", cmd: "true" }],
				},
			],
		};
		const result = await updatePlanTool.handler(
			{
				run_id: "run-up5",
				tasks_json: JSON.stringify(plan),
				master_spec_md:
					"# Master Spec -- New direction\n\n## Problem\nOld approach was wrong.\n\n## Approach\nUse a better method.",
			},
			{ projectDir },
		);
		expect(result.ok).toBe(true);
		expect(result.summary.plan_summary.title).toBe("New direction");
		expect(result.summary.plan_summary.problem).toContain("Old approach was wrong");
		expect(result.summary.plan_summary.approach).toContain("better method");
	});

	test("rejects oversized tasks_json", async () => {
		setupRun("run-up-big");
		const huge = "x".repeat(5 * 1024 * 1024);
		await expect(
			updatePlanTool.handler({ run_id: "run-up-big", tasks_json: huge }, { projectDir }),
		).rejects.toThrow("byte limit");
	});

	test("rejects oversized master_spec_md", async () => {
		setupRun("run-up-bigmd");
		const plan = {
			tasks: [
				{
					id: "T-0001",
					agent: "code-medium",
					title: "X",
					goal: "Y",
					details: "Z",
					scope: { allowed_paths: ["a.js"] },
					completion_criteria: [{ id: "x", kind: "shell", cmd: "true" }],
				},
			],
		};
		const hugeMd = "x".repeat(2 * 1024 * 1024);
		await expect(
			updatePlanTool.handler(
				{ run_id: "run-up-bigmd", tasks_json: JSON.stringify(plan), master_spec_md: hugeMd },
				{ projectDir },
			),
		).rejects.toThrow("byte limit");
	});

	test("returns warnings for effort/tier mismatch", async () => {
		setupRun("run-up6");
		const plan = {
			tasks: [
				{
					id: "T-0001",
					agent: "code-small",
					effort: "max",
					title: "X",
					goal: "Y",
					details: "Z",
					scope: { allowed_paths: ["a.js"] },
					completion_criteria: [{ id: "x", kind: "shell", cmd: "true" }],
				},
			],
		};
		const result = await updatePlanTool.handler(
			{ run_id: "run-up6", tasks_json: JSON.stringify(plan) },
			{ projectDir },
		);
		expect(result.ok).toBe(true);
		expect(result.warnings.length).toBeGreaterThan(0);
		expect(result.warnings[0]).toContain("not effective");
	});
});
