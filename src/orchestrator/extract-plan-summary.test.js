import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGateSummary, extractPlanSummary } from "./extract-plan-summary.js";

let tmpDir;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "extract-plan-summary-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeSpec(name, content) {
	const p = join(tmpDir, `${name}.md`);
	writeFileSync(p, content);
	return p;
}

describe("extractPlanSummary", () => {
	test("extracts all sections from standard planner output", () => {
		const p = writeSpec(
			"full",
			[
				"# Master Spec -- Add rate limiting",
				"",
				"## Problem",
				"API has no rate limiting.",
				"",
				"## Goal",
				"Sliding window rate limiter.",
				"",
				"## Approach",
				"Use Redis sorted sets.",
				"",
				"## Scope -- in",
				"- Rate limit middleware",
				"",
				"## Scope -- explicitly out",
				"- Dashboard UI",
				"",
				"## Risks and known gotchas",
				"- Redis must be available.",
			].join("\n"),
		);
		const s = extractPlanSummary(p);
		expect(s.title).toBe("Add rate limiting");
		expect(s.problem).toContain("no rate limiting");
		expect(s.goal).toContain("Sliding window");
		expect(s.approach).toContain("Redis sorted sets");
		expect(s.scope_in).toContain("Rate limit middleware");
		expect(s.scope_out).toContain("Dashboard UI");
		expect(s.risks).toContain("Redis must be available");
	});

	test("handles en-dash separator in title", () => {
		const p = writeSpec("endash", "# Master Spec – Fix auth\n\n## Problem\nBroken.");
		const s = extractPlanSummary(p);
		expect(s.title).toBe("Fix auth");
	});

	test("handles em-dash separator in title", () => {
		const p = writeSpec("emdash", "# Master Spec — Fix auth\n\n## Problem\nBroken.");
		const s = extractPlanSummary(p);
		expect(s.title).toBe("Fix auth");
	});

	test("handles colon separator in title", () => {
		const p = writeSpec("colon", "# Master Spec: Fix auth\n\n## Problem\nBroken.");
		const s = extractPlanSummary(p);
		expect(s.title).toBe("Fix auth");
	});

	test("returns null fields for missing sections", () => {
		const p = writeSpec("minimal", "# Just a title\n\nSome text.");
		const s = extractPlanSummary(p);
		expect(s.title).toBe("Just a title");
		expect(s.problem).toBeNull();
		expect(s.approach).toBeNull();
		expect(s.risks).toBeNull();
	});

	test("returns null for empty sections", () => {
		const p = writeSpec("empty-section", "# Spec\n\n## Problem\n\n## Goal\nSomething.");
		const s = extractPlanSummary(p);
		expect(s.problem).toBeNull();
		expect(s.goal).toBe("Something.");
	});

	test("returns null for missing file", () => {
		expect(extractPlanSummary(join(tmpDir, "nonexistent.md"))).toBeNull();
	});

	test("scope_in and scope_out do not cross-match", () => {
		const p = writeSpec(
			"scope",
			["# Spec", "## Scope -- in", "- Feature A", "## Scope -- explicitly out", "- Feature B"].join(
				"\n",
			),
		);
		const s = extractPlanSummary(p);
		expect(s.scope_in).toContain("Feature A");
		expect(s.scope_in).not.toContain("Feature B");
		expect(s.scope_out).toContain("Feature B");
		expect(s.scope_out).not.toContain("Feature A");
	});
});

describe("buildGateSummary", () => {
	test("builds summary with model and effort resolved", () => {
		const specPath = writeSpec("gate", "# Master Spec -- Test\n\n## Problem\nNone.");
		const tasks = [
			{
				id: "T-0001",
				agent: "code-medium",
				effort: "high",
				title: "Task one",
				goal: "Do thing",
				scope: { allowed_paths: ["src/a.js"] },
			},
			{
				id: "T-0002",
				agent: "code-big",
				title: "Task two",
				goal: "Do other thing",
				depends_on: ["T-0001"],
				scope: { allowed_paths: ["src/b.js"] },
			},
		];
		const s = buildGateSummary("run-1", specPath, "/tmp/tasks.json", tasks);
		expect(s.run_id).toBe("run-1");
		expect(s.plan_summary.title).toBe("Test");
		expect(s.task_count).toBe(2);
		expect(s.tasks[0].model).toBe("Sonnet");
		expect(s.tasks[0].effort).toBe("high");
		expect(s.tasks[1].model).toBe("Opus");
		expect(s.tasks[1].effort).toBeNull();
		expect(s.tasks[1].depends_on).toEqual(["T-0001"]);
	});
});
