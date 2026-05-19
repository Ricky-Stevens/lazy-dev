import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REVIEWER_EFFORTS, reviewBuild, reviewVerdict } from "./review.js";

const CLI_PATH = resolve(import.meta.dirname, "review.js");

let tmpDir;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "review-test-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupReviewRun(pd, runId, tasks, opts = {}) {
	const runDir = join(pd, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "tasks.json"), JSON.stringify({ tasks }));
	writeFileSync(join(runDir, "status.json"), JSON.stringify({ run_id: runId, phase: "review" }));
	if (opts.previousReview) {
		writeFileSync(join(runDir, "review-prev.md"), opts.previousReview);
	}
	for (const t of tasks) {
		const taskDir = join(runDir, "tasks", t.id);
		mkdirSync(taskDir, { recursive: true });
		if (opts.approvedSentinel) {
			writeFileSync(
				join(taskDir, "APPROVED"),
				JSON.stringify({ sentinel: { summary: "did the thing" } }),
			);
		}
	}
	return runDir;
}

describe("REVIEWER_EFFORTS", () => {
	test("contains high, xhigh, max", () => {
		expect(REVIEWER_EFFORTS.has("high")).toBe(true);
		expect(REVIEWER_EFFORTS.has("xhigh")).toBe(true);
		expect(REVIEWER_EFFORTS.has("max")).toBe(true);
	});

	test("does not contain medium", () => {
		expect(REVIEWER_EFFORTS.has("medium")).toBe(false);
	});
});

describe("reviewBuild", () => {
	test("builds review envelope with default effort", () => {
		const pd = join(tmpDir, "rb1");
		setupReviewRun(pd, "run-rb1", [{ id: "T-0001", agent: "code-small", title: "Fix bug" }]);

		const result = reviewBuild({ runId: "run-rb1", projectDir: pd });
		expect(result.agent_namespaced).toBe("lazy-dev:reviewer");
		expect(result.effort).toBe("high");
		expect(result.envelope_path).toContain("review-envelope.json");
		expect(result.dispatch_prompt).toContain("Envelope:");
		expect(result.retry).toBe(false);

		const envelope = JSON.parse(readFileSync(result.envelope_path, "utf8"));
		expect(envelope.run_id).toBe("run-rb1");
		expect(envelope.tasks).toHaveLength(1);
		expect(envelope.tasks[0].id).toBe("T-0001");
	});

	test("uses xhigh effort variant in agent name", () => {
		const pd = join(tmpDir, "rb2");
		setupReviewRun(pd, "run-rb2", [{ id: "T-0001", agent: "code-small" }]);

		const result = reviewBuild({ runId: "run-rb2", projectDir: pd, effort: "xhigh" });
		expect(result.agent_namespaced).toBe("lazy-dev:reviewer");
		expect(result.effort).toBe("xhigh");
	});

	test("throws for unknown effort", () => {
		const pd = join(tmpDir, "rb3");
		setupReviewRun(pd, "run-rb3", []);

		expect(() => reviewBuild({ runId: "run-rb3", projectDir: pd, effort: "low" })).toThrow(
			"unknown reviewer effort",
		);
	});

	test("sets retry=true when review-prev.md exists", () => {
		const pd = join(tmpDir, "rb4");
		setupReviewRun(pd, "run-rb4", [{ id: "T-0001", agent: "code-small" }], {
			previousReview: "# Previous Review\n**Verdict:** CHANGES_REQUESTED\n",
		});

		const result = reviewBuild({ runId: "run-rb4", projectDir: pd });
		expect(result.retry).toBe(true);
		expect(result.dispatch_prompt).toContain("retry pass");
	});

	test("includes sentinel summary in tasks when APPROVED exists", () => {
		const pd = join(tmpDir, "rb5");
		setupReviewRun(pd, "run-rb5", [{ id: "T-0001", agent: "code-small" }], {
			approvedSentinel: true,
		});

		const result = reviewBuild({ runId: "run-rb5", projectDir: pd });
		const envelope = JSON.parse(readFileSync(result.envelope_path, "utf8"));
		expect(envelope.tasks[0].sentinel_summary).toBe("did the thing");
	});

	test("sentinel summary is null when APPROVED has bad JSON", () => {
		const pd = join(tmpDir, "rb-badsent");
		const runDir = join(pd, ".lazy-dev", "runs", "run-badsent");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "tasks.json"),
			JSON.stringify({ tasks: [{ id: "T-0001", agent: "code-small" }] }),
		);
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "review" }));
		const taskDir = join(runDir, "tasks", "T-0001");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(join(taskDir, "APPROVED"), "not json");

		const result = reviewBuild({ runId: "run-badsent", projectDir: pd });
		const envelope = JSON.parse(readFileSync(result.envelope_path, "utf8"));
		expect(envelope.tasks[0].sentinel_summary).toBe(null);
	});

	test("sentinel summary is null when APPROVED lacks sentinel field", () => {
		const pd = join(tmpDir, "rb-nosent");
		const runDir = join(pd, ".lazy-dev", "runs", "run-nosent");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "tasks.json"),
			JSON.stringify({ tasks: [{ id: "T-0001", agent: "code-small" }] }),
		);
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "review" }));
		const taskDir = join(runDir, "tasks", "T-0001");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(join(taskDir, "APPROVED"), JSON.stringify({ at: "2025-01-01" }));

		const result = reviewBuild({ runId: "run-nosent", projectDir: pd });
		const envelope = JSON.parse(readFileSync(result.envelope_path, "utf8"));
		expect(envelope.tasks[0].sentinel_summary).toBe(null);
	});

	test("throws when tasks.json is missing", () => {
		const pd = join(tmpDir, "rb6");
		const runDir = join(pd, ".lazy-dev", "runs", "run-rb6");
		mkdirSync(runDir, { recursive: true });

		expect(() => reviewBuild({ runId: "run-rb6", projectDir: pd })).toThrow("tasks.json missing");
	});

	test("throws a clear error when tasks.json contains corrupt JSON (#12)", () => {
		const pd = join(tmpDir, "rb-corrupt");
		const runDir = join(pd, ".lazy-dev", "runs", "run-corrupt");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "tasks.json"), "{ not valid json !!!");

		expect(() => reviewBuild({ runId: "run-corrupt", projectDir: pd })).toThrow(/invalid JSON/i);
	});

	test("throws a clear error when tasks.json exceeds the size cap (#12)", () => {
		const pd = join(tmpDir, "rb-oversized");
		const runDir = join(pd, ".lazy-dev", "runs", "run-oversized");
		mkdirSync(runDir, { recursive: true });
		// Write a file larger than JSON_MAX_BYTES (4 MiB).
		const big = Buffer.alloc(4 * 1024 * 1024 + 1, "x");
		writeFileSync(join(runDir, "tasks.json"), big);

		expect(() => reviewBuild({ runId: "run-oversized", projectDir: pd })).toThrow(/byte cap/i);
	});

	test("validates run_id", () => {
		expect(() => reviewBuild({ runId: "../bad", projectDir: tmpDir })).toThrow();
	});
});

