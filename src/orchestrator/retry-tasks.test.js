import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { retryTasks } from "./retry-tasks.js";

const CLI_PATH = resolve(import.meta.dirname, "retry-tasks.js");

let tmpDir;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "retry-tasks-test-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupRetryRun(pd, runId, taskIds, reviewMd = null) {
	const runDir = join(pd, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		join(runDir, "status.json"),
		JSON.stringify({ phase: "review", run_id: runId }),
	);
	for (const tid of taskIds) {
		const taskDir = join(runDir, "tasks", tid);
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(taskDir, "envelope.json"),
			JSON.stringify({ id: tid, task_id: tid, agent: "code-small" }),
		);
		writeFileSync(join(taskDir, "APPROVED"), "{}");
		writeFileSync(join(taskDir, "state.json"), JSON.stringify({ iteration: 1 }));
	}
	if (reviewMd) {
		writeFileSync(join(runDir, "review.md"), reviewMd);
	}
	return runDir;
}

describe("retryTasks", () => {
	test("resets tasks and archives review.md", () => {
		const pd = join(tmpDir, "r1");
		const runDir = setupRetryRun(pd, "run-r1", ["T-0001", "T-0002"], "# Review\n## T-0001\nFix imports\n## T-0002\nAdd tests\n");

		const result = retryTasks({ runId: "run-r1", taskIds: ["T-0001", "T-0002"], projectDir: pd });
		expect(result.reset).toEqual(["T-0001", "T-0002"]);

		expect(existsSync(join(runDir, "review.md"))).toBe(false);
		expect(existsSync(join(runDir, "review-prev.md"))).toBe(true);

		const t1Dir = join(runDir, "tasks", "T-0001");
		expect(existsSync(join(t1Dir, "APPROVED"))).toBe(false);
		expect(existsSync(join(t1Dir, "state.json"))).toBe(false);
		expect(existsSync(join(t1Dir, "RETRY"))).toBe(true);

		const envelope = JSON.parse(readFileSync(join(t1Dir, "envelope.json"), "utf8"));
		expect(envelope.reviewer_notes).toContain("Fix imports");

		const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
		expect(status.phase).toBe("specialists");
	});

	test("uses default note when review.md has no per-task section", () => {
		const pd = join(tmpDir, "r2");
		setupRetryRun(pd, "run-r2", ["T-0001"], "# Review\nGeneral feedback only.\n");

		retryTasks({ runId: "run-r2", taskIds: ["T-0001"], projectDir: pd });

		const envelope = JSON.parse(
			readFileSync(join(pd, ".lazy-dev", "runs", "run-r2", "tasks", "T-0001", "envelope.json"), "utf8"),
		);
		expect(envelope.reviewer_notes).toContain("review.md");
	});

	test("works when no review.md exists", () => {
		const pd = join(tmpDir, "r3");
		setupRetryRun(pd, "run-r3", ["T-0001"]);

		const result = retryTasks({ runId: "run-r3", taskIds: ["T-0001"], projectDir: pd });
		expect(result.reset).toEqual(["T-0001"]);
	});

	test("throws on missing envelope", () => {
		const pd = join(tmpDir, "r4");
		const runDir = join(pd, ".lazy-dev", "runs", "run-r4");
		mkdirSync(join(runDir, "tasks", "T-0001"), { recursive: true });
		writeFileSync(join(runDir, "status.json"), "{}");

		expect(() =>
			retryTasks({ runId: "run-r4", taskIds: ["T-0001"], projectDir: pd }),
		).toThrow("envelope missing");
	});

	test("validates run_id", () => {
		expect(() =>
			retryTasks({ runId: "../escape", taskIds: ["T-0001"], projectDir: tmpDir }),
		).toThrow();
	});

	test("validates task_ids array", () => {
		expect(() =>
			retryTasks({ runId: "run-1", taskIds: [], projectDir: tmpDir }),
		).toThrow();
	});

	test("RETRY marker contains timestamp and reason", () => {
		const pd = join(tmpDir, "r5");
		setupRetryRun(pd, "run-r5", ["T-0001"]);

		retryTasks({ runId: "run-r5", taskIds: ["T-0001"], projectDir: pd });

		const retry = JSON.parse(
			readFileSync(join(pd, ".lazy-dev", "runs", "run-r5", "tasks", "T-0001", "RETRY"), "utf8"),
		);
		expect(retry.at).toBeDefined();
		expect(retry.reason).toBe("reviewer_changes_requested");
	});
});

describe("retry-tasks CLI", () => {
	test("CLI resets tasks", () => {
		const pd = join(tmpDir, "cli-r1");
		setupRetryRun(pd, "run-cli-retry", ["T-0001"]);

		const result = spawnSync("node", [CLI_PATH, "run-cli-retry", "T-0001"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: pd },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
		expect(output.reset).toEqual(["T-0001"]);
	});

	test("CLI returns usage error without args", () => {
		const result = spawnSync("node", [CLI_PATH], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
		expect(output.detail).toContain("usage");
	});
});
