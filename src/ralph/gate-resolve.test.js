import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	deriveWorktreePath,
	findMostRecentRun,
	resolveFromSentinel,
	resolveTaskFromCwd,
} from "./gate-resolve.js";

let tmpDir;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "gate-resolve-test-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveFromSentinel", () => {
	test("resolves task from completed sentinel with task_id", () => {
		const runId = "run-001";
		const taskId = "T-0001";
		const envDir = join(tmpDir, ".lazy-dev", "runs", runId, "tasks", taskId);
		mkdirSync(envDir, { recursive: true });
		writeFileSync(join(envDir, "envelope.json"), "{}");

		const result = resolveFromSentinel(tmpDir, {
			kind: "completed",
			body: { task_id: taskId },
		});
		expect(result).toEqual({ runId, taskId });
	});

	test("returns null for non-completed sentinel", () => {
		const result = resolveFromSentinel(tmpDir, { kind: "blocked", body: {} });
		expect(result).toBe(null);
	});

	test("returns null when sentinel has no task_id", () => {
		const result = resolveFromSentinel(tmpDir, { kind: "completed", body: {} });
		expect(result).toBe(null);
	});

	test("returns null when task_id does not match any run", () => {
		const result = resolveFromSentinel(tmpDir, {
			kind: "completed",
			body: { task_id: "T-9999" },
		});
		expect(result).toBe(null);
	});

	test("returns null when runs dir does not exist", () => {
		const emptyDir = join(tmpDir, "empty-project");
		mkdirSync(emptyDir, { recursive: true });
		const result = resolveFromSentinel(emptyDir, {
			kind: "completed",
			body: { task_id: "T-0001" },
		});
		expect(result).toBe(null);
	});

	test("skips _ prefixed directories", () => {
		const gateLog = join(tmpDir, ".lazy-dev", "runs", "_gate-log");
		mkdirSync(gateLog, { recursive: true });
		const result = resolveFromSentinel(tmpDir, {
			kind: "completed",
			body: { task_id: "_gate-log" },
		});
		expect(result).toBe(null);
	});
});

describe("resolveTaskFromCwd", () => {
	test("resolves from worktree path", () => {
		const runId = "run-002";
		const taskId = "T-0002";
		const envDir = join(tmpDir, ".lazy-dev", "runs", runId, "tasks", taskId);
		mkdirSync(envDir, { recursive: true });
		writeFileSync(join(envDir, "envelope.json"), "{}");

		const cwd = join(tmpDir, ".lazy-dev", "worktrees", runId, `${taskId}-abc123`, "src");
		const result = resolveTaskFromCwd(tmpDir, cwd);
		expect(result).toEqual({ runId, taskId });
	});

	test("returns null when cwd has no worktrees marker", () => {
		const result = resolveTaskFromCwd(tmpDir, "/some/other/path");
		expect(result).toBe(null);
	});

	test("returns null when parts are too few", () => {
		const cwd = join(tmpDir, ".lazy-dev", "worktrees", "run-only");
		const result = resolveTaskFromCwd(tmpDir, cwd);
		expect(result).toBe(null);
	});

	test("falls back to full dir name when no envelope for extracted taskId", () => {
		const runId = "run-alt";
		const dirName = "T-0003-abc123";
		const envDir = join(tmpDir, ".lazy-dev", "runs", runId, "tasks", dirName);
		mkdirSync(envDir, { recursive: true });
		writeFileSync(join(envDir, "envelope.json"), "{}");

		const cwd = join(tmpDir, ".lazy-dev", "worktrees", runId, dirName, "src");
		const result = resolveTaskFromCwd(tmpDir, cwd);
		expect(result).toEqual({ runId, taskId: dirName });
	});

	test("returns null when no envelope exists at either location", () => {
		const cwd = join(tmpDir, ".lazy-dev", "worktrees", "run-x", "T-9999-abc123", "src");
		const result = resolveTaskFromCwd(tmpDir, cwd);
		expect(result).toBe(null);
	});
});

