import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "./state.js";

let projectDir;
beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "lazy-dev-state-"));
});
afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("StateStore dispatched_at / completed_at", () => {
	test("seeds dispatched_at from envelope on first load", () => {
		const taskDir = join(projectDir, ".lazy-dev/runs/R1/tasks/T-0001");
		const { mkdirSync, writeFileSync } = require("node:fs");
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			join(taskDir, "envelope.json"),
			JSON.stringify({ id: "T-0001", dispatched_at: "2026-04-19T12:00:00.000Z" }),
		);
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0001" });
		const loaded = s.load();
		expect(loaded.dispatched_at).toBe("2026-04-19T12:00:00.000Z");
	});

	test("records completed_at on each iteration", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0001" });
		s.recordIteration({
			iteration: 1,
			sentinelKind: "completed",
			sentinelBody: { summary: "ok" },
			verifierResults: [],
			diffHash: "x",
			failingSignature: null,
		});
		const loaded = s.load();
		expect(loaded.completed_at).toBeTruthy();
		expect(Date.parse(loaded.completed_at)).toBeGreaterThan(0);
	});
});

describe("StateStore kind routing", () => {
	test("default kind writes under tasks/", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0001" });
		expect(s.taskDir).toBe(join(projectDir, ".lazy-dev/runs/R1/tasks/T-0001"));
		expect(existsSync(s.taskDir)).toBe(true);
	});

	test("kind='merge' writes under merges/", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "M-0001-T-0001", kind: "merge" });
		expect(s.taskDir).toBe(join(projectDir, ".lazy-dev/runs/R1/merges/M-0001-T-0001"));
		expect(existsSync(s.taskDir)).toBe(true);
	});

	test("markApproved writes APPROVED into the correct bucket", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "M-0001-T-0001", kind: "merge" });
		s.markApproved({ summary: "ok" });
		const approved = join(projectDir, ".lazy-dev/runs/R1/merges/M-0001-T-0001/APPROVED");
		expect(existsSync(approved)).toBe(true);
		const body = JSON.parse(readFileSync(approved, "utf8"));
		expect(body.sentinel.summary).toBe("ok");
	});

	test("task kind does not leak into merges/", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0001" });
		s.markApproved({ summary: "ok" });
		expect(existsSync(join(projectDir, ".lazy-dev/runs/R1/merges/T-0001/APPROVED"))).toBe(false);
	});
});

describe("StateStore constructor validation", () => {
	test("throws without projectDir", () => {
		expect(() => new StateStore({ runId: "R1", taskId: "T-0001" })).toThrow("projectDir required");
	});

	test("throws without runId", () => {
		expect(() => new StateStore({ projectDir, taskId: "T-0001" })).toThrow("runId required");
	});

	test("throws without taskId", () => {
		expect(() => new StateStore({ projectDir, runId: "R1" })).toThrow("taskId required");
	});
});

describe("StateStore markFailed", () => {
	test("writes FAILED marker with reason and details", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0002" });
		s.markFailed("max_iter_reached", { iteration: 3, failing: ["lint"] });

		const failedPath = join(projectDir, ".lazy-dev/runs/R1/tasks/T-0002/FAILED");
		expect(existsSync(failedPath)).toBe(true);
		const body = JSON.parse(readFileSync(failedPath, "utf8"));
		expect(body.reason).toBe("max_iter_reached");
		expect(body.details.iteration).toBe(3);
		expect(body.at).toBeDefined();
	});

	test("writes FAILED with empty details by default", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0003" });
		s.markFailed("specialist_blocked");

		const body = JSON.parse(readFileSync(s.failedMarker, "utf8"));
		expect(body.reason).toBe("specialist_blocked");
		expect(body.details).toEqual({});
	});
});

describe("StateStore load edge cases", () => {
	test("load returns default state when no state file exists", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0004" });
		const loaded = s.load();
		expect(loaded.iteration).toBe(0);
		expect(loaded.history).toEqual([]);
		expect(loaded.task_id).toBe("T-0004");
		expect(loaded.run_id).toBe("R1");
		expect(loaded.started_at).toBeDefined();
	});

	test("load handles corrupt state file gracefully", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0005" });
		writeFileSync(s.stateFile, "not valid json {{{");
		const loaded = s.load();
		expect(loaded.iteration).toBe(0);
		expect(loaded.recovered_from_corrupt).toBeDefined();
	});

	test("load returns null dispatched_at when no envelope", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0006" });
		const loaded = s.load();
		expect(loaded.dispatched_at).toBe(null);
	});
});

describe("StateStore save/load round-trip", () => {
	test("save and load preserve state", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0007" });
		const state = {
			task_id: "T-0007",
			run_id: "R1",
			iteration: 2,
			history: [
				{ iteration: 1, at: "2025-01-01" },
				{ iteration: 2, at: "2025-01-02" },
			],
		};
		s.save(state);
		const loaded = s.load();
		expect(loaded.iteration).toBe(2);
		expect(loaded.history).toHaveLength(2);
	});
});

describe("StateStore recordIteration", () => {
	test("records iteration with all fields", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0008" });
		const result = s.recordIteration({
			iteration: 1,
			sentinelKind: "completed",
			sentinelBody: { summary: "done", task_id: "T-0008" },
			verifierResults: [{ id: "lint", passed: true }],
			diffHash: "abc123",
			failingSignature: null,
			notes: "all good",
		});
		expect(result.iteration).toBe(1);
		expect(result.history).toHaveLength(1);
		expect(result.history[0].sentinel_kind).toBe("completed");
		expect(result.history[0].sentinel_summary).toBe("done");
		expect(result.history[0].diff_hash).toBe("abc123");
		expect(result.history[0].notes).toBe("all good");
		expect(result.completed_at).toBeDefined();
	});

	test("records multiple iterations", () => {
		const s = new StateStore({ projectDir, runId: "R1", taskId: "T-0009" });
		s.recordIteration({
			iteration: 1,
			sentinelKind: "completed",
			sentinelBody: null,
			verifierResults: [],
			diffHash: "a",
			failingSignature: "f1",
		});
		s.recordIteration({
			iteration: 2,
			sentinelKind: "completed",
			sentinelBody: { summary: "fixed" },
			verifierResults: [],
			diffHash: "b",
			failingSignature: null,
		});
		const loaded = s.load();
		expect(loaded.iteration).toBe(2);
		expect(loaded.history).toHaveLength(2);
	});
});
