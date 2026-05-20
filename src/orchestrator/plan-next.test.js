import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planNext } from "./plan-next.js";

let projectDir;
let runId;
let runDir;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "lazy-dev-plan-next-"));
	runId = "2026-04-19T00-00-00Z-test01";
	runDir = join(projectDir, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "plan" }));
	writeFileSync(join(runDir, "brief.md"), "Test brief");
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function writePlan(tasks) {
	writeFileSync(join(runDir, "master-spec.md"), "# spec");
	writeFileSync(join(runDir, "tasks.json"), JSON.stringify({ tasks }));
}

const simpleTask = (id, agent = "code-small") => ({
	id,
	agent,
	title: `task ${id}`,
	goal: `Implement ${id}`,
	details: `Create src/${id}.js with the required functionality.`,
	scope: { allowed_paths: [`src/${id}.js`] },
	completion_criteria: [{ id: "exists", kind: "file_exists", path: `src/${id}.js` }],
	budget: { max_iter: 3 },
});

describe("planPhase auto-approval", () => {
	test("simple plan auto-approves and advances to specialists", () => {
		writePlan([simpleTask("T-0001"), simpleTask("T-0002")]);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("specialists");
		expect(result.action).toBeOneOf(["dispatch", "wait", "done_specialists"]);
		expect(existsSync(join(runDir, "approval.md"))).toBe(true);
	});

	test("plan with code-big emits show_gate (requires human review)", () => {
		writePlan([simpleTask("T-0001"), simpleTask("T-0002", "code-big")]);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("approve");
		expect(result.action).toBe("show_gate");
		expect(existsSync(join(runDir, "approval.md"))).toBe(false);
	});

	test("plan with >2 tasks gates regardless of agent type", () => {
		writePlan([simpleTask("T-0001"), simpleTask("T-0002"), simpleTask("T-0003")]);
		const result = planNext({ runId, projectDir });
		expect(result.action).toBe("show_gate");
		expect(existsSync(join(runDir, "approval.md"))).toBe(false);
	});

	test("show_gate summary includes plan_summary, model, effort, and goal per task", () => {
		const taskWithEffort = {
			...simpleTask("T-0001", "code-big"),
			effort: "high",
			depends_on: [],
		};
		const taskDep = {
			...simpleTask("T-0002", "code-medium"),
			effort: "medium",
			depends_on: ["T-0001"],
		};
		const specMd = [
			"# Master Spec -- Add rate limiting",
			"",
			"## Problem",
			"API has no rate limiting.",
			"",
			"## Goal",
			"Sliding window rate limiter on all endpoints.",
			"",
			"## Approach",
			"Use Redis sorted sets for sliding window tracking.",
			"",
			"## Scope -- in",
			"- Rate limit middleware",
			"- Redis integration",
			"",
			"## Scope -- explicitly out",
			"- Dashboard UI",
			"",
			"## Risks and known gotchas",
			"- Redis must be available at deploy time.",
		].join("\n");
		writeFileSync(join(runDir, "master-spec.md"), specMd);
		writeFileSync(join(runDir, "tasks.json"), JSON.stringify({ tasks: [taskWithEffort, taskDep] }));
		const result = planNext({ runId, projectDir });
		expect(result.action).toBe("show_gate");

		const { summary } = result;
		expect(summary.plan_summary).toBeDefined();
		expect(summary.plan_summary.title).toBe("Add rate limiting");
		expect(summary.plan_summary.problem).toContain("no rate limiting");
		expect(summary.plan_summary.goal).toContain("Sliding window");
		expect(summary.plan_summary.approach).toContain("Redis sorted sets");
		expect(summary.plan_summary.scope_in).toContain("Rate limit middleware");
		expect(summary.plan_summary.scope_out).toContain("Dashboard UI");
		expect(summary.plan_summary.risks).toContain("Redis must be available");
		expect(summary.spec).toBeUndefined();
		expect(summary.tasks[0].model).toBe("Opus");
		expect(summary.tasks[0].effort).toBe("high");
		expect(summary.tasks[0].goal).toBe("Implement T-0001");
		expect(summary.tasks[1].model).toBe("Sonnet");
		expect(summary.tasks[1].effort).toBe("medium");
		expect(summary.tasks[1].depends_on).toEqual(["T-0001"]);
	});

	test("plan_summary gracefully handles minimal spec", () => {
		writeFileSync(join(runDir, "master-spec.md"), "# Spec\n\nNo sections.");
		writeFileSync(
			join(runDir, "tasks.json"),
			JSON.stringify({
				tasks: [
					simpleTask("T-0001", "code-big"),
					simpleTask("T-0002", "code-big"),
					simpleTask("T-0003", "code-big"),
					simpleTask("T-0004", "code-big"),
				],
			}),
		);
		const result = planNext({ runId, projectDir });
		expect(result.action).toBe("show_gate");
		expect(result.summary.plan_summary).toBeDefined();
		expect(result.summary.plan_summary.title).toBe("Spec");
		expect(result.summary.plan_summary.problem).toBeNull();
		expect(result.summary.plan_summary.approach).toBeNull();
	});

	test("single-task simple plan auto-approves", () => {
		writePlan([simpleTask("T-0001")]);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("specialists");
		expect(existsSync(join(runDir, "approval.md"))).toBe(true);
	});
});

