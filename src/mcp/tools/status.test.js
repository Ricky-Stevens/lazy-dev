import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusTool } from "./status.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "status-tool-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("statusTool", () => {
	test("has correct tool metadata", () => {
		expect(statusTool.name).toBe("status");
		expect(statusTool.inputSchema.type).toBe("object");
	});

	test("run_id is optional", () => {
		expect(statusTool.inputSchema.required).toBeUndefined();
	});

	test("handler lists runs when no run_id", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-s1");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "done" }));

		const result = await statusTool.handler({}, { projectDir });
		expect(result.runs).toBeInstanceOf(Array);
		expect(result.runs.length).toBeGreaterThanOrEqual(1);
	});

	test("handler returns detailed status with run_id", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-s2");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "specialists" }));

		const result = await statusTool.handler({ run_id: "run-s2" }, { projectDir });
		expect(result.run_id).toBe("run-s2");
		expect(result.phase).toBe("specialists");
		expect(result.tasks).toBeDefined();
	});

	test("handler returns empty runs list when no runs exist", async () => {
		const emptyDir = join(projectDir, "empty-project");
		mkdirSync(emptyDir, { recursive: true });

		const result = await statusTool.handler({}, { projectDir: emptyDir });
		expect(result.runs).toEqual([]);
	});
});
