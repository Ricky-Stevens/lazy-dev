import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GATE_PATH = resolve(import.meta.dirname, "gate.js");

let projectDir;
let runId;
let runDir;

function runGate(payload, env = {}) {
	const result = spawnSync("node", [GATE_PATH], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...env },
		timeout: 10_000,
	});
	return { stdout: result.stdout?.trim(), stderr: result.stderr?.trim(), status: result.status };
}

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "gate-test-"));
	runId = "test-run-001";
	runDir = join(projectDir, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });

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

describe("gate.js subprocess", () => {
	test("exits 0 silently for non-lazy-dev agent", () => {
		const r = runGate({ agent_type: "some-other-agent", cwd: projectDir });
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	test("exits 0 silently for per-run agent (planner)", () => {
		mkdirSync(join(runDir, "status.json").replace("/status.json", ""), { recursive: true });
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "plan" }),
		);

		const r = runGate({
			agent_type: "lazy-dev:planner",
			agent_id: "planner-1",
			cwd: projectDir,
			last_assistant_message: "some plan output",
		});
		expect(r.status).toBe(0);
	});

	test("exits 0 silently for per-run agent (reviewer variant)", () => {
		const r = runGate({
			agent_type: "lazy-dev:reviewer-xhigh",
			agent_id: "reviewer-1",
			cwd: projectDir,
			last_assistant_message: "",
		});
		expect(r.status).toBe(0);
	});

	test("exits 0 when task cannot be resolved", () => {
		const r = runGate({
			agent_type: "lazy-dev:code-small",
			agent_id: "cs-1",
			cwd: "/tmp/some-random-dir",
			last_assistant_message: "no sentinel here",
		});
		expect(r.status).toBe(0);
	});

	test("exits 0 silently for empty stdin", () => {
		const result = spawnSync("node", [GATE_PATH], {
			input: "",
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		expect(result.status).toBe(0);
	});

	test("emits retry JSON when sentinel is missing and envelope exists", () => {
		const taskId = "T-0100";
		const taskDir = join(runDir, "tasks", taskId);
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(taskDir, "envelope.json"),
			JSON.stringify({
				id: taskId,
				task_id: taskId,
				agent: "code-small",
				budget: { max_iter: 3 },
			}),
		);

		const r = runGate({
			agent_type: "lazy-dev:code-small",
			agent_id: "cs-100",
			cwd: projectDir,
			last_assistant_message: `---COMPLETED---${JSON.stringify({ task_id: taskId })}---END--- oops not right`,
		});
		expect(r.status).toBe(0);
	});

	test("handles blocked sentinel — marks FAILED", () => {
		const taskId = "T-0101";
		const taskDir = join(runDir, "tasks", taskId);
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(taskDir, "envelope.json"),
			JSON.stringify({
				id: taskId,
				task_id: taskId,
				agent: "code-small",
				budget: { max_iter: 3 },
			}),
		);

		const sentinel = `---BLOCKED---\nCannot proceed: dependency missing\n---END---`;
		const r = runGate({
			agent_type: "lazy-dev:code-small",
			agent_id: "cs-101",
			cwd: projectDir,
			last_assistant_message: sentinel,
		});
		expect(r.status).toBe(0);
	});
});
