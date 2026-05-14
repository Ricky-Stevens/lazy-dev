import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doctor } from "./doctor.js";

const CLI_PATH = resolve(import.meta.dirname, "doctor.js");

let tmpDir;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "doctor-test-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupDoctorRun(pd, runId, opts = {}) {
	const runDir = join(pd, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	if (opts.status) {
		writeFileSync(join(runDir, "status.json"), JSON.stringify(opts.status));
	}
	if (opts.tasks) {
		for (const t of opts.tasks) {
			const td = join(runDir, "tasks", t.id);
			mkdirSync(td, { recursive: true });
			if (t.approved) writeFileSync(join(td, "APPROVED"), "{}");
			if (t.failed) writeFileSync(join(td, "FAILED"), "{}");
			if (t.retry) writeFileSync(join(td, "RETRY"), "{}");
			if (t.envelope) writeFileSync(join(td, "envelope.json"), "{}");
			if (t.state) writeFileSync(join(td, "state.json"), JSON.stringify(t.state));
			if (t.diffSize) writeFileSync(join(td, "diff.patch"), "x".repeat(t.diffSize));
		}
	}
	if (opts.usage) {
		writeFileSync(join(runDir, "usage.json"), JSON.stringify(opts.usage));
	}
	if (opts.gateLog) {
		const logDir = join(pd, ".lazy-dev", "runs", "_gate-log");
		mkdirSync(logDir, { recursive: true });
		writeFileSync(join(logDir, "gate-debug.log"), opts.gateLog);
	}
	return runDir;
}

