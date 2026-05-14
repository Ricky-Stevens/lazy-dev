import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunTool } from "./create-run.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "create-run-tool-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("createRunTool", () => {
	test("has correct tool metadata", () => {
		expect(createRunTool.name).toBe("create_run");
		expect(createRunTool.inputSchema.required).toContain("brief");
		expect(createRunTool.inputSchema.properties.brief.minLength).toBe(1);
	});

	test("handler creates a run and returns run_id + run_dir", async () => {
		const result = await createRunTool.handler({ brief: "Add dark mode" }, { projectDir });
		expect(result.run_id).toBeDefined();
		expect(result.run_dir).toBeDefined();
		expect(existsSync(result.run_dir)).toBe(true);
	});

	test("handler rejects empty brief", async () => {
		expect(createRunTool.handler({ brief: "" }, { projectDir })).rejects.toThrow();
	});
});
