import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mergerEnvelope, mergerPrepare, mergerPrepareLocked } from "./merge-conflicts.js";

const CLI_PATH = resolve(import.meta.dirname, "merge-conflicts.js");

let projectDir;

beforeAll(() => {
	projectDir = mkdtempSync(join(tmpdir(), "merge-conflicts-test-"));
	execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@test.com"], {
		cwd: projectDir,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: projectDir, stdio: "ignore" });
	writeFileSync(join(projectDir, "README.md"), "init\n");
	execFileSync("git", ["add", "."], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: projectDir, stdio: "ignore" });
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function setupMergeRun(runId, tasks) {
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "tasks.json"), JSON.stringify({ tasks }));
	return runDir;
}

describe("mergerPrepareLocked", () => {
	test("creates merge envelopes for conflicted files", () => {
		setupMergeRun("run-m1", [{ id: "T-0001", agent: "code-small", title: "Fix login" }]);

		const result = mergerPrepareLocked({
			runId: "run-m1",
			taskId: "T-0001",
			conflictedFiles: ["src/auth.js", "src/login.js"],
			projectDir,
		});

		expect(result.merge_ids).toHaveLength(2);
		expect(result.merge_ids[0]).toMatch(/^M-0001-T-0001$/);
		expect(result.merge_ids[1]).toMatch(/^M-0002-T-0001$/);

		const envPath = join(
			projectDir,
			".lazy-dev",
			"runs",
			"run-m1",
			"merges",
			"M-0001-T-0001",
			"envelope.json",
		);
		expect(existsSync(envPath)).toBe(true);

		const envelope = JSON.parse(readFileSync(envPath, "utf8"));
		expect(envelope.agent).toBe("merger");
		expect(envelope.file).toBe("src/auth.js");
		expect(envelope.context.related_task_id).toBe("T-0001");
		expect(envelope.context.related_task_title).toBe("Fix login");
		expect(envelope.completion_criteria).toHaveLength(2);
	});

	test("throws when tasks.json is missing", () => {
		const runDir = join(projectDir, ".lazy-dev", "runs", "run-m-notasks");
		mkdirSync(runDir, { recursive: true });

		expect(() =>
			mergerPrepareLocked({
				runId: "run-m-notasks",
				taskId: "T-0001",
				conflictedFiles: ["a.js"],
				projectDir,
			}),
		).toThrow("tasks.json missing");
	});

	test("second call for the same task starts at next available M-NNNN", () => {
		setupMergeRun("run-m-collision", [
			{ id: "T-0010", agent: "code-small", title: "Collision test" },
		]);

		// First call — creates M-0001-T-0010, M-0002-T-0010
		const first = mergerPrepareLocked({
			runId: "run-m-collision",
			taskId: "T-0010",
			conflictedFiles: ["src/a.js", "src/b.js"],
			projectDir,
		});
		expect(first.merge_ids[0]).toBe("M-0001-T-0010");
		expect(first.merge_ids[1]).toBe("M-0002-T-0010");

		// Second call — existing dirs M-0001 and M-0002 already exist, so next should start at M-0003
		const second = mergerPrepareLocked({
			runId: "run-m-collision",
			taskId: "T-0010",
			conflictedFiles: ["src/c.js"],
			projectDir,
		});
		expect(second.merge_ids[0]).toBe("M-0003-T-0010");
	});
});