describe("doctor", () => {
	test("returns 'no runs found' when empty", () => {
		const pd = join(tmpDir, "d-empty");
		mkdirSync(pd, { recursive: true });
		const result = doctor({ projectDir: pd });
		expect(result).toContain("no runs found");
	});

	test("returns 'not found' for nonexistent run_id", () => {
		const pd = join(tmpDir, "d-nf");
		mkdirSync(join(pd, ".lazy-dev", "runs"), { recursive: true });
		const result = doctor({ runId: "does-not-exist", projectDir: pd });
		expect(result).toContain("not found");
	});

	test("includes status.json data", () => {
		const pd = join(tmpDir, "d1");
		setupDoctorRun(pd, "run-d1", {
			status: { phase: "specialists", review_pass: 1 },
		});

		const report = doctor({ runId: "run-d1", projectDir: pd });
		expect(report).toContain("phase: specialists");
		expect(report).toContain("review_pass: 1");
	});

	test("includes integration_test status", () => {
		const pd = join(tmpDir, "d-it");
		setupDoctorRun(pd, "run-it", {
			status: { phase: "done", integration_test: { passed: true } },
		});

		const report = doctor({ runId: "run-it", projectDir: pd });
		expect(report).toContain("integration_test: PASS");
	});

	test("reports failed integration test with exit code", () => {
		const pd = join(tmpDir, "d-itf");
		setupDoctorRun(pd, "run-itf", {
			status: { phase: "error", integration_test: { passed: false, exit_code: 1 } },
		});

		const report = doctor({ runId: "run-itf", projectDir: pd });
		expect(report).toContain("FAIL (exit 1)");
	});

	test("reports skipped integration test", () => {
		const pd = join(tmpDir, "d-its");
		setupDoctorRun(pd, "run-its", {
			status: { phase: "done", integration_test: { skipped: true } },
		});

		const report = doctor({ runId: "run-its", projectDir: pd });
		expect(report).toContain("skipped");
	});

	test("includes task markers", () => {
		const pd = join(tmpDir, "d2");
		setupDoctorRun(pd, "run-d2", {
			status: { phase: "done" },
			tasks: [
				{ id: "T-0001", approved: true, diffSize: 500 },
				{ id: "T-0002", failed: true },
			],
		});

		const report = doctor({ runId: "run-d2", projectDir: pd });
		expect(report).toContain("T-0001");
		expect(report).toContain("APPROVED");
		expect(report).toContain("T-0002");
		expect(report).toContain("FAILED");
		expect(report).toContain("500B");
	});

	test("includes usage totals", () => {
		const pd = join(tmpDir, "d3");
		setupDoctorRun(pd, "run-d3", {
			status: { phase: "done" },
			usage: {
				totals: {
					input_tokens: 1000,
					output_tokens: 500,
					cache_read_tokens: 200,
					cache_creation_tokens: 100,
				},
				by_agent: {},
				by_model: {},
				by_effort: {},
				by_iteration: [],
			},
		});

		const report = doctor({ runId: "run-d3", projectDir: pd });
		expect(report).toContain("input=1000");
		expect(report).toContain("output=500");
	});

	test("includes by_agent breakdown", () => {
		const pd = join(tmpDir, "d4");
		setupDoctorRun(pd, "run-d4", {
			status: { phase: "done" },
			usage: {
				totals: {
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
				},
				by_agent: {
					"lazy-dev:code-small": {
						calls: 3,
						input_tokens: 100,
						output_tokens: 50,
						cache_read_tokens: 10,
					},
				},
				by_model: {},
				by_effort: {},
				by_iteration: [],
			},
		});

		const report = doctor({ runId: "run-d4", projectDir: pd });
		expect(report).toContain("lazy-dev:code-small");
		expect(report).toContain("calls=3");
	});

	test("includes by_model breakdown", () => {
		const pd = join(tmpDir, "d5");
		setupDoctorRun(pd, "run-d5", {
			status: { phase: "done" },
			usage: {
				totals: {
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
				},
				by_agent: {},
				by_model: {
					"claude-sonnet": { calls: 1, input_tokens: 100, output_tokens: 50, cache_read_tokens: 0 },
				},
				by_effort: {},
				by_iteration: [],
			},
		});

		const report = doctor({ runId: "run-d5", projectDir: pd });
		expect(report).toContain("claude-sonnet");
	});

	test("includes by_effort breakdown", () => {
		const pd = join(tmpDir, "d6");
		setupDoctorRun(pd, "run-d6", {
			status: { phase: "done" },
			usage: {
				totals: {
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
				},
				by_agent: {},
				by_model: {},
				by_effort: {
					high: { calls: 2, input_tokens: 200, output_tokens: 100, cache_read_tokens: 0 },
				},
				by_iteration: [],
			},
		});

		const report = doctor({ runId: "run-d6", projectDir: pd });
		expect(report).toContain("high:");
	});

	test("reports model mismatches", () => {
		const pd = join(tmpDir, "d7");
		setupDoctorRun(pd, "run-d7", {
			status: { phase: "done" },
			usage: {
				totals: {
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
				},
				by_agent: {},
				by_model: {},
				by_effort: {},
				by_iteration: [
					{
						agent_type: "lazy-dev:code-small",
						task_id: "T-0001",
						model_expected: "claude-haiku",
						model_actual: "claude-sonnet",
						model_mismatch: true,
					},
				],
			},
		});

		const report = doctor({ runId: "run-d7", projectDir: pd });
		expect(report).toContain("MODEL MISMATCHES");
		expect(report).toContain("claude-haiku");
		expect(report).toContain("claude-sonnet");
	});

	test("includes gate-debug.log tail", () => {
		const pd = join(tmpDir, "d8");
		setupDoctorRun(pd, "run-d8", {
			status: { phase: "done" },
			gateLog: "line1\nline2\nline3\n",
		});

		const report = doctor({ runId: "run-d8", projectDir: pd });
		expect(report).toContain("gate-debug.log");
		expect(report).toContain("line1");
	});

	test("auto-selects most recent run when runId omitted", () => {
		const pd = join(tmpDir, "d-auto");
		setupDoctorRun(pd, "auto-run", { status: { phase: "plan" } });

		const report = doctor({ projectDir: pd });
		expect(report).toContain("auto-run");
	});

	test("handles missing status.json gracefully", () => {
		const pd = join(tmpDir, "d-nostatus");
		const runDir = join(pd, ".lazy-dev", "runs", "no-status-run");
		mkdirSync(runDir, { recursive: true });

		const report = doctor({ runId: "no-status-run", projectDir: pd });
		expect(report).toContain("missing or invalid");
	});

	test("includes task state iteration and wall clock", () => {
		const pd = join(tmpDir, "d-state");
		setupDoctorRun(pd, "run-state", {
			status: { phase: "done" },
			tasks: [
				{
					id: "T-0001",
					approved: true,
					state: {
						iteration: 2,
						dispatched_at: "2025-01-01T00:00:00Z",
						completed_at: "2025-01-01T00:01:30Z",
						history: [{ failing_signature: "abc" }],
					},
				},
			],
		});

		const report = doctor({ runId: "run-state", projectDir: pd });
		expect(report).toContain("iter=2");
		expect(report).toContain("1m30s");
		expect(report).toContain("failing=abc");
	});

	test("includes gate payload summaries", () => {
		const pd = join(tmpDir, "d-payloads");
		setupDoctorRun(pd, "run-payloads", { status: { phase: "done" } });
		const logDir = join(pd, ".lazy-dev", "runs", "_gate-log");
		mkdirSync(logDir, { recursive: true });
		writeFileSync(
			join(logDir, "2025-01-01T00-00-00-000Z-123.payload.json"),
			JSON.stringify({ agent_type: "lazy-dev:code-small" }),
		);

		const report = doctor({ runId: "run-payloads", projectDir: pd });
		expect(report).toContain("gate payloads");
		expect(report).toContain("code-small");
	});

	test("truncates long reports", () => {
		const pd = join(tmpDir, "d-long");
		setupDoctorRun(pd, "run-long", {
			status: { phase: "done" },
			usage: {
				totals: {
					input_tokens: 0,
					output_tokens: 0,
					cache_read_tokens: 0,
					cache_creation_tokens: 0,
				},
				by_agent: {},
				by_model: {},
				by_effort: {},
				by_iteration: [],
			},
		});
		const report = doctor({ runId: "run-long", projectDir: pd });
		expect(typeof report).toBe("string");
	});

	test("formats wall clock for seconds only", () => {
		const pd = join(tmpDir, "d-secs");
		setupDoctorRun(pd, "run-secs", {
			status: { phase: "done" },
			tasks: [
				{
					id: "T-0001",
					approved: true,
					state: {
						iteration: 1,
						dispatched_at: "2025-01-01T00:00:00Z",
						completed_at: "2025-01-01T00:00:45Z",
						history: [],
					},
				},
			],
		});
		const report = doctor({ runId: "run-secs", projectDir: pd });
		expect(report).toContain("45s");
	});
});

describe("doctor CLI", () => {
	test("CLI runs with explicit run_id", () => {
		const pd = join(tmpDir, "cli-d1");
		setupDoctorRun(pd, "run-cli-doc", { status: { phase: "done" } });

		const result = spawnSync("node", [CLI_PATH, "run-cli-doc"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: pd },
			timeout: 10_000,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("run-cli-doc");
	});

	test("CLI auto-selects most recent run", () => {
		const pd = join(tmpDir, "cli-d2");
		setupDoctorRun(pd, "run-cli-auto", { status: { phase: "plan" } });

		const result = spawnSync("node", [CLI_PATH], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: pd },
			timeout: 10_000,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("run-cli-auto");
	});
});