describe("reviewVerdict", () => {
	test("parses PASS_ALL verdict", () => {
		const pd = join(tmpDir, "rv1");
		const runDir = join(pd, ".lazy-dev", "runs", "run-rv1");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "review.md"),
			"# Review\n**Verdict:** PASS_ALL\n## T-0001\n**Verdict:** PASS\nLooks good.\n",
		);

		const result = reviewVerdict({ runId: "run-rv1", projectDir: pd });
		expect(result.verdict).toBe("PASS_ALL");
	});

	test("parses CHANGES_REQUESTED verdict", () => {
		const pd = join(tmpDir, "rv2");
		const runDir = join(pd, ".lazy-dev", "runs", "run-rv2");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "review.md"),
			"# Review\n**Verdict:** CHANGES_REQUESTED\n## T-0001\n**Verdict:** CHANGES_REQUESTED\nFix imports.\n",
		);

		const result = reviewVerdict({ runId: "run-rv2", projectDir: pd });
		expect(result.verdict).toBe("CHANGES_REQUESTED");
		expect(result.per_task).toBeDefined();
	});

	test("parses BLOCK verdict", () => {
		const pd = join(tmpDir, "rv3");
		const runDir = join(pd, ".lazy-dev", "runs", "run-rv3");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "review.md"), "# Review\n**Verdict:** BLOCK\nSecurity issue.\n");

		const result = reviewVerdict({ runId: "run-rv3", projectDir: pd });
		expect(result.verdict).toBe("BLOCK");
	});

	test("throws when review.md is missing", () => {
		const pd = join(tmpDir, "rv4");
		const runDir = join(pd, ".lazy-dev", "runs", "run-rv4");
		mkdirSync(runDir, { recursive: true });

		expect(() => reviewVerdict({ runId: "run-rv4", projectDir: pd })).toThrow("review.md missing");
	});

	test("throws when verdict line cannot be parsed", () => {
		const pd = join(tmpDir, "rv5");
		const runDir = join(pd, ".lazy-dev", "runs", "run-rv5");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "review.md"), "# Review\nNo verdict here.\n");

		expect(() => reviewVerdict({ runId: "run-rv5", projectDir: pd })).toThrow("could not parse");
	});
});

