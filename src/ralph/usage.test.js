import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractUsageFromPayload,
	extractUsageFromTranscript,
	readUsage,
	recordUsage,
} from "./usage.js";

let projectDir;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "lazy-dev-usage-"));
});
afterEach(() => {
	try {
		rmSync(projectDir, { recursive: true, force: true });
	} catch {}
});

describe("recordUsage", () => {
	test("creates usage.json on first record", () => {
		recordUsage(projectDir, "run-1", {
			agent_type: "lazy-dev:code-small",
			agent_id: "abc",
			task_id: "T-0001",
			iteration: 1,
			input_tokens: 1000,
			output_tokens: 500,
		});
		const data = readUsage(projectDir, "run-1");
		expect(data.run_id).toBe("run-1");
		expect(data.totals.input_tokens).toBe(1000);
		expect(data.totals.output_tokens).toBe(500);
		expect(data.by_agent["lazy-dev:code-small"].calls).toBe(1);
	});

	test("groups by model and by effort", () => {
		recordUsage(projectDir, "run-2", {
			agent_type: "lazy-dev:code-medium",
			model_actual: "claude-sonnet-4-6",
			model_expected: "claude-sonnet-4-6",
			effort_expected: "medium",
			input_tokens: 100,
			output_tokens: 50,
		});
		recordUsage(projectDir, "run-2", {
			agent_type: "lazy-dev:code-big",
			model_actual: "claude-opus-4-7",
			model_expected: "claude-opus-4-7",
			effort_expected: "high",
			input_tokens: 300,
			output_tokens: 150,
		});
		recordUsage(projectDir, "run-2", {
			agent_type: "lazy-dev:code-small",
			model_actual: "claude-haiku-4-5",
			model_expected: "claude-haiku-4-5",
			effort_expected: "low",
			input_tokens: 50,
			output_tokens: 25,
		});
		const data = readUsage(projectDir, "run-2");

		expect(data.by_model["claude-sonnet-4-6"].calls).toBe(1);
		expect(data.by_model["claude-opus-4-7"].calls).toBe(1);
		expect(data.by_model["claude-haiku-4-5"].calls).toBe(1);

		// Effort buckets
		expect(data.by_effort.low.calls).toBe(1);
		expect(data.by_effort.medium.calls).toBe(1);
		expect(data.by_effort.high.calls).toBe(1);
	});

	test("missing model/effort goes into 'unknown'/'unset' buckets", () => {
		recordUsage(projectDir, "run-3", {
			agent_type: "lazy-dev:wrangler",
			input_tokens: 10,
			output_tokens: 5,
		});
		const data = readUsage(projectDir, "run-3");
		expect(data.by_model.unknown.calls).toBe(1);
		expect(data.by_effort.unset.calls).toBe(1);
	});

	test("records model_mismatch flag in by_iteration", () => {
		recordUsage(projectDir, "run-4", {
			agent_type: "lazy-dev:code-small",
			model_actual: "claude-opus-4-7",
			model_expected: "claude-sonnet-4-6",
			model_mismatch: true,
			input_tokens: 10,
			output_tokens: 5,
		});
		const data = readUsage(projectDir, "run-4");
		expect(data.by_iteration[0].model_mismatch).toBe(true);
		expect(data.by_iteration[0].model_expected).toBe("claude-sonnet-4-6");
		expect(data.by_iteration[0].model_actual).toBe("claude-opus-4-7");
	});

	test("accumulates across multiple records", () => {
		recordUsage(projectDir, "run-1", {
			agent_type: "a",
			input_tokens: 100,
			output_tokens: 50,
		});
		recordUsage(projectDir, "run-1", {
			agent_type: "a",
			input_tokens: 200,
			output_tokens: 75,
		});
		recordUsage(projectDir, "run-1", {
			agent_type: "b",
			input_tokens: 50,
			output_tokens: 25,
		});
		const data = readUsage(projectDir, "run-1");
		expect(data.totals.input_tokens).toBe(350);
		expect(data.totals.output_tokens).toBe(150);
		expect(data.by_agent.a.calls).toBe(2);
		expect(data.by_agent.b.calls).toBe(1);
		expect(data.by_iteration.length).toBe(3);
	});

	test("records model_actual when provided", () => {
		recordUsage(projectDir, "run-1", {
			agent_type: "lazy-dev:code-small",
			model_actual: "claude-sonnet-4-6",
			model_expected: "code-small",
			input_tokens: 100,
			output_tokens: 50,
		});
		const data = readUsage(projectDir, "run-1");
		expect(data.by_iteration[0].model_actual).toBe("claude-sonnet-4-6");
	});

	test("readUsage returns empty structure for missing run", () => {
		const data = readUsage(projectDir, "nonexistent");
		expect(data.totals.input_tokens).toBe(0);
		expect(data.by_iteration.length).toBe(0);
	});
});

describe("extractUsageFromPayload", () => {
	test("extracts from standard field names", () => {
		const r = extractUsageFromPayload({
			usage: { input_tokens: 100, output_tokens: 50 },
		});
		expect(r.input_tokens).toBe(100);
		expect(r.output_tokens).toBe(50);
	});

	test("tries alternate field names", () => {
		const r = extractUsageFromPayload({
			usage: { prompt_tokens: 100, completion_tokens: 50 },
		});
		expect(r.input_tokens).toBe(100);
		expect(r.output_tokens).toBe(50);
	});

	test("handles missing payload gracefully", () => {
		expect(extractUsageFromPayload(null)).toEqual({});
		expect(extractUsageFromPayload({})).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		});
	});
});

describe("extractUsageFromTranscript", () => {
	test("sums usage across assistant entries in a JSONL transcript", () => {
		const transcript = join(projectDir, "agent.jsonl");
		const entries = [
			{ type: "user", message: { content: "hi" } },
			{
				type: "assistant",
				message: {
					role: "assistant",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_read_input_tokens: 200,
						cache_creation_input_tokens: 300,
					},
				},
			},
			{
				type: "assistant",
				message: {
					role: "assistant",
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
		];
		writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join("\n"));
		const r = extractUsageFromTranscript(transcript);
		expect(r.input_tokens).toBe(110);
		expect(r.output_tokens).toBe(55);
		expect(r.cache_read_tokens).toBe(200);
		expect(r.cache_creation_tokens).toBe(300);
	});

	test("returns zeros for missing file", () => {
		const r = extractUsageFromTranscript(join(projectDir, "no-such-file.jsonl"));
		expect(r).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_creation_tokens: 0,
		});
	});

	test("skips malformed lines without crashing", () => {
		const transcript = join(projectDir, "bad.jsonl");
		writeFileSync(
			transcript,
			[
				'{"not valid json',
				JSON.stringify({ message: { usage: { input_tokens: 5, output_tokens: 2 } } }),
				"",
			].join("\n"),
		);
		const r = extractUsageFromTranscript(transcript);
		expect(r.input_tokens).toBe(5);
		expect(r.output_tokens).toBe(2);
	});
});
