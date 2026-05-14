import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneTool } from "./prune.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "prune-tool-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("pruneTool", () => {
	test("has correct tool metadata", () => {
		expect(pruneTool.name).toBe("prune");
		expect(pruneTool.inputSchema.required).toEqual(["run_id"]);
	});

	test("handler prunes a done run", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-prune");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "done" }));

		const result = await pruneTool.handler({ run_id: "run-prune" }, { projectDir });
		expect(result.run_id).toBe("run-prune");
		expect(result.run_dir_preserved).toContain("run-prune");
	});

	test("handler refuses active run", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-active");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "specialists" }));

		expect(
			pruneTool.handler({ run_id: "run-active" }, { projectDir }),
		).rejects.toThrow("refusing to prune");
	});
});
