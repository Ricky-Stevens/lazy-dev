import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plannerDispatchTool } from "./planner-dispatch.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "planner-dispatch-tool-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("plannerDispatchTool", () => {
	test("has correct tool metadata", () => {
		expect(plannerDispatchTool.name).toBe("planner_dispatch");
		expect(plannerDispatchTool.inputSchema.required).toEqual(["run_id"]);
		expect(plannerDispatchTool.inputSchema.properties.effort.enum).toEqual([
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	test("handler returns dispatch info", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-pd");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "brief.md"), "test brief\n");
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: "run-pd", phase: "plan" }));

		const result = await plannerDispatchTool.handler({ run_id: "run-pd" }, { projectDir });
		expect(result.agent_namespaced).toContain("planner");
		expect(result.dispatch_prompt).toContain("Brief:");
	});

	test("handler accepts effort parameter", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-pd2");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "brief.md"), "test\n");
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "plan" }));

		const result = await plannerDispatchTool.handler(
			{ run_id: "run-pd2", effort: "max" },
			{ projectDir },
		);
		expect(result.effort).toBe("max");
		expect(result.agent_namespaced).toContain("max");
	});
});
