import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelRunTool } from "./cancel.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "cancel-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("cancelRunTool", () => {
	test("has correct tool metadata", () => {
		expect(cancelRunTool.name).toBe("cancel");
		expect(cancelRunTool.inputSchema.required).toContain("run_id");
	});

	test("handler sets phase to cancelled and returns prev_phase", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-cancel");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "status.json"),
			JSON.stringify({ phase: "specialists" }),
		);

		const result = await cancelRunTool.handler({ run_id: "run-cancel" }, { projectDir });
		expect(result.phase).toBe("cancelled");
		expect(result.prev_phase).toBe("specialists");

		const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
		expect(status.phase).toBe("cancelled");
	});

	test("handler returns null prev_phase when no prior status", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-cancel2");
		mkdirSync(runDir, { recursive: true });

		const result = await cancelRunTool.handler({ run_id: "run-cancel2" }, { projectDir });
		expect(result.phase).toBe("cancelled");
		expect(result.prev_phase).toBe(null);
	});

	test("handler rejects invalid run_id", async () => {
		expect(
			cancelRunTool.handler({ run_id: "../bad" }, { projectDir }),
		).rejects.toThrow();
	});
});
