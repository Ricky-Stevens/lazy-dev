import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveTool } from "./approve.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "approve-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("approveTool", () => {
	test("has correct tool metadata", () => {
		expect(approveTool.name).toBe("approve");
		expect(approveTool.inputSchema.type).toBe("object");
		expect(approveTool.inputSchema.required).toContain("run_id");
	});

	test("handler writes approval.md and returns phase:approved", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-approve");
		mkdirSync(runDir, { recursive: true });

		const result = await approveTool.handler({ run_id: "run-approve" }, { projectDir });
		expect(result).toEqual({ phase: "approved" });
		expect(existsSync(join(runDir, "approval.md"))).toBe(true);
	});

	test("handler rejects invalid run_id", async () => {
		expect(approveTool.handler({ run_id: "../escape" }, { projectDir })).rejects.toThrow();
	});

	test("handler rejects empty run_id", async () => {
		expect(approveTool.handler({ run_id: "" }, { projectDir })).rejects.toThrow();
	});
});
