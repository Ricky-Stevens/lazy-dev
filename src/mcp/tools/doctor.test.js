import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorTool } from "./doctor.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "doctor-tool-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("doctorTool", () => {
	test("has correct tool metadata", () => {
		expect(doctorTool.name).toBe("doctor");
		expect(doctorTool.inputSchema.type).toBe("object");
	});

	test("run_id is optional", () => {
		expect(doctorTool.inputSchema.required).toBeUndefined();
	});

	test("handler returns report string", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-doc");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "done" }));

		const result = await doctorTool.handler({ run_id: "run-doc" }, { projectDir });
		expect(typeof result.report).toBe("string");
		expect(result.report).toContain("run-doc");
	});

	test("handler works without run_id", async () => {
		const result = await doctorTool.handler({}, { projectDir });
		expect(typeof result.report).toBe("string");
	});
});