describe("deriveWorktreePath", () => {
	test("finds exact match", () => {
		const runId = "run-derive";
		const taskId = "T-0010";
		const wtDir = join(tmpDir, ".lazy-dev", "worktrees", runId, taskId);
		mkdirSync(wtDir, { recursive: true });

		const result = deriveWorktreePath(tmpDir, runId, taskId);
		expect(result).toBe(wtDir);
	});

	test("finds prefix match", () => {
		const runId = "run-derive2";
		const taskId = "T-0011";
		const wtDir = join(tmpDir, ".lazy-dev", "worktrees", runId, `${taskId}-abc123`);
		mkdirSync(wtDir, { recursive: true });

		const result = deriveWorktreePath(tmpDir, runId, taskId);
		expect(result).toBe(wtDir);
	});

	test("returns null when worktrees dir does not exist", () => {
		const result = deriveWorktreePath(tmpDir, "nonexistent-run", "T-0001");
		expect(result).toBe(null);
	});
});

describe("resolveFromSentinel — SAFE_ID_REGEX guard", () => {
	test("rejects task_id containing path traversal characters", () => {
		const result = resolveFromSentinel(tmpDir, {
			kind: "completed",
			body: { task_id: "../evil" },
		});
		expect(result).toBe(null);
	});

	test("rejects task_id with a slash", () => {
		const result = resolveFromSentinel(tmpDir, {
			kind: "completed",
			body: { task_id: "run/T-0001" },
		});
		expect(result).toBe(null);
	});

	test("rejects task_id with a space", () => {
		const result = resolveFromSentinel(tmpDir, {
			kind: "completed",
			body: { task_id: "T 0001" },
		});
		expect(result).toBe(null);
	});

	test("accepts task_id with word chars, dots, colons, and hyphens", () => {
		const runId = "run-safe-id";
		const taskId = "T-0001.v2:x";
		const envDir = join(tmpDir, ".lazy-dev", "runs", runId, "tasks", taskId);
		mkdirSync(envDir, { recursive: true });
		writeFileSync(join(envDir, "envelope.json"), "{}");

		const result = resolveFromSentinel(tmpDir, {
			kind: "completed",
			body: { task_id: taskId },
		});
		expect(result).toEqual({ runId, taskId });
	});
});

describe("resolveFromSentinel — picks most-recent run", () => {
	test("returns the most recently modified run when two runs share the same taskId", () => {
		const pd = join(tmpDir, "multi-run");
		const taskId = "T-shared";

		const oldRun = "run-2020";
		const newRun = "run-2025";

		for (const r of [oldRun, newRun]) {
			const envDir = join(pd, ".lazy-dev", "runs", r, "tasks", taskId);
			mkdirSync(envDir, { recursive: true });
			writeFileSync(join(envDir, "envelope.json"), "{}");
		}

		// Force old-run to appear older via mtime on the run dir itself.
		utimesSync(
			join(pd, ".lazy-dev", "runs", oldRun),
			new Date("2020-01-01"),
			new Date("2020-01-01"),
		);

		const result = resolveFromSentinel(pd, {
			kind: "completed",
			body: { task_id: taskId },
		});
		expect(result).toEqual({ runId: newRun, taskId });
	});
});

describe("findMostRecentRun", () => {
	test("finds the most recently modified run", () => {
		const pd = join(tmpDir, "find-recent");
		const runsDir = join(pd, ".lazy-dev", "runs");
		mkdirSync(join(runsDir, "old-run"), { recursive: true });

		utimesSync(join(runsDir, "old-run"), new Date("2020-01-01"), new Date("2020-01-01"));

		mkdirSync(join(runsDir, "new-run"), { recursive: true });

		const result = findMostRecentRun(pd);
		expect(result).toBe("new-run");
	});

	test("returns null when runs dir does not exist", () => {
		const result = findMostRecentRun(join(tmpDir, "no-such-project"));
		expect(result).toBe(null);
	});

	test("skips _ prefixed entries", () => {
		const pd = join(tmpDir, "find-recent-skip");
		const runsDir = join(pd, ".lazy-dev", "runs");
		mkdirSync(join(runsDir, "_gate-log"), { recursive: true });
		mkdirSync(join(runsDir, "real-run"), { recursive: true });

		const result = findMostRecentRun(pd);
		expect(result).toBe("real-run");
	});

	test("returns null when only _ prefixed entries exist", () => {
		const pd = join(tmpDir, "find-recent-only-meta");
		const runsDir = join(pd, ".lazy-dev", "runs");
		mkdirSync(join(runsDir, "_gate-log"), { recursive: true });

		const result = findMostRecentRun(pd);
		expect(result).toBe(null);
	});
});