describe("planPhase — dispatch planner", () => {
	test("returns dispatch_planner when no master-spec or tasks.json", () => {
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("plan");
		expect(result.action).toBe("dispatch_planner");
	});

	test("returns error when plan is invalid", () => {
		writeFileSync(join(runDir, "master-spec.md"), "# spec");
		writeFileSync(join(runDir, "tasks.json"), JSON.stringify({ tasks: [{ id: "bad" }] }));
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("error");
		expect(result.detail).toContain("plan invalid");
	});
});

describe("planNext — nonexistent run", () => {
	test("returns error for nonexistent run", () => {
		const result = planNext({ runId: "nonexistent-run-id", projectDir });
		expect(result.phase).toBe("error");
		expect(result.action).toBe("surface");
		expect(result.detail).toContain("not found");
	});
});

describe("approvePhase", () => {
	test("awaits user when approval.md is missing", () => {
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "approve" }));
		writePlan([simpleTask("T-0001"), simpleTask("T-0002", "code-big")]);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("approve");
		expect(result.action).toBe("await_user");
	});

	test("advances to specialists when approval.md exists", () => {
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "approve" }));
		writePlan([simpleTask("T-0001")]);
		writeFileSync(join(runDir, "approval.md"), "Approved.\n");
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("specialists");
	});
});

describe("specialistsPhase", () => {
	test("dispatches pending tasks", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "specialists" }),
		);
		writePlan([simpleTask("T-0001")]);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("specialists");
		expect(result.action).toBe("dispatch");
		expect(result.ids).toContain("T-0001");
	});

	test("returns blocked when a task has failed", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "specialists" }),
		);
		writePlan([simpleTask("T-0001")]);
		const taskDir = join(runDir, "tasks", "T-0001");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(join(taskDir, "FAILED"), JSON.stringify({ reason: "max_iter" }));
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("specialists");
		expect(result.action).toBe("blocked");
	});

	test("returns done_specialists when all tasks approved", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "specialists" }),
		);
		writePlan([simpleTask("T-0001")]);
		const taskDir = join(runDir, "tasks", "T-0001");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(taskDir, "APPROVED"),
			JSON.stringify({ at: new Date().toISOString(), sentinel: { summary: "test" } }),
		);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("review");
		expect(result.action).toBe("dispatch_reviewer");
	});

	test("returns wait when tasks are running", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "specialists" }),
		);
		writePlan([
			simpleTask("T-0001"),
			simpleTask("T-0002"),
			simpleTask("T-0003"),
			simpleTask("T-0004"),
		]);
		for (const tid of ["T-0001", "T-0002", "T-0003"]) {
			const taskDir = join(runDir, "tasks", tid);
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(join(taskDir, "envelope.json"), "{}");
		}
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("specialists");
		expect(result.action).toBe("wait");
	});

	test("returns error when no tasks found", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "specialists" }),
		);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("error");
		expect(result.detail).toContain("no tasks");
	});
});