describe("mergerPrepare", () => {
	test("creates merge envelopes with lock", () => {
		setupMergeRun("run-mp-lock", [{ id: "T-0001", agent: "code-small", title: "Test" }]);

		const result = mergerPrepare({
			runId: "run-mp-lock",
			taskId: "T-0001",
			conflictedFiles: ["file.js"],
			projectDir,
		});
		expect(result.merge_ids).toHaveLength(1);
		const envPath = join(
			projectDir,
			".lazy-dev",
			"runs",
			"run-mp-lock",
			"merges",
			result.merge_ids[0],
			"envelope.json",
		);
		expect(existsSync(envPath)).toBe(true);
	});

	test("validates run_id", () => {
		expect(() =>
			mergerPrepare({ runId: "../bad", taskId: "T-0001", conflictedFiles: ["a.js"], projectDir }),
		).toThrow();
	});

	test("validates task_id", () => {
		expect(() =>
			mergerPrepare({ runId: "run-1", taskId: "../../x", conflictedFiles: ["a.js"], projectDir }),
		).toThrow();
	});

	test("throws when conflictedFiles is empty", () => {
		expect(() =>
			mergerPrepare({ runId: "run-1", taskId: "T-0001", conflictedFiles: [], projectDir }),
		).toThrow("non-empty array");
	});

	test("throws when conflictedFiles is not an array", () => {
		expect(() =>
			mergerPrepare({ runId: "run-1", taskId: "T-0001", conflictedFiles: "file.js", projectDir }),
		).toThrow("non-empty array");
	});
});

describe("mergerEnvelope", () => {
	test("returns dispatch info for existing merge envelope", () => {
		const runDir = setupMergeRun("run-me", [{ id: "T-0001", agent: "code-small" }]);
		const mergeDir = join(runDir, "merges", "M-0001-T-0001");
		mkdirSync(mergeDir, { recursive: true });
		writeFileSync(
			join(mergeDir, "envelope.json"),
			JSON.stringify({ id: "M-0001-T-0001", agent: "merger" }),
		);

		const result = mergerEnvelope({ runId: "run-me", mergeId: "M-0001-T-0001", projectDir });
		expect(result.agent_namespaced).toBe("lazy-dev:merger");
		expect(result.model).toBe("sonnet");
		expect(result.envelope_path).toContain("M-0001-T-0001");
		expect(result.dispatch_prompt).toContain("Envelope:");
	});

	test("throws when merge envelope is missing", () => {
		setupMergeRun("run-me2", []);
		expect(() =>
			mergerEnvelope({ runId: "run-me2", mergeId: "M-9999-T-0001", projectDir }),
		).toThrow("merge envelope missing");
	});

	test("validates run_id", () => {
		expect(() => mergerEnvelope({ runId: "../x", mergeId: "M-0001", projectDir })).toThrow();
	});

	test("validates merge_id", () => {
		expect(() => mergerEnvelope({ runId: "run-1", mergeId: "../../x", projectDir })).toThrow();
	});
});

describe("merge-conflicts CLI", () => {
	test("envelope mode returns dispatch info", () => {
		const runDir = setupMergeRun("run-cli-me", [{ id: "T-0001", agent: "code-small" }]);
		const mergeDir = join(runDir, "merges", "M-0001-T-0001");
		mkdirSync(mergeDir, { recursive: true });
		writeFileSync(
			join(mergeDir, "envelope.json"),
			JSON.stringify({ id: "M-0001-T-0001", agent: "merger" }),
		);

		const result = spawnSync("node", [CLI_PATH, "envelope", "run-cli-me", "M-0001-T-0001"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
		expect(output.agent_namespaced).toBe("lazy-dev:merger");
	});

	test("prepare mode creates merge envelopes from stdin", () => {
		setupMergeRun("run-cli-mp", [{ id: "T-0001", agent: "code-small" }]);

		const result = spawnSync("node", [CLI_PATH, "prepare", "run-cli-mp", "T-0001"], {
			input: "src/a.js\nsrc/b.js\n",
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
		expect(output.merge_ids).toHaveLength(2);
	});

	test("unknown mode returns error", () => {
		const result = spawnSync("node", [CLI_PATH, "badmode", "run-x", "T-0001"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
	});

	test("prepare without args returns usage error", () => {
		const result = spawnSync("node", [CLI_PATH, "prepare"], {
			input: "",
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
		expect(output.detail).toContain("usage");
	});

	test("envelope without args returns usage error", () => {
		const result = spawnSync("node", [CLI_PATH, "envelope"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
		expect(output.detail).toContain("usage");
	});
});
