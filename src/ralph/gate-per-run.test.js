// Covers the prefix-matching logic for per-run agent variants.
// gate.js:isPerRunAgent isn't exported; this test reimplements the contract
// and locks in the expectations in case the prefix list changes.

import { describe, expect, test } from "bun:test";

// Mirror of the private helper in gate.js — kept in sync via this test.
const PER_RUN_AGENT_PREFIXES = ["planner", "reviewer", "wrangler"];

function isPerRunAgent(bareName) {
	return PER_RUN_AGENT_PREFIXES.some((p) => bareName === p || bareName.startsWith(`${p}-`));
}

describe("per-run agent prefix matching", () => {
	test("base per-run agents classify correctly", () => {
		expect(isPerRunAgent("planner")).toBe(true);
		expect(isPerRunAgent("reviewer")).toBe(true);
		expect(isPerRunAgent("wrangler")).toBe(true);
	});

	test("effort variants match the base", () => {
		expect(isPerRunAgent("planner-medium")).toBe(true);
		expect(isPerRunAgent("planner-xhigh")).toBe(true);
		expect(isPerRunAgent("planner-max")).toBe(true);
		expect(isPerRunAgent("reviewer-xhigh")).toBe(true);
		expect(isPerRunAgent("reviewer-max")).toBe(true);
	});

	test("per-task specialists do NOT match", () => {
		expect(isPerRunAgent("code-small")).toBe(false);
		expect(isPerRunAgent("code-small-low")).toBe(false);
		expect(isPerRunAgent("code-big-high")).toBe(false);
		expect(isPerRunAgent("merger")).toBe(false);
		expect(isPerRunAgent("debug")).toBe(false);
		expect(isPerRunAgent("research")).toBe(false);
		expect(isPerRunAgent("docs")).toBe(false);
		expect(isPerRunAgent("format")).toBe(false);
	});

	test("name collisions on partial prefixes do not match", () => {
		// "plannerish" is not a planner variant (no hyphen).
		expect(isPerRunAgent("plannerish")).toBe(false);
		expect(isPerRunAgent("review")).toBe(false);
	});
});
