import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	scope: { allowed_paths: [`src/${id}.js`] },
	completion_criteria: [{ id: "exists", kind: "file_exists", path: `src/${id}.js` }],
	budget: { max_iter: 3 },
});

describe("planPhase auto-approval", () => {
	test("simple plan (≤3 tasks, no code-big) auto-approves and advances to specialists", () => {
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

	test("plan with >3 tasks emits show_gate", () => {
		writePlan([
			simpleTask("T-0001"),
			simpleTask("T-0002"),
			simpleTask("T-0003"),
			simpleTask("T-0004"),
		]);
		const result = planNext({ runId, projectDir });
		expect(result.action).toBe("show_gate");
		expect(existsSync(join(runDir, "approval.md"))).toBe(false);
	});

	test("single-task simple plan auto-approves", () => {
		writePlan([simpleTask("T-0001")]);
		const result = planNext({ runId, projectDir });
		expect(result.phase).toBe("specialists");
		expect(existsSync(join(runDir, "approval.md"))).toBe(true);
	});
});