describe("reviewBuild — worktree handling", () => {
	test("writes diff.patch from worktree file listing when not a git repo", () => {
		const pd = join(tmpDir, "rb-wt1");
		const runDir = join(pd, ".lazy-dev", "runs", "run-wt1");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "tasks.json"),
			JSON.stringify({ tasks: [{ id: "T-0001", agent: "code-small" }] }),
		);
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "review" }));

		const wtDir = join(pd, ".lazy-dev", "worktrees", "run-wt1", "T-0001-abc123");
		mkdirSync(wtDir, { recursive: true });
		writeFileSync(join(wtDir, "src.js"), "content");

		const taskDir = join(runDir, "tasks", "T-0001");
		mkdirSync(taskDir, { recursive: true });

		const result = reviewBuild({ runId: "run-wt1", projectDir: pd });
		const envelope = JSON.parse(readFileSync(result.envelope_path, "utf8"));
		expect(envelope.tasks[0].worktree_path).toContain("T-0001");
	});

	test("includes diff.patch from git worktree", () => {
		const pd = join(tmpDir, "rb-wt2");
		const runDir = join(pd, ".lazy-dev", "runs", "run-wt2");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "tasks.json"),
			JSON.stringify({ tasks: [{ id: "T-0001", agent: "code-small" }] }),
		);
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "review" }));

		const wtDir = join(pd, ".lazy-dev", "worktrees", "run-wt2", "T-0001-abc123");
		mkdirSync(wtDir, { recursive: true });
		execFileSync("git", ["init"], { cwd: wtDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "t@t.c"], { cwd: wtDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "T"], { cwd: wtDir, stdio: "ignore" });
		writeFileSync(join(wtDir, "file.js"), "initial\n");
		execFileSync("git", ["add", "."], { cwd: wtDir, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init"], { cwd: wtDir, stdio: "ignore" });
		writeFileSync(join(wtDir, "file.js"), "changed\n");
		execFileSync("git", ["add", "."], { cwd: wtDir, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "change"], { cwd: wtDir, stdio: "ignore" });

		const taskDir = join(runDir, "tasks", "T-0001");
		mkdirSync(taskDir, { recursive: true });

		reviewBuild({ runId: "run-wt2", projectDir: pd });
		expect(existsSync(join(taskDir, "diff.patch"))).toBe(true);
	});

	test("handles tasks with no worktree", () => {
		const pd = join(tmpDir, "rb-nwt");
		const runDir = join(pd, ".lazy-dev", "runs", "run-nwt");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "tasks.json"),
			JSON.stringify({ tasks: [{ id: "T-0001", agent: "code-small" }] }),
		);
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "review" }));

		const result = reviewBuild({ runId: "run-nwt", projectDir: pd });
		const envelope = JSON.parse(readFileSync(result.envelope_path, "utf8"));
		expect(envelope.tasks[0].worktree_path).toBe(null);
	});
});

describe("review.js CLI", () => {
	test("build mode creates review envelope", () => {
		const pd = join(tmpDir, "cli-rb");
		const runDir = join(pd, ".lazy-dev", "runs", "run-cli");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "tasks.json"), JSON.stringify({ tasks: [] }));
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "review" }));

		const result = spawnSync("node", [CLI_PATH, "build", "run-cli"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: pd },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
	});

	test("verdict mode parses review.md", () => {
		const pd = join(tmpDir, "cli-rv");
		const runDir = join(pd, ".lazy-dev", "runs", "run-cli-v");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "review.md"), "**Verdict:** PASS_ALL\n");

		const result = spawnSync("node", [CLI_PATH, "verdict", "run-cli-v"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: pd },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
		expect(output.verdict).toBe("PASS_ALL");
	});

	test("unknown mode returns error", () => {
		const result = spawnSync("node", [CLI_PATH, "badmode", "run-x"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
	});

	test("missing args returns usage error", () => {
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
