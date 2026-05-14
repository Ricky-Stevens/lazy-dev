import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationTestPhase, mergePhase } from "./plan-next-merge.js";

let tmpDir;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "plan-next-merge-test-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("mergePhase", () => {
	test("surfaces error when a merger has FAILED marker", () => {
		const pd = join(tmpDir, "mp1");
		const runDir = join(pd, ".lazy-dev", "runs", "run-mp1");
		const mergesDir = join(runDir, "merges", "M-0001-T-0001");
		mkdirSync(mergesDir, { recursive: true });
		writeFileSync(join(mergesDir, "FAILED"), "{}");

		const ctx = { runDir, runId: "run-mp1", projectDir: pd };
		const result = mergePhase(ctx, {
			loadTasks: () => [],
			advancePhase: () => {},
		});

		expect(result.phase).toBe("error");
		expect(result.action).toBe("surface");
		expect(result.detail).toContain("M-0001-T-0001");
	});

	test("dispatches unapproved merger", () => {
		const pd = join(tmpDir, "mp2");
		const runDir = join(pd, ".lazy-dev", "runs", "run-mp2");
		const mergesDir = join(runDir, "merges", "M-0001-T-0001");
		mkdirSync(mergesDir, { recursive: true });
		writeFileSync(join(mergesDir, "envelope.json"), "{}");

		const ctx = { runDir, runId: "run-mp2", projectDir: pd };
		const result = mergePhase(ctx, {
			loadTasks: () => [],
			advancePhase: () => {},
		});

		expect(result.phase).toBe("merge");
		expect(result.action).toBe("dispatch_merger");
		expect(result.merge_id).toBe("M-0001-T-0001");
	});

	test("skips approved mergers and continues", () => {
		const pd = join(tmpDir, "mp3");
		const runDir = join(pd, ".lazy-dev", "runs", "run-mp3");
		const mergesDir = join(runDir, "merges", "M-0001-T-0001");
		mkdirSync(mergesDir, { recursive: true });
		writeFileSync(join(mergesDir, "APPROVED"), "{}");
		mkdirSync(join(runDir, "tasks"), { recursive: true });

		let advancedTo = null;
		const ctx = { runDir, runId: "run-mp3", projectDir: pd };
		const result = mergePhase(ctx, {
			loadTasks: () => [],
			advancePhase: (_ctx, phase) => {
				advancedTo = phase;
			},
		});

		expect(result.phase).toBe("integration_test");
		expect(result.action).toBe("run_integration_test");
		expect(advancedTo).toBe("integration_test");
	});

	test("filters out non-directory entries in merges dir", () => {
		const pd = join(tmpDir, "mp-filter");
		const runDir = join(pd, ".lazy-dev", "runs", "run-filter");
		const mergesDir = join(runDir, "merges");
		mkdirSync(mergesDir, { recursive: true });
		writeFileSync(join(mergesDir, "stray-file.txt"), "not a dir");

		let advancedTo = null;
		const ctx = { runDir, runId: "run-filter", projectDir: pd };
		const result = mergePhase(ctx, {
			loadTasks: () => [],
			advancePhase: (_ctx, phase) => {
				advancedTo = phase;
			},
		});

		expect(result.phase).toBe("integration_test");
		expect(advancedTo).toBe("integration_test");
	});

	test("proceeds to integration_test when no merges dir exists", () => {
		const pd = join(tmpDir, "mp4");
		const runDir = join(pd, ".lazy-dev", "runs", "run-mp4");
		mkdirSync(runDir, { recursive: true });

		let advancedTo = null;
		const ctx = { runDir, runId: "run-mp4", projectDir: pd };
		const result = mergePhase(ctx, {
			loadTasks: () => [],
			advancePhase: (_ctx, phase) => {
				advancedTo = phase;
			},
		});

		expect(result.phase).toBe("integration_test");
		expect(advancedTo).toBe("integration_test");
	});
});

