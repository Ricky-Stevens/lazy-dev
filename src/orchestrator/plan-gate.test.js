import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { planIsSimple } from "./plan-gate.js";

const savedApproval = process.env.LAZY_DEV_APPROVAL;

beforeEach(() => {
	process.env.LAZY_DEV_APPROVAL = undefined;
});
afterEach(() => {
	if (savedApproval !== undefined) process.env.LAZY_DEV_APPROVAL = savedApproval;
	else process.env.LAZY_DEV_APPROVAL = undefined;
});

describe("planIsSimple", () => {
	test("a single code-small task is simple", () => {
		expect(planIsSimple([{ id: "T-0001", agent: "code-small" }])).toBe(true);
	});

	test("two code-small tasks is simple (at threshold)", () => {
		const tasks = [
			{ id: "T-0001", agent: "code-small" },
			{ id: "T-0002", agent: "code-small" },
		];
		expect(planIsSimple(tasks)).toBe(true);
	});

	test("three code-small tasks is NOT simple (over threshold)", () => {
		const tasks = [
			{ id: "T-0001", agent: "code-small" },
			{ id: "T-0002", agent: "code-small" },
			{ id: "T-0003", agent: "code-small" },
		];
		expect(planIsSimple(tasks)).toBe(false);
	});

	test("four code-big tasks over threshold is NOT simple", () => {
		const tasks = [
			{ id: "T-0001", agent: "code-big" },
			{ id: "T-0002", agent: "code-big" },
			{ id: "T-0003", agent: "code-big" },
			{ id: "T-0004", agent: "code-big" },
		];
		expect(planIsSimple(tasks)).toBe(false);
	});

	test("mixed low-risk and high-risk agents over threshold is NOT simple", () => {
		const tasks = [
			{ id: "T-0001", agent: "code-small" },
			{ id: "T-0002", agent: "code-small" },
			{ id: "T-0003", agent: "code-small" },
			{ id: "T-0004", agent: "code-big" },
		];
		expect(planIsSimple(tasks)).toBe(false);
	});

	test("any code-big task forces the gate", () => {
		expect(
			planIsSimple([
				{ id: "T-0001", agent: "code-small" },
				{ id: "T-0002", agent: "code-big" },
			]),
		).toBe(false);
	});

	test("single code-medium task is simple (under threshold)", () => {
		expect(planIsSimple([{ id: "T-0001", agent: "code-medium" }])).toBe(true);
	});

	test("three code-medium tasks gates (over threshold, no low-risk bypass)", () => {
		const tasks = [
			{ id: "T-0001", agent: "code-medium" },
			{ id: "T-0002", agent: "code-medium" },
			{ id: "T-0003", agent: "code-medium" },
		];
		expect(planIsSimple(tasks)).toBe(false);
	});

	test("LAZY_DEV_APPROVAL=required forces the gate regardless", () => {
		process.env.LAZY_DEV_APPROVAL = "required";
		expect(planIsSimple([{ id: "T-0001", agent: "code-small" }])).toBe(false);
	});

	test("LAZY_DEV_APPROVAL=skip bypasses the gate even for large plans", () => {
		process.env.LAZY_DEV_APPROVAL = "skip";
		const many = Array.from({ length: 20 }, (_, i) => ({
			id: `T-${String(i).padStart(4, "0")}`,
			agent: "code-big",
		}));
		expect(planIsSimple(many)).toBe(true);
	});

	test("config can raise the threshold", () => {
		const tasks = Array.from({ length: 5 }, (_, i) => ({
			id: `T-${String(i).padStart(4, "0")}`,
			agent: "code-small",
		}));
		expect(planIsSimple(tasks, { approval: { auto_approve_max_tasks: 10 } })).toBe(true);
	});

	test("config can add agents to require_gate_agents", () => {
		const tasks = [{ id: "T-0001", agent: "debug" }];
		expect(planIsSimple(tasks, { approval: { require_gate_agents: ["debug"] } })).toBe(false);
	});

	test("empty tasks array is simple", () => {
		expect(planIsSimple([])).toBe(true);
	});
});
