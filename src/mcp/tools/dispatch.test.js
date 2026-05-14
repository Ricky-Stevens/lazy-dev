import { describe, expect, test } from "bun:test";
import { dispatchTool } from "./dispatch.js";

describe("dispatchTool", () => {
	test("has correct tool metadata", () => {
		expect(dispatchTool.name).toBe("dispatch");
		expect(dispatchTool.inputSchema.required).toEqual(["run_id", "task_id"]);
		expect(dispatchTool.inputSchema.properties.run_id.pattern).toBeDefined();
		expect(dispatchTool.inputSchema.properties.task_id.pattern).toBeDefined();
	});

	test("description mentions worktree and envelope", () => {
		expect(dispatchTool.description).toContain("worktree");
		expect(dispatchTool.description).toContain("envelope");
	});
});
