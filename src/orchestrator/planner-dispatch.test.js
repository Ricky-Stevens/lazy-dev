import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PLANNER_EFFORTS, plannerDispatch } from "./planner-dispatch.js";

const CLI_PATH = resolve(import.meta.dirname, "planner-dispatch.js");

let projectDir;
let runId;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "lazy-dev-planner-dispatch-"));
	runId = "2026-04-19T00-00-00Z-test";
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "brief.md"), "Test brief");
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("plannerDispatch effort routing", () => {
	test("defaults to 'high' and resolves to bare lazy-dev:planner", () => {
		const r = plannerDispatch({ runId, projectDir });
		expect(r.effort).toBe("high");
		expect(r.agent_namespaced).toBe("lazy-dev:planner");
	});

	test("all effort levels resolve to lazy-dev:planner", () => {
		for (const effort of ["medium", "high", "xhigh", "max"]) {
			const r = plannerDispatch({ runId, projectDir, effort });
			expect(r.agent_namespaced).toBe("lazy-dev:planner");
			expect(r.effort).toBe(effort);
		}
	});

	test("rejects unknown effort", () => {
		expect(() => plannerDispatch({ runId, projectDir, effort: "turbo" })).toThrow(
			/unknown planner effort/,
		);
	});

	test("rejects 'low' (planner minimum is medium)", () => {
		expect(() => plannerDispatch({ runId, projectDir, effort: "low" })).toThrow();
	});

	test("exports the canonical effort ladder", () => {
		expect(Array.from(PLANNER_EFFORTS).sort()).toEqual(["high", "max", "medium", "xhigh"]);
	});

	test("throws if run dir missing", () => {
		expect(() => plannerDispatch({ runId: "missing-run", projectDir })).toThrow(/not found/);
	});

	test("throws if brief.md missing", () => {
		rmSync(join(projectDir, ".lazy-dev", "runs", runId, "brief.md"));
		expect(() => plannerDispatch({ runId, projectDir })).toThrow(/brief missing/);
	});
});

describe("plannerDispatch git-init detection", () => {
	test("includes git-init instructions when status has needs_git_init", () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", runId);
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "plan", needs_git_init: true }),
		);
		const r = plannerDispatch({ runId, projectDir });
		expect(r.dispatch_prompt).toContain("GIT INIT REQUIRED");
		expect(r.dispatch_prompt).toContain('"git_init": true');
		expect(r.dispatch_prompt).toContain("skip worktree creation");
	});

	test("clears needs_git_init from status.json after reading it", () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", runId);
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ run_id: runId, phase: "plan", needs_git_init: true }),
		);
		plannerDispatch({ runId, projectDir });
		const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
		expect(status.needs_git_init).toBeUndefined();
		expect(status.phase).toBe("plan");
	});

	test("does not include git-init instructions when needs_git_init is absent", () => {
		const r = plannerDispatch({ runId, projectDir });
		expect(r.dispatch_prompt).not.toContain("GIT INIT REQUIRED");
	});
});

describe("planner-dispatch CLI", () => {
	test("CLI dispatches planner with default effort", () => {
		const result = spawnSync("node", [CLI_PATH, runId], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
		expect(output.effort).toBe("high");
	});

	test("CLI dispatches planner with custom effort", () => {
		const result = spawnSync("node", [CLI_PATH, runId, "max"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
		expect(output.effort).toBe("max");
	});

	test("CLI returns usage error without run_id", () => {
		const result = spawnSync("node", [CLI_PATH], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
		expect(output.detail).toContain("usage");
	});

	test("CLI returns error for invalid effort", () => {
		const result = spawnSync("node", [CLI_PATH, runId, "turbo"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
	});
});
