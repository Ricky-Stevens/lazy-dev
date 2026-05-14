import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