describe("reviewPhase", () => {
	test("dispatches reviewer when review.md missing", () => {
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "review" }));
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("review");
		expect(result.action).toBe("dispatch_reviewer");
	});

	test("advances to merge on PASS_ALL verdict", () => {
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "review" }));
		writePlan([simpleTask("T-0001")]);
		writeFileSync(
			join(runDir, "review.md"),
			"**Verdict:** PASS_ALL\n## T-0001\n**Verdict:** PASS\n",
		);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("merge");
		expect(result.action).toBe("run_merge");
	});

	test("returns auto_retry on CHANGES_REQUESTED verdict", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "review", review_pass: 0 }),
		);
		writePlan([simpleTask("T-0001")]);
		writeFileSync(
			join(runDir, "review.md"),
			"**Verdict:** CHANGES_REQUESTED\n\n## T-0001 (code-small) -- CHANGES_REQUESTED\nFix X.\n",
		);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("review");
		expect(result.action).toBe("auto_retry");
		expect(result.tasks).toBeInstanceOf(Array);
	});

	test("surfaces review directly when CHANGES_REQUESTED has no per-task failures (brief compliance gap)", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "review", review_pass: 0 }),
		);
		writePlan([simpleTask("T-0001")]);
		writeFileSync(
			join(runDir, "review.md"),
			"**Verdict:** CHANGES_REQUESTED\n\n## T-0001 (code-small) -- PASS\n- OK\n\n## Brief Compliance\n| Req | Status |\n|---|---|\n| Rate limiter | MISSING |\n",
		);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("review");
		expect(result.action).toBe("surface_review");
		expect(result.detail).toContain("brief compliance");
		expect(result.tasks).toBeUndefined();
	});

	test("BLOCK verdict surfaces review with retry option", () => {
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "review" }));
		writeFileSync(join(runDir, "review.md"), "**Verdict:** BLOCK\nSecurity issue.\n");
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("review");
		expect(result.action).toBe("surface_review");
		expect(result.detail).toContain("BLOCKED");
	});

	test("surfaces review with retry option after max review retries", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "review", review_pass: 1 }),
		);
		writePlan([simpleTask("T-0001")]);
		writeFileSync(
			join(runDir, "review.md"),
			"**Verdict:** CHANGES_REQUESTED\n## T-0001 — CHANGES_REQUESTED\nSome notes.\n",
		);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("review");
		expect(result.action).toBe("surface_review");
		expect(result.tasks).toContain("T-0001");
	});

	test("re-dispatches reviewer on unparseable verdict", () => {
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "review" }));
		writeFileSync(join(runDir, "review.md"), "No verdict line here.\n");
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("review");
		expect(result.action).toBe("dispatch_reviewer");
		expect(result.warning).toContain("no parseable verdict");
		expect(existsSync(join(runDir, "review.md"))).toBe(false);
	});
});

describe("planNext — terminal phases", () => {
	test("done phase returns summarise", () => {
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "done" }));
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("done");
		expect(result.action).toBe("summarise");
	});

	test("cancelled phase returns surface error", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "cancelled" }),
		);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("error");
		expect(result.detail).toContain("cancelled");
	});

	test("unknown phase returns error", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "UNKNOWN_PHASE" }),
		);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("error");
		expect(result.detail).toContain("unknown phase");
	});
});

describe("planNext — merge phase delegation", () => {
	test("merge phase with no merges dir advances to integration_test", () => {
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "merge" }));
		writePlan([simpleTask("T-0001")]);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("integration_test");
		expect(result.action).toBe("run_integration_test");
	});

	test("integration_test phase skips when no test command", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "integration_test" }),
		);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("done");
		expect(result.action).toBe("summarise");
		expect(result.integration_test).toBe("skipped");
	});
});

describe("planNext — budget warnings", () => {
	test("warns when output tokens exceed budget but does not stop the run", () => {
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "specialists" }),
		);
		writePlan([simpleTask("T-0001")]);
		const settingsDir = join(projectDir, ".lazy-dev");
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				budget: { per_run: { max_output_tokens: 10 } },
			}),
		);
		writeFileSync(
			join(runDir, "usage.json"),
			JSON.stringify({
				totals: {
					input_tokens: 0,
					output_tokens: 100,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
				},
				by_agent: {},
				by_model: {},
				by_effort: {},
				by_iteration: [],
			}),
		);

		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("specialists");
		expect(result.warning).toContain("exceeded budget");
	});
});

