import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewBuildTool } from "./review-build.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "review-build-tool-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("reviewBuildTool", () => {
	test("has correct tool metadata", () => {
		expect(reviewBuildTool.name).toBe("review_build");
		expect(reviewBuildTool.inputSchema.required).toEqual(["run_id"]);
		expect(reviewBuildTool.inputSchema.properties.effort.enum).toEqual(["high", "xhigh", "max"]);
	});

	test("handler builds review envelope", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-rb");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			join(runDir, "tasks.json"),
			JSON.stringify({ tasks: [{ id: "T-0001", agent: "code-small" }] }),
		);
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "review" }));

		const result = await reviewBuildTool.handler({ run_id: "run-rb" }, { projectDir });
		expect(result.agent_namespaced).toContain("reviewer");
		expect(result.envelope_path).toContain("review-envelope.json");
		expect(result.dispatch_prompt).toContain("Envelope:");
	});

	test("handler accepts effort parameter", async () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-rb2");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "tasks.json"), JSON.stringify({ tasks: [] }));
		writeFileSync(join(runDir, "status.json"), JSON.stringify({ phase: "review" }));

		const result = await reviewBuildTool.handler(
			{ run_id: "run-rb2", effort: "max" },
			{ projectDir },
		);
		expect(result.effort).toBe("max");
		expect(result.agent_namespaced).toContain("max");
	});
});
