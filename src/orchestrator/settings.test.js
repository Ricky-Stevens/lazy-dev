import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, readRunConfig, resolveSettings, snapshotForRun } from "./settings.js";

let projectDir;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "lazy-dev-settings-"));
});
afterEach(() => {
	try {
		rmSync(projectDir, { recursive: true, force: true });
	} catch {}
});

describe("resolveSettings", () => {
	test("returns defaults when no files exist", () => {
		const r = resolveSettings(projectDir);
		expect(r.parallelism.max_parallel).toBe(DEFAULTS.parallelism.max_parallel);
	});

	test("project settings override defaults", () => {
		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		writeFileSync(
			join(projectDir, ".claude", "settings.json"),
			JSON.stringify({
				"lazy-dev": { parallelism: { max_parallel: 5 } },
			}),
		);
		const r = resolveSettings(projectDir);
		expect(r.parallelism.max_parallel).toBe(5);
	});

	test("project local settings trump claude settings", () => {
		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		writeFileSync(
			join(projectDir, ".claude", "settings.json"),
			JSON.stringify({
				"lazy-dev": { parallelism: { max_parallel: 5 } },
			}),
		);
		mkdirSync(join(projectDir, ".lazy-dev"), { recursive: true });
		writeFileSync(
			join(projectDir, ".lazy-dev", "settings.json"),
			JSON.stringify({
				parallelism: { max_parallel: 7 },
			}),
		);
		const r = resolveSettings(projectDir);
		expect(r.parallelism.max_parallel).toBe(7);
	});

	test("hard cap clamps over-budget config", () => {
		mkdirSync(join(projectDir, ".lazy-dev"), { recursive: true });
		writeFileSync(
			join(projectDir, ".lazy-dev", "settings.json"),
			JSON.stringify({
				parallelism: { max_parallel: 99 },
			}),
		);
		const r = resolveSettings(projectDir);
		expect(r.parallelism.max_parallel).toBe(DEFAULTS.parallelism.max_parallel_hard_cap);
	});

	test("deep merges nested objects", () => {
		mkdirSync(join(projectDir, ".lazy-dev"), { recursive: true });
		writeFileSync(
			join(projectDir, ".lazy-dev", "settings.json"),
			JSON.stringify({
				budget: { per_task: { max_output_tokens: 999 } },
			}),
		);
		const r = resolveSettings(projectDir);
		expect(r.budget.per_task.max_output_tokens).toBe(999);
		// Other keys preserved
		expect(r.budget.per_task.max_input_tokens).toBe(DEFAULTS.budget.per_task.max_input_tokens);
		expect(r.budget.per_run.max_input_tokens).toBe(DEFAULTS.budget.per_run.max_input_tokens);
	});

	test("arrays replace rather than merge", () => {
		mkdirSync(join(projectDir, ".lazy-dev"), { recursive: true });
		writeFileSync(
			join(projectDir, ".lazy-dev", "settings.json"),
			JSON.stringify({
				routing: { confirm_before: ["feature"] },
			}),
		);
		const r = resolveSettings(projectDir);
		expect(r.routing.confirm_before).toEqual(["feature"]);
	});
});

describe("snapshotForRun + readRunConfig", () => {
	test("snapshot persists a run-specific config", () => {
		const runId = "2026-04-18T10-00-00Z-abc123";
		snapshotForRun(projectDir, runId, { parallelism: { max_parallel: 2 } });
		const back = readRunConfig(projectDir, runId);
		expect(back.parallelism.max_parallel).toBe(2);
	});

	test("subsequent project changes do not affect a snapshotted run", () => {
		const runId = "2026-04-18T10-00-00Z-abc123";
		snapshotForRun(projectDir, runId);

		// Change project settings after snapshot
		mkdirSync(join(projectDir, ".lazy-dev"), { recursive: true });
		writeFileSync(
			join(projectDir, ".lazy-dev", "settings.json"),
			JSON.stringify({
				parallelism: { max_parallel: 8 },
			}),
		);

		const back = readRunConfig(projectDir, runId);
		expect(back.parallelism.max_parallel).toBe(DEFAULTS.parallelism.max_parallel);
	});
});