describe("planPhase — sibling plan reuse", () => {
	test("reuses plan from a cancelled sibling run", () => {
		const siblingId = "2026-04-18T00-00-00Z-sibling";
		const siblingDir = join(projectDir, ".lazy-dev", "runs", siblingId);
		mkdirSync(siblingDir, { recursive: true });
		writeFileSync(
			join(siblingDir, "status.json"),
			JSON.stringify({ run_id: siblingId, phase: "cancelled" }),
		);
		writeFileSync(join(siblingDir, "master-spec.md"), "# Reused spec");
		const siblingPlan = { tasks: [simpleTask("T-0001"), simpleTask("T-0002")] };
		writeFileSync(join(siblingDir, "tasks.json"), JSON.stringify(siblingPlan));

		const result = planNext({ runId, projectDir });
		expect(existsSync(join(runDir, "master-spec.md"))).toBe(true);
		expect(existsSync(join(runDir, "tasks.json"))).toBe(true);
		expect(readFileSync(join(runDir, "master-spec.md"), "utf8")).toBe("# Reused spec");
		expect(result.phase).toBe("specialists");
	});

	test("does not reuse plan from an active (specialists phase) sibling", () => {
		const siblingId = "2026-04-18T00-00-00Z-active";
		const siblingDir = join(projectDir, ".lazy-dev", "runs", siblingId);
		mkdirSync(siblingDir, { recursive: true });
		writeFileSync(
			join(siblingDir, "status.json"),
			JSON.stringify({ run_id: siblingId, phase: "specialists" }),
		);
		writeFileSync(join(siblingDir, "master-spec.md"), "# Active spec");
		writeFileSync(
			join(siblingDir, "tasks.json"),
			JSON.stringify({ tasks: [simpleTask("T-0001")] }),
		);

		const result = planNext({ runId, projectDir });
		expect(result.action).toBe("dispatch_planner");
	});

	test("does not reuse plan from sibling with empty tasks", () => {
		const siblingId = "2026-04-18T00-00-00Z-empty";
		const siblingDir = join(projectDir, ".lazy-dev", "runs", siblingId);
		mkdirSync(siblingDir, { recursive: true });
		writeFileSync(
			join(siblingDir, "status.json"),
			JSON.stringify({ run_id: siblingId, phase: "cancelled" }),
		);
		writeFileSync(join(siblingDir, "master-spec.md"), "# Empty spec");
		writeFileSync(join(siblingDir, "tasks.json"), JSON.stringify({ tasks: [] }));

		const result = planNext({ runId, projectDir });
		expect(result.action).toBe("dispatch_planner");
	});

	test("does not reuse plan from a sibling in approve phase", () => {
		const siblingId = "2026-04-18T00-00-00Z-approve";
		const siblingDir = join(projectDir, ".lazy-dev", "runs", siblingId);
		mkdirSync(siblingDir, { recursive: true });
		writeFileSync(
			join(siblingDir, "status.json"),
			JSON.stringify({ run_id: siblingId, phase: "approve" }),
		);
		writeFileSync(join(siblingDir, "master-spec.md"), "# Approve spec");
		writeFileSync(
			join(siblingDir, "tasks.json"),
			JSON.stringify({ tasks: [simpleTask("T-0001")] }),
		);

		const result = planNext({ runId, projectDir });
		expect(result.action).toBe("dispatch_planner");
	});

	test("skips symlinked sibling directories", () => {
		const realDir = mkdtempSync(join(tmpdir(), "lazy-dev-symlink-target-"));
		mkdirSync(join(realDir, "inner"), { recursive: true });
		writeFileSync(join(realDir, "inner", "status.json"), JSON.stringify({ phase: "cancelled" }));
		writeFileSync(join(realDir, "inner", "master-spec.md"), "# Symlinked spec");
		writeFileSync(
			join(realDir, "inner", "tasks.json"),
			JSON.stringify({ tasks: [simpleTask("T-0001")] }),
		);

		const linkPath = join(projectDir, ".lazy-dev", "runs", "2026-04-18T00-00-00Z-linked");
		symlinkSync(join(realDir, "inner"), linkPath);

		const result = planNext({ runId, projectDir });
		expect(result.action).toBe("dispatch_planner");
		rmSync(realDir, { recursive: true, force: true });
	});

	test("surfaces reused_from in gate response", () => {
		const siblingId = "2026-04-18T00-00-00Z-reuse-signal";
		const siblingDir = join(projectDir, ".lazy-dev", "runs", siblingId);
		mkdirSync(siblingDir, { recursive: true });
		writeFileSync(
			join(siblingDir, "status.json"),
			JSON.stringify({ run_id: siblingId, phase: "cancelled" }),
		);
		const bigTask = { ...simpleTask("T-0001", "code-big"), effort: "high", depends_on: [] };
		const dep = { ...simpleTask("T-0002"), depends_on: ["T-0001"] };
		const thirdTask = { ...simpleTask("T-0003"), depends_on: ["T-0001"] };
		writeFileSync(join(siblingDir, "master-spec.md"), "# Reuse signal spec\n\n## Problem\nTest\n");
		writeFileSync(
			join(siblingDir, "tasks.json"),
			JSON.stringify({ tasks: [bigTask, dep, thirdTask] }),
		);

		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("approve");
		expect(result.reused_from).toBe(siblingId);
	});

	test("prefers most recent sibling when multiple are available", () => {
		const oldId = "2026-04-17T00-00-00Z-old";
		const newId = "2026-04-18T00-00-00Z-new";
		for (const [id, spec] of [
			[oldId, "# Old spec"],
			[newId, "# New spec"],
		]) {
			const d = join(projectDir, ".lazy-dev", "runs", id);
			mkdirSync(d, { recursive: true });
			writeFileSync(d + "/status.json", JSON.stringify({ run_id: id, phase: "cancelled" }));
			writeFileSync(d + "/master-spec.md", spec);
			writeFileSync(d + "/tasks.json", JSON.stringify({ tasks: [simpleTask("T-0001")] }));
		}

		planNext({ runId, projectDir });
		const spec = readFileSync(join(runDir, "master-spec.md"), "utf8");
		expect(spec).toBe("# New spec");
	});
});
