import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLANNER_EFFORTS, plannerDispatch } from "./planner-dispatch.js";

let projectDir;
let runId;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "lazy-dev-planner-dispatch-"));
	runId = "2026-04-19T00-00-00Z-test";
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "brief.md"), "Test brief");
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("plannerDispatch effort routing", () => {
	test("defaults to 'high' and resolves to bare lazy-dev:planner", () => {
		const r = plannerDispatch({ runId, projectDir });
		expect(r.effort).toBe("high");
		expect(r.agent_namespaced).toBe("lazy-dev:planner");
	});

	test("medium → lazy-dev:planner-medium", () => {
		expect(plannerDispatch({ runId, projectDir, effort: "medium" }).agent_namespaced).toBe(
			"lazy-dev:planner-medium",
		);
	});

	test("xhigh → lazy-dev:planner-xhigh", () => {
		expect(plannerDispatch({ runId, projectDir, effort: "xhigh" }).agent_namespaced).toBe(
			"lazy-dev:planner-xhigh",
		);
	});

	test("max → lazy-dev:planner-max", () => {
		expect(plannerDispatch({ runId, projectDir, effort: "max" }).agent_namespaced).toBe(
			"lazy-dev:planner-max",
		);
	});

	test("rejects unknown effort", () => {
		expect(() => plannerDispatch({ runId, projectDir, effort: "turbo" })).toThrow(
			/unknown planner effort/,
		);
	});

	test("rejects 'low' (planner minimum is medium)", () => {
		expect(() => plannerDispatch({ runId, projectDir, effort: "low" })).toThrow();
	});

	test("exports the canonical effort ladder", () => {
		expect(Array.from(PLANNER_EFFORTS).sort()).toEqual(["high", "max", "medium", "xhigh"]);
	});

	test("throws if run dir missing", () => {
		expect(() => plannerDispatch({ runId: "missing-run", projectDir })).toThrow(/not found/);
	});

	test("throws if brief.md missing", () => {
		rmSync(join(projectDir, ".lazy-dev", "runs", runId, "brief.md"));
		expect(() => plannerDispatch({ runId, projectDir })).toThrow(/brief missing/);
	});
});
