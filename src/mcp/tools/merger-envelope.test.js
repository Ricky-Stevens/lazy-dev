import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergerEnvelopeTool } from "./merger-envelope.js";

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "merger-env-tool-test-"));
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

describe("mergerEnvelopeTool", () => {
	test("has correct tool metadata", () => {
		expect(mergerEnvelopeTool.name).toBe("merger_envelope");
		expect(mergerEnvelopeTool.inputSchema.required).toEqual(["run_id", "merge_id"]);
	});

	test("handler returns dispatch info for valid merge", async () => {
		const mergeDir = join(projectDir, ".lazy-dev", "runs", "run-me", "merges", "M-0001-T-0001");
		mkdirSync(mergeDir, { recursive: true });
		writeFileSync(
			join(mergeDir, "envelope.json"),
			JSON.stringify({ id: "M-0001-T-0001", agent: "merger" }),
		);

		const result = await mergerEnvelopeTool.handler(
			{ run_id: "run-me", merge_id: "M-0001-T-0001" },
			{ projectDir },
		);
		expect(result.agent_namespaced).toBe("lazy-dev:merger");
		expect(result.envelope_path).toContain("M-0001-T-0001");
		expect(result.dispatch_prompt).toContain("Envelope:");
	});

	test("handler throws for missing merge envelope", async () => {
		mkdirSync(join(projectDir, ".lazy-dev", "runs", "run-me2"), { recursive: true });
		expect(
			mergerEnvelopeTool.handler(
				{ run_id: "run-me2", merge_id: "M-9999-T-0001" },
				{ projectDir },
			),
		).rejects.toThrow();
	});
});
