import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	execFileSync("git", ["config", "user.email", "test@test.com"], {
		cwd: projectDir,
		stdio: "ignore",
	});
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
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "plan" }));

		const r = runGate({
			agent_type: "lazy-dev:planner",
			agent_id: "planner-1",
			cwd: projectDir,
			last_assistant_message: "some plan output",
		});
		expect(r.status).toBe(0);
	});

	test("exits 0 silently for per-run agent (reviewer)", () => {
		const r = runGate({
			agent_type: "lazy-dev:reviewer",
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

	test("marks oscillation_same_diff when two consecutive iterations produce identical diffHash", () => {
		// Set up a separate worktree git repo with two commits so HEAD~1 resolves.
		const wtDir = mkdtempSync(join(tmpdir(), "gate-osc-wt-"));
		try {
			execFileSync("git", ["init"], { cwd: wtDir, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "test@test.com"], {
				cwd: wtDir,
				stdio: "ignore",
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: wtDir, stdio: "ignore" });
			writeFileSync(join(wtDir, "base.txt"), "base\n");
			execFileSync("git", ["add", "."], { cwd: wtDir, stdio: "ignore" });
			execFileSync("git", ["commit", "-m", "base"], { cwd: wtDir, stdio: "ignore" });
			writeFileSync(join(wtDir, "work.txt"), "work\n");
			execFileSync("git", ["add", "."], { cwd: wtDir, stdio: "ignore" });
			execFileSync("git", ["commit", "-m", "work"], { cwd: wtDir, stdio: "ignore" });

			const taskId = "T-0200";
			const taskDir = join(runDir, "tasks", taskId);
			mkdirSync(taskDir, { recursive: true });
			// A file_exists criterion pointing to a missing file ensures verifiers fail
			// on every iteration (keeping the gate in retry mode so iteration 2 is reached).
			writeFileSync(
				join(taskDir, "envelope.json"),
				JSON.stringify({
					id: taskId,
					task_id: taskId,
					agent: "code-small",
					worktree_path: wtDir,
					budget: { max_iter: 3 },
					completion_criteria: [
						{ id: "must_exist", kind: "file_exists", path: "nonexistent-file.txt" },
					],
				}),
			);

			const sentinel = `---COMPLETED---\n${JSON.stringify({ task_id: taskId, summary: "done" })}\n---END---`;

			// Iteration 1 — gate records the first history entry and emits a retry.
			const r1 = runGate({
				agent_type: "lazy-dev:code-small",
				agent_id: "cs-200",
				cwd: projectDir,
				last_assistant_message: sentinel,
			});
			expect(r1.status).toBe(0);
			// Provisional FAILED marker signals the retry may not be delivered.
			expect(existsSync(join(taskDir, "FAILED"))).toBe(true);
			const provisional = JSON.parse(readFileSync(join(taskDir, "FAILED"), "utf8"));
			expect(provisional.reason).toBe("verifier_retry_pending");

			// Iteration 2 — identical diffHash triggers oscillation_same_diff.
			const r2 = runGate({
				agent_type: "lazy-dev:code-small",
				agent_id: "cs-200",
				cwd: projectDir,
				last_assistant_message: sentinel,
			});
			expect(r2.status).toBe(0);
			// FAILED marker must now exist.
			expect(existsSync(join(taskDir, "FAILED"))).toBe(true);
			const failed = JSON.parse(readFileSync(join(taskDir, "FAILED"), "utf8"));
			expect(failed.reason).toBe("oscillation_same_diff");
		} finally {
			rmSync(wtDir, { recursive: true, force: true });
		}
	});
});

describe("gate autoCommit — scoped staging", () => {
	function setupWorktree(taskId, branchSuffix, envelopeOverrides = {}) {
		const taskDir = join(runDir, "tasks", taskId);
		mkdirSync(taskDir, { recursive: true });
		const branch = `lazy-dev/test-run-001/${branchSuffix}`;
		const wtDir = join(projectDir, ".lazy-dev", "worktrees", runId, `${branchSuffix}-aaaaaa`);
		mkdirSync(join(projectDir, ".lazy-dev", "worktrees", runId), { recursive: true });
		execFileSync("git", ["-C", projectDir, "worktree", "add", "-b", branch, wtDir, "HEAD"], {
			stdio: "ignore",
		});
		writeFileSync(
			join(taskDir, "envelope.json"),
			JSON.stringify({
				id: taskId,
				run_id: runId,
				task_id: taskId,
				scope: { allowed_paths: ["src/*.js"] },
				completion_criteria: [{ id: "f", kind: "file_exists", path: "src/app.js" }],
				worktree_path: wtDir,
				worktree_branch: branch,
				budget: { max_iter: 2 },
				...envelopeOverrides,
			}),
		);
		return { taskDir, wtDir, branch };
	}

	function cleanupWorktree(wtDir, branch) {
		rmSync(wtDir, { recursive: true, force: true });
		try {
			execFileSync("git", ["-C", projectDir, "worktree", "prune"], { stdio: "ignore" });
			execFileSync("git", ["-C", projectDir, "branch", "-D", branch], { stdio: "ignore" });
		} catch {}
	}

	function fireSentinel(taskId) {
		const sentinel = `---COMPLETED---\n${JSON.stringify({ task_id: taskId, summary: "done" })}\n---END---`;
		return runGate({
			agent_type: "lazy-dev:code-small",
			agent_id: `cs-${taskId}`,
			cwd: projectDir,
			last_assistant_message: sentinel,
		});
	}

	test("auto-commit does not stage untracked files outside allowed_paths", () => {
		const { taskDir, wtDir, branch } = setupWorktree("T-AUTO", "T-AUTO");
		try {
			mkdirSync(join(wtDir, "src"), { recursive: true });
			writeFileSync(join(wtDir, "src", "app.js"), "export const x = 1;\n");
			mkdirSync(join(wtDir, ".serena"), { recursive: true });
			writeFileSync(join(wtDir, ".serena", "project.yml"), "name: test\n");
			mkdirSync(join(wtDir, ".some-tool"), { recursive: true });
			writeFileSync(join(wtDir, ".some-tool", "cache.json"), "{}");

			const r = fireSentinel("T-AUTO");
			expect(r.status).toBe(0);

			const logOut = execFileSync("git", ["-C", wtDir, "log", "--oneline", "-1"], {
				encoding: "utf8",
			}).trim();
			expect(logOut).toContain("auto-commit");

			const committed = execFileSync("git", ["-C", wtDir, "diff", "--name-only", "HEAD~1..HEAD"], {
				encoding: "utf8",
			}).trim();
			expect(committed).toContain("src/app.js");
			expect(committed).not.toContain(".serena");
			expect(committed).not.toContain(".some-tool");

			expect(existsSync(join(taskDir, "APPROVED"))).toBe(true);
		} finally {
			cleanupWorktree(wtDir, branch);
		}
	});

	test("no commit when only tool artifacts exist (no in-scope changes)", () => {
		const { taskDir, wtDir, branch } = setupWorktree("T-TOOLONLY", "T-TOOLONLY");
		try {
			mkdirSync(join(wtDir, ".serena"), { recursive: true });
			writeFileSync(join(wtDir, ".serena", "project.yml"), "name: test\n");

			const r = fireSentinel("T-TOOLONLY");
			expect(r.status).toBe(0);

			const logOut = execFileSync("git", ["-C", wtDir, "log", "--oneline", "-1"], {
				encoding: "utf8",
			}).trim();
			expect(logOut).not.toContain("auto-commit");
			expect(logOut).toContain("init");
		} finally {
			cleanupWorktree(wtDir, branch);
		}
	});

	test("empty allowedPaths falls back to git add -A", () => {
		const { taskDir, wtDir, branch } = setupWorktree("T-EMPTY", "T-EMPTY", {
			scope: { allowed_paths: [] },
			completion_criteria: [{ id: "f", kind: "file_exists", path: "newfile.txt" }],
		});
		try {
			writeFileSync(join(wtDir, "newfile.txt"), "hello\n");
			mkdirSync(join(wtDir, ".tool"), { recursive: true });
			writeFileSync(join(wtDir, ".tool", "cache"), "{}");

			const r = fireSentinel("T-EMPTY");
			expect(r.status).toBe(0);

			const committed = execFileSync("git", ["-C", wtDir, "diff", "--name-only", "HEAD~1..HEAD"], {
				encoding: "utf8",
			}).trim();
			expect(committed).toContain("newfile.txt");
			expect(committed).toContain(".tool/cache");
		} finally {
			cleanupWorktree(wtDir, branch);
		}
	});

	test("auto-cleans out-of-scope files committed by the specialist", () => {
		const { taskDir, wtDir, branch } = setupWorktree("T-CLEAN", "T-CLEAN");
		try {
			mkdirSync(join(wtDir, "src"), { recursive: true });
			writeFileSync(join(wtDir, "src", "app.js"), "export const x = 1;\n");
			mkdirSync(join(wtDir, ".serena"), { recursive: true });
			writeFileSync(join(wtDir, ".serena", "project.yml"), "name: test\n");

			// Specialist commits everything (including out-of-scope .serena/)
			execFileSync("git", ["-C", wtDir, "add", "-A"], { stdio: "ignore" });
			execFileSync("git", ["-C", wtDir, "commit", "-m", "specialist work"], {
				stdio: "ignore",
			});

			const r = fireSentinel("T-CLEAN");
			expect(r.status).toBe(0);

			// Task should be approved — gate auto-cleaned the .serena files.
			expect(existsSync(join(taskDir, "APPROVED"))).toBe(true);
			expect(existsSync(join(taskDir, "FAILED"))).toBe(false);
		} finally {
			cleanupWorktree(wtDir, branch);
		}
	});
});
