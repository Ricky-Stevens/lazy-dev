import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prune } from "./prune.js";

const CLI_PATH = resolve(import.meta.dirname, "prune.js");

let tmpDir;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "prune-test-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function setupPruneRun(pd, runId, phase) {
	const runDir = join(pd, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase }));
	return runDir;
}

describe("prune", () => {
	test("validates run_id", () => {
		expect(() => prune({ runId: "../escape", projectDir: tmpDir })).toThrow();
	});

	test("throws when run dir does not exist", () => {
		expect(() => prune({ runId: "nonexistent", projectDir: tmpDir })).toThrow("not found");
	});

	test("refuses to prune active run in specialists phase", () => {
		const pd = join(tmpDir, "p1");
		setupPruneRun(pd, "run-active", "specialists");

		expect(() => prune({ runId: "run-active", projectDir: pd })).toThrow("refusing to prune");
	});

	test("refuses to prune run in plan phase", () => {
		const pd = join(tmpDir, "p2");
		setupPruneRun(pd, "run-plan", "plan");

		expect(() => prune({ runId: "run-plan", projectDir: pd })).toThrow("refusing to prune");
	});

	test("allows pruning cancelled run", () => {
		const pd = join(tmpDir, "p3");
		setupPruneRun(pd, "run-cancelled", "cancelled");

		const result = prune({ runId: "run-cancelled", projectDir: pd });
		expect(result.run_id).toBe("run-cancelled");
		expect(result.run_dir_preserved).toContain("run-cancelled");
		expect(result.worktrees_removed).toEqual([]);
		expect(result.branches_removed).toEqual([]);
	});

	test("allows pruning done run", () => {
		const pd = join(tmpDir, "p4");
		setupPruneRun(pd, "run-done", "done");

		const result = prune({ runId: "run-done", projectDir: pd });
		expect(result.run_id).toBe("run-done");
	});

	test("allows pruning when status.json is missing", () => {
		const pd = join(tmpDir, "p5");
		const runDir = join(pd, ".lazy-dev", "runs", "run-no-status");
		mkdirSync(runDir, { recursive: true });

		const result = prune({ runId: "run-no-status", projectDir: pd });
		expect(result.run_id).toBe("run-no-status");
	});

	test("allows pruning when status.json is corrupt", () => {
		const pd = join(tmpDir, "p6");
		const runDir = join(pd, ".lazy-dev", "runs", "run-corrupt");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), "not json");

		const result = prune({ runId: "run-corrupt", projectDir: pd });
		expect(result.run_id).toBe("run-corrupt");
	});
});

describe("prune CLI", () => {
	test("prunes a done run via CLI", () => {
		const pd = join(tmpDir, "cli-p1");
		const runDir = join(pd, ".lazy-dev", "runs", "run-cli-done");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "done" }));

		const result = spawnSync("node", [CLI_PATH, "run-cli-done"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: pd },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
		expect(output.run_id).toBe("run-cli-done");
	});

	test("CLI returns usage error without run_id", () => {
		const result = spawnSync("node", [CLI_PATH], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
		expect(output.detail).toContain("usage");
	});

	test("CLI returns error for active run", () => {
		const pd = join(tmpDir, "cli-p2");
		const runDir = join(pd, ".lazy-dev", "runs", "run-cli-active");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "specialists" }));

		const result = spawnSync("node", [CLI_PATH, "run-cli-active"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: pd },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
		expect(output.detail).toContain("refusing");
	});
});