describe("integrationTestPhase", () => {
	test("skips when no test command is detected", () => {
		const pd = join(tmpDir, "it1");
		const runDir = join(pd, ".lazy-dev", "runs", "run-it1");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));

		let advancedTo = null;
		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, {
			advancePhase: (_ctx, phase) => {
				advancedTo = phase;
			},
		});

		expect(result.phase).toBe("done");
		expect(result.action).toBe("summarise");
		expect(result.integration_test).toBe("skipped");
		expect(advancedTo).toBe("done");

		const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
		expect(status.integration_test.skipped).toBe(true);
	});

	test("detects bun test command when bun.lockb exists", () => {
		const pd = join(tmpDir, "it2");
		const runDir = join(pd, ".lazy-dev", "runs", "run-it2");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
		writeFileSync(join(pd, "bun.lockb"), "");

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, {
			advancePhase: () => {},
		});

		expect(result.integration_test).toBeDefined();
	});

	test("detects go test command", () => {
		const pd = join(tmpDir, "it3");
		const runDir = join(pd, ".lazy-dev", "runs", "run-it3");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "go.mod"), "module test\n");

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, {
			advancePhase: () => {},
		});

		expect(result.integration_test).toBeDefined();
	});

	test("detects pytest command", () => {
		const pd = join(tmpDir, "it4");
		const runDir = join(pd, ".lazy-dev", "runs", "run-it4");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "pyproject.toml"), "[tool.pytest]\n");

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, {
			advancePhase: () => {},
		});

		expect(result.integration_test).toBeDefined();
	});

	test("detects pnpm test when pnpm-lock.yaml exists", () => {
		const pd = join(tmpDir, "it-pnpm");
		const runDir = join(pd, ".lazy-dev", "runs", "run-pnpm");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
		writeFileSync(join(pd, "pnpm-lock.yaml"), "lockfileVersion: 5.4\n");

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, { advancePhase: () => {} });
		expect(result.integration_test).toBeDefined();
	});

	test("detects yarn test when yarn.lock exists", () => {
		const pd = join(tmpDir, "it-yarn");
		const runDir = join(pd, ".lazy-dev", "runs", "run-yarn");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
		writeFileSync(join(pd, "yarn.lock"), "# yarn lockfile v1\n");

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, { advancePhase: () => {} });
		expect(result.integration_test).toBeDefined();
	});

	test("falls back to npm test when no lockfile found", () => {
		const pd = join(tmpDir, "it-npm");
		const runDir = join(pd, ".lazy-dev", "runs", "run-npm");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, { advancePhase: () => {} });
		expect(result.integration_test).toBeDefined();
	});

	test("detects bun test when bun.lockb exists without scripts.test", () => {
		const pd = join(tmpDir, "it-bun-notest");
		const runDir = join(pd, ".lazy-dev", "runs", "run-bun-notest");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(pd, "bun.lockb"), "");

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, { advancePhase: () => {} });
		expect(result.integration_test).toBeDefined();
	});

	test("detects bun test when bun.lock exists without scripts.test", () => {
		const pd = join(tmpDir, "it-bun-lock-notest");
		const runDir = join(pd, ".lazy-dev", "runs", "run-bun-lock-notest");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(pd, "bun.lock"), "");

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, { advancePhase: () => {} });
		expect(result.integration_test).toBeDefined();
	});

	test("detects pytest.ini", () => {
		const pd = join(tmpDir, "it-pytestini");
		const runDir = join(pd, ".lazy-dev", "runs", "run-pytestini");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "pytest.ini"), "[pytest]\n");

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, { advancePhase: () => {} });
		expect(result.integration_test).toBeDefined();
	});

	test("handles successful test command", () => {
		const pd = join(tmpDir, "it-pass");
		const runDir = join(pd, ".lazy-dev", "runs", "run-pass");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "package.json"), JSON.stringify({ scripts: { test: "true" } }));

		let advancedTo = null;
		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, {
			advancePhase: (_ctx, phase) => {
				advancedTo = phase;
			},
		});

		expect(result.phase).toBe("done");
		expect(result.action).toBe("summarise");
		expect(result.integration_test.passed).toBe(true);
		expect(advancedTo).toBe("done");
	});

	test("handles failed test command", () => {
		const pd = join(tmpDir, "it-fail");
		const runDir = join(pd, ".lazy-dev", "runs", "run-fail");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "package.json"), JSON.stringify({ scripts: { test: "false" } }));
		writeFileSync(join(pd, "bun.lockb"), "");

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, { advancePhase: () => {} });
		expect(result.phase).toBe("error");
		expect(result.action).toBe("surface");
		expect(result.detail).toContain("integration test failed");
	});

	test("handles corrupt package.json gracefully", () => {
		const pd = join(tmpDir, "it-corrupt");
		const runDir = join(pd, ".lazy-dev", "runs", "run-corrupt");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "integration_test" }));
		writeFileSync(join(pd, "package.json"), "not json{");
		writeFileSync(join(pd, "bun.lockb"), "");

		const ctx = { runDir, projectDir: pd };
		const result = integrationTestPhase(ctx, { advancePhase: () => {} });
		expect(result.integration_test).toBeDefined();
	});
});
