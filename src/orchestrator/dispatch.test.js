import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dispatch } from "./dispatch.js";

const CLI_PATH = resolve(import.meta.dirname, "dispatch.js");

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "dispatch-test-"));
	execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: projectDir, stdio: "ignore" });
	writeFileSync(join(projectDir, "README.md"), "init\n");
	execFileSync("git", ["add", "."], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function setupDispatchRun(runId, tasks) {
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		join(runDir, "tasks.json"),
		JSON.stringify({ tasks }),
	);
	writeFileSync(
		join(runDir, "status.json"),
		JSON.stringify({ run_id: runId, phase: "specialists" }),
	);
	return runDir;
}

describe("dispatch", () => {
	test("validates run_id", () => {
		expect(() => dispatch({ runId: "../bad", taskId: "T-0001", projectDir })).toThrow();
	});

	test("validates task_id", () => {
		expect(() => dispatch({ runId: "run-1", taskId: "../../etc", projectDir })).toThrow();
	});

	test("throws when tasks.json is missing", () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-no-tasks");
		mkdirSync(runDir, { recursive: true });

		expect(() =>
			dispatch({ runId: "run-no-tasks", taskId: "T-0001", projectDir }),
		).toThrow("tasks.json missing");
	});

	test("throws when task not found in plan", () => {
		setupDispatchRun("run-missing-task", [{ id: "T-0001", agent: "code-small" }]);

		expect(() =>
			dispatch({ runId: "run-missing-task", taskId: "T-9999", projectDir }),
		).toThrow("not found in run state");
	});

	test("throws when dependency is not approved", () => {
		setupDispatchRun("run-dep-fail", [
			{ id: "T-0001", agent: "code-small" },
			{ id: "T-0002", agent: "code-small", depends_on: ["T-0001"] },
		]);
		const taskDir = join(projectDir, ".lazy-dev", "runs", "run-dep-fail", "tasks", "T-0001");
		mkdirSync(taskDir, { recursive: true });

		expect(() =>
			dispatch({ runId: "run-dep-fail", taskId: "T-0002", projectDir }),
		).toThrow("not approved");
	});
});

describe("dispatch — full round-trip with worktree", () => {
	test("creates worktree and writes envelope for independent task", () => {
		const pluginRoot = resolve(import.meta.dirname, "..", "..");
		const savedPR = process.env.CLAUDE_PLUGIN_ROOT;
		process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
		try {
			setupDispatchRun("run-full", [
				{ id: "T-0001", agent: "code-small", title: "Test task" },
			]);

			const result = dispatch({ runId: "run-full", taskId: "T-0001", projectDir });
			expect(result.agent).toBe("code-small");
			expect(result.agent_namespaced).toBe("lazy-dev:code-small");
			expect(result.task_id).toBe("T-0001");
			expect(result.worktree).toBeDefined();
			expect(result.envelope_path).toContain("envelope.json");
			expect(result.dispatch_prompt).toContain("Envelope:");
			expect(existsSync(result.envelope_path)).toBe(true);
			expect(existsSync(result.worktree)).toBe(true);

			const envelope = JSON.parse(readFileSync(result.envelope_path, "utf8"));
			expect(envelope.run_id).toBe("run-full");
			expect(envelope.task_id).toBe("T-0001");
			expect(envelope.worktree_path).toBe(result.worktree);
			expect(envelope.dispatched_at).toBeDefined();
		} finally {
			if (savedPR !== undefined) process.env.CLAUDE_PLUGIN_ROOT = savedPR;
			else delete process.env.CLAUDE_PLUGIN_ROOT;
		}
	});

	test("re-dispatch merges existing envelope", () => {
		const pluginRoot = resolve(import.meta.dirname, "..", "..");
		const savedPR = process.env.CLAUDE_PLUGIN_ROOT;
		process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
		try {
			setupDispatchRun("run-redispatch", [
				{ id: "T-0001", agent: "code-small", title: "Test" },
			]);
			const taskDir = join(projectDir, ".lazy-dev", "runs", "run-redispatch", "tasks", "T-0001");
			mkdirSync(taskDir, { recursive: true });
			writeFileSync(join(taskDir, "envelope.json"), JSON.stringify({
				id: "T-0001", agent: "code-small",
				dispatched_at: "2025-01-01T00:00:00Z",
			}));

			const result = dispatch({ runId: "run-redispatch", taskId: "T-0001", projectDir });
			const envelope = JSON.parse(readFileSync(result.envelope_path, "utf8"));
			expect(envelope.dispatched_at).toBe("2025-01-01T00:00:00Z");
			expect(envelope.redispatched_at).toBeDefined();
		} finally {
			if (savedPR !== undefined) process.env.CLAUDE_PLUGIN_ROOT = savedPR;
			else delete process.env.CLAUDE_PLUGIN_ROOT;
		}
	});
});

describe("dispatch CLI", () => {
	test("CLI returns usage error without args", () => {
		const result = spawnSync("node", [CLI_PATH], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
		expect(output.detail).toContain("usage");
	});

	test("CLI returns error for missing tasks.json", () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-cli-dispatch");
		mkdirSync(runDir, { recursive: true });
		const result = spawnSync("node", [CLI_PATH, "run-cli-dispatch", "T-0001"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
		expect(output.detail).toContain("tasks.json");
	});
});
