import { describe, expect, test } from "bun:test";

const PER_RUN_AGENTS = new Set(["planner", "reviewer", "wrangler"]);

function isPerRunAgent(bareName) {
	return PER_RUN_AGENTS.has(bareName);
}

describe("per-run agent matching", () => {
	test("per-run agents classify correctly", () => {
		expect(isPerRunAgent("planner")).toBe(true);
		expect(isPerRunAgent("reviewer")).toBe(true);
		expect(isPerRunAgent("wrangler")).toBe(true);
	});

	test("per-task specialists do NOT match", () => {
		expect(isPerRunAgent("code-small")).toBe(false);
		expect(isPerRunAgent("code-medium")).toBe(false);
		expect(isPerRunAgent("code-big")).toBe(false);
		expect(isPerRunAgent("merger")).toBe(false);
		expect(isPerRunAgent("debug")).toBe(false);
		expect(isPerRunAgent("research")).toBe(false);
		expect(isPerRunAgent("docs")).toBe(false);
		expect(isPerRunAgent("format")).toBe(false);
	});

	test("partial name collisions do not match", () => {
		expect(isPerRunAgent("plannerish")).toBe(false);
		expect(isPerRunAgent("review")).toBe(false);
		expect(isPerRunAgent("planner-medium")).toBe(false);
	});
});
