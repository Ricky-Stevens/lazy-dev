import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listRuns, statusForRun } from "./status.js";

const CLI_PATH = resolve(import.meta.dirname, "status.js");

let tmpDir;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "status-test-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupRun(pd, runId, phase, tasks = []) {
	const runDir = join(pd, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		join(runDir, "status.json"),
		JSON.stringify({ run_id: runId, phase }),
	);
	for (const t of tasks) {
		const taskDir = join(runDir, "tasks", t.id);
		mkdirSync(taskDir, { recursive: true });
		if (t.approved) writeFileSync(join(taskDir, "APPROVED"), "{}");
		if (t.failed) writeFileSync(join(taskDir, "FAILED"), JSON.stringify({ reason: t.failReason || "test" }));
		if (t.envelope) writeFileSync(join(taskDir, "envelope.json"), "{}");
	}
	return runDir;
}

describe("statusForRun", () => {
	test("returns run status with task counts", () => {
		const pd = join(tmpDir, "s1");
		setupRun(pd, "run-1", "specialists", [
			{ id: "T-0001", approved: true },
			{ id: "T-0002", failed: true, failReason: "verifier_failed" },
			{ id: "T-0003", envelope: true },
		]);

		const result = statusForRun({ runId: "run-1", projectDir: pd });
		expect(result.run_id).toBe("run-1");
		expect(result.phase).toBe("specialists");
		expect(result.tasks.approved).toBe(1);
		expect(result.tasks.failed).toBe(1);
		expect(result.tasks.running).toBe(1);
		expect(result.failed_tasks).toHaveLength(1);
		expect(result.failed_tasks[0].id).toBe("T-0002");
	});

	test("throws for nonexistent run", () => {
		expect(() => statusForRun({ runId: "nonexistent", projectDir: tmpDir })).toThrow();
	});

	test("returns usage data", () => {
		const pd = join(tmpDir, "s2");
		setupRun(pd, "run-2", "done");
		const result = statusForRun({ runId: "run-2", projectDir: pd });
		expect(result.usage).toBeDefined();
		expect(result.usage.input_tokens).toBeDefined();
	});

	test("handles run with no tasks dir", () => {
		const pd = join(tmpDir, "s3");
		const runDir = join(pd, ".lazy-dev", "runs", "run-3");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "plan" }));

		const result = statusForRun({ runId: "run-3", projectDir: pd });
		expect(result.tasks.approved).toBe(0);
		expect(result.tasks.failed).toBe(0);
		expect(result.tasks.running).toBe(0);
	});

	test("handles FAILED marker with unparseable JSON", () => {
		const pd = join(tmpDir, "s4");
		const runDir = join(pd, ".lazy-dev", "runs", "run-4");
		mkdirSync(join(runDir, "tasks", "T-0001"), { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "done" }));
		writeFileSync(join(runDir, "tasks", "T-0001", "FAILED"), "not json");

		const result = statusForRun({ runId: "run-4", projectDir: pd });
		expect(result.tasks.failed).toBe(1);
		expect(result.failed_tasks[0].reason).toBe("unknown");
	});

	test("includes usage by_agent breakdown", () => {
		const pd = join(tmpDir, "s5");
		const runDir = join(pd, ".lazy-dev", "runs", "run-5");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "done" }));
		writeFileSync(join(runDir, "usage.json"), JSON.stringify({
			totals: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_creation_tokens: 5 },
			by_agent: {
				"lazy-dev:code-small": { calls: 2, input_tokens: 100, output_tokens: 50, cache_read_tokens: 10 },
			},
			by_model: {},
			by_effort: {},
			by_iteration: [],
		}));

		const result = statusForRun({ runId: "run-5", projectDir: pd });
		expect(result.usage.input_tokens).toBe(100);
		expect(result.usage.output_tokens).toBe(50);
		expect(result.usage.by_agent["lazy-dev:code-small"]).toBeDefined();
		expect(result.usage.by_agent["lazy-dev:code-small"].calls).toBe(2);
	});
});

describe("listRuns", () => {
	test("returns empty array when no runs dir", () => {
		const result = listRuns({ projectDir: join(tmpDir, "empty") });
		expect(result.runs).toEqual([]);
	});

	test("returns runs sorted newest first", () => {
		const pd = join(tmpDir, "list1");
		setupRun(pd, "run-a", "done");
		setupRun(pd, "run-b", "specialists");

		const result = listRuns({ projectDir: pd });
		expect(result.runs.length).toBe(2);
		expect(result.runs[0].phase).toBeDefined();
	});

	test("skips _ prefixed directories", () => {
		const pd = join(tmpDir, "list2");
		setupRun(pd, "real-run", "done");
		mkdirSync(join(pd, ".lazy-dev", "runs", "_gate-log"), { recursive: true });

		const result = listRuns({ projectDir: pd });
		expect(result.runs.every((r) => !r.run_id.startsWith("_"))).toBe(true);
	});

	test("includes review_pass and integration_test from status", () => {
		const pd = join(tmpDir, "list3");
		const runDir = join(pd, ".lazy-dev", "runs", "run-detail");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ phase: "done", review_pass: 2, integration_test: { passed: true } }),
		);

		const result = listRuns({ projectDir: pd });
		const run = result.runs.find((r) => r.run_id === "run-detail");
		expect(run.review_pass).toBe(2);
		expect(run.integration_test.passed).toBe(true);
	});
});

describe("status CLI", () => {
	test("CLI lists runs without run_id", () => {
		const pd = join(tmpDir, "cli-s1");
		setupRun(pd, "run-cli-1", "done");

		const result = spawnSync("node", [CLI_PATH], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: pd },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
		expect(output.runs).toBeInstanceOf(Array);
	});

	test("CLI shows run status with run_id", () => {
		const pd = join(tmpDir, "cli-s2");
		setupRun(pd, "run-cli-2", "specialists");

		const result = spawnSync("node", [CLI_PATH, "run-cli-2"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: pd },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
		expect(output.run_id).toBe("run-cli-2");
	});

	test("CLI returns error for nonexistent run", () => {
		const result = spawnSync("node", [CLI_PATH, "nonexistent"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
	});
});
