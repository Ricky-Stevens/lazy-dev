import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAgentUsage, updateUsageIteration } from "./gate-telemetry.js";

let tmpDir;
const savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "gate-telemetry-test-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
	if (savedPluginRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
	else delete process.env.CLAUDE_PLUGIN_ROOT;
});

function makeRunDir(pd, runId) {
	const runDir = join(pd, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	return runDir;
}

describe("recordAgentUsage", () => {
	test("creates usage.json with agent entry", () => {
		const pd = join(tmpDir, "usage1");
		const runDir = makeRunDir(pd, "r1");

		recordAgentUsage({
			projectDir: pd,
			runId: "r1",
			agentId: "agent-abc",
			agentType: "lazy-dev:code-small",
			bareAgentName: "code-small",
			taskId: "T-0001",
			iteration: 1,
			transcriptPath: null,
			payload: {},
			logDebug: () => {},
		});

		const usage = JSON.parse(readFileSync(join(runDir, "usage.json"), "utf8"));
		expect(usage.totals).toBeDefined();
		expect(usage.by_agent["lazy-dev:code-small"]).toBeDefined();
		expect(usage.by_iteration).toBeInstanceOf(Array);
		expect(usage.by_iteration.length).toBeGreaterThan(0);
	});

	test("extracts usage from payload when available", () => {
		const pd = join(tmpDir, "usage2");
		makeRunDir(pd, "r2");

		recordAgentUsage({
			projectDir: pd,
			runId: "r2",
			agentId: "agent-def",
			agentType: "lazy-dev:code-big",
			bareAgentName: "code-big",
			taskId: "T-0002",
			iteration: 1,
			transcriptPath: null,
			payload: {
				usage: { input_tokens: 100, output_tokens: 50 },
			},
			logDebug: () => {},
		});

		const usage = JSON.parse(readFileSync(join(pd, ".lazy-dev", "runs", "r2", "usage.json"), "utf8"));
		expect(usage.totals.input_tokens).toBe(100);
		expect(usage.totals.output_tokens).toBe(50);
	});

	test("reads model from transcript JSONL", () => {
		const pd = join(tmpDir, "usage3");
		makeRunDir(pd, "r3");

		const transcriptPath = join(tmpDir, "transcript.jsonl");
		writeFileSync(transcriptPath, JSON.stringify({ model: "claude-sonnet-4-6-20250514" }) + "\n");

		const logs = [];
		recordAgentUsage({
			projectDir: pd,
			runId: "r3",
			agentId: "agent-ghi",
			agentType: "lazy-dev:code-small",
			bareAgentName: "code-small",
			taskId: "T-0003",
			iteration: 1,
			transcriptPath,
			payload: {},
			logDebug: (msg) => logs.push(msg),
		});

		const usage = JSON.parse(readFileSync(join(pd, ".lazy-dev", "runs", "r3", "usage.json"), "utf8"));
		const entry = usage.by_iteration[0];
		expect(entry.model_actual).toBe("claude-sonnet-4-6-20250514");
	});
});

describe("updateUsageIteration", () => {
	test("updates iteration on matching agent_id", () => {
		const pd = join(tmpDir, "iter1");
		const runDir = makeRunDir(pd, "r-iter");
		const usagePath = join(runDir, "usage.json");
		writeFileSync(
			usagePath,
			JSON.stringify({
				totals: {},
				by_agent: {},
				by_iteration: [
					{ agent_id: "agent-1", iteration: 1 },
					{ agent_id: "agent-2", iteration: 1 },
				],
			}),
		);

		updateUsageIteration(pd, "r-iter", "agent-2", 2);

		const updated = JSON.parse(readFileSync(usagePath, "utf8"));
		expect(updated.by_iteration[1].iteration).toBe(2);
		expect(updated.by_iteration[0].iteration).toBe(1);
	});

	test("no-ops when usage.json does not exist", () => {
		updateUsageIteration(join(tmpDir, "nonexistent"), "r-x", "agent-1", 2);
	});

	test("no-ops when by_iteration is missing", () => {
		const pd = join(tmpDir, "iter2");
		const runDir = makeRunDir(pd, "r-iter2");
		writeFileSync(join(runDir, "usage.json"), JSON.stringify({ totals: {} }));
		updateUsageIteration(pd, "r-iter2", "agent-1", 2);
	});
});

describe("recordAgentUsage — model mismatch", () => {
	test("detects model mismatch when transcript model differs from agent frontmatter", () => {
		const pd = join(tmpDir, "mismatch1");
		makeRunDir(pd, "r-mm");

		const pluginRoot = join(tmpDir, "plugin-root");
		const agentDir = join(pluginRoot, "agents");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "code-small.md"), "---\nmodel: claude-haiku-4-5-20251001\neffort: low\n---\nSystem prompt.\n");

		const transcriptPath = join(tmpDir, "transcript-mm.jsonl");
		writeFileSync(transcriptPath, JSON.stringify({ model: "claude-sonnet-4-6-20250514" }) + "\n");

		const savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
		process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
		try {
			const logs = [];
			recordAgentUsage({
				projectDir: pd,
				runId: "r-mm",
				agentId: "agent-mm",
				agentType: "lazy-dev:code-small",
				bareAgentName: "code-small",
				taskId: "T-0001",
				iteration: 1,
				transcriptPath,
				payload: {},
				logDebug: (msg) => logs.push(msg),
			});

			const usage = JSON.parse(readFileSync(join(pd, ".lazy-dev", "runs", "r-mm", "usage.json"), "utf8"));
			const entry = usage.by_iteration[0];
			expect(entry.model_mismatch).toBe(true);
			expect(entry.model_expected).toBe("claude-haiku-4-5-20251001");
			expect(entry.model_actual).toBe("claude-sonnet-4-6-20250514");
			expect(entry.effort_expected).toBe("low");
			expect(logs.some((l) => l.includes("WARN model mismatch"))).toBe(true);
		} finally {
			if (savedPluginRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
			else delete process.env.CLAUDE_PLUGIN_ROOT;
		}
	});

	test("reads model from nested request.model in transcript", () => {
		const pd = join(tmpDir, "nested-model");
		makeRunDir(pd, "r-nm");

		const transcriptPath = join(tmpDir, "transcript-nested.jsonl");
		writeFileSync(transcriptPath, JSON.stringify({ request: { model: "claude-opus-4-7-20250513" } }) + "\n");

		const logs = [];
		recordAgentUsage({
			projectDir: pd,
			runId: "r-nm",
			agentId: "agent-nm",
			agentType: "lazy-dev:code-big",
			bareAgentName: "code-big",
			taskId: "T-0001",
			iteration: 1,
			transcriptPath,
			payload: {},
			logDebug: (msg) => logs.push(msg),
		});

		const usage = JSON.parse(readFileSync(join(pd, ".lazy-dev", "runs", "r-nm", "usage.json"), "utf8"));
		expect(usage.by_iteration[0].model_actual).toBe("claude-opus-4-7-20250513");
	});
});
