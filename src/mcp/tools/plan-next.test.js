import { describe, expect, test } from "bun:test";
import { planNextTool } from "./plan-next.js";

describe("planNextTool", () => {
	test("has correct tool metadata", () => {
		expect(planNextTool.name).toBe("plan_next");
		expect(planNextTool.inputSchema.required).toEqual(["run_id"]);
		expect(planNextTool.inputSchema.properties.run_id.pattern).toBeDefined();
	});

	test("description mentions state machine actions", () => {
		expect(planNextTool.description).toContain("dispatch");
		expect(planNextTool.description).toContain("summarise");
	});
});
