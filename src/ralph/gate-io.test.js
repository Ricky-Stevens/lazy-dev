import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRetryPrompt, logDebug, readEnvelope } from "./gate-io.js";

let tmpDir;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "gate-io-test-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("readEnvelope", () => {
	test("reads valid JSON envelope", () => {
		const envPath = join(tmpDir, "envelope.json");
		writeFileSync(envPath, JSON.stringify({ task_id: "T-0001", agent: "code-small" }));
		const result = readEnvelope(envPath);
		expect(result).toEqual({ task_id: "T-0001", agent: "code-small" });
	});

	test("returns null for missing file", () => {
		expect(readEnvelope(join(tmpDir, "nonexistent.json"))).toBe(null);
	});

	test("returns null for invalid JSON", () => {
		const badPath = join(tmpDir, "bad.json");
		writeFileSync(badPath, "not json {{{");
		expect(readEnvelope(badPath)).toBe(null);
	});
});

describe("buildRetryPrompt", () => {
	test("formats failing verifiers with iteration info", () => {
		const results = [
			{ id: "test-pass", kind: "shell", passed: true },
			{ id: "lint", kind: "shell", passed: false, details: "eslint failed" },
		];
		const prompt = buildRetryPrompt(results, 1, 3);
		expect(prompt).toContain("Iteration 1 of 3");
		expect(prompt).toContain("2 attempt(s) remaining");
		expect(prompt).toContain("FAIL lint");
		expect(prompt).toContain("eslint failed");
		expect(prompt).toContain("Passing (1): test-pass");
	});

	test("warns on last attempt", () => {
		const results = [{ id: "lint", kind: "shell", passed: false, details: "fail" }];
		const prompt = buildRetryPrompt(results, 3, 3);
		expect(prompt).toContain("LAST ATTEMPT");
		expect(prompt).not.toContain("attempt(s) remaining");
	});

	test("handles all failing", () => {
		const results = [
			{ id: "a", kind: "shell", passed: false, details: "x" },
			{ id: "b", kind: "grep", passed: false, details: "y" },
		];
		const prompt = buildRetryPrompt(results, 1, 3);
		expect(prompt).toContain("FAIL a");
		expect(prompt).toContain("FAIL b");
		expect(prompt).not.toContain("Passing");
	});

	test("handles all passing (empty failing)", () => {
		const results = [{ id: "a", kind: "shell", passed: true }];
		const prompt = buildRetryPrompt(results, 1, 3);
		expect(prompt).toContain("Passing (1): a");
	});

	test("handles empty details gracefully", () => {
		const results = [{ id: "a", kind: "shell", passed: false }];
		const prompt = buildRetryPrompt(results, 1, 2);
		expect(prompt).toContain("FAIL a");
	});
});

describe("logDebug", () => {
	test("appends to gate-debug.log", () => {
		const pd = join(tmpDir, "log-test");
		mkdirSync(pd, { recursive: true });
		logDebug(pd, "test message 1");
		logDebug(pd, "test message 2");
		const logPath = join(pd, ".lazy-dev", "runs", "_gate-log", "gate-debug.log");
		const content = readFileSync(logPath, "utf8");
		expect(content).toContain("test message 1");
		expect(content).toContain("test message 2");
	});
});

// Helper: resolve a path relative to this file's directory for spawning.
const thisDir = join(import.meta.dir);

describe("readStdinJson — stdin cap", () => {
	// Spawn a child process that imports readStdinJson and pipes result to stdout.
	// We verify via the debug log and exit code.
	async function spawnWithStdin(projectDir, stdinData) {
		const scriptPath = join(thisDir, "_test-stdin-helper.js");
		const proc = Bun.spawn(["bun", "run", scriptPath, projectDir], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		proc.stdin.write(stdinData);
		proc.stdin.end();
		const exitCode = await proc.exited;
		const out = await new Response(proc.stdout).text();
		return { exitCode, out: out.trim() };
	}

	test("returns null and logs debug message when stdin exceeds 16 MB", async () => {
		const pd = join(tmpDir, "cap-test");
		mkdirSync(pd, { recursive: true });

		// Write the helper script used by the subprocess
		const helperPath = join(thisDir, "_test-stdin-helper.js");
		writeFileSync(
			helperPath,
			[
				'import { readStdinJson } from "./gate-io.js";',
				"const result = await readStdinJson(process.argv[2]);",
				'process.stdout.write(JSON.stringify(result) + "\\n");',
			].join("\n"),
		);

		// Create a buffer just over 16 MB of non-JSON data
		const overLimit = Buffer.alloc(16 * 1024 * 1024 + 100, "x");
		const { out } = await spawnWithStdin(pd, overLimit);

		// Result must be null
		expect(out).toBe("null");

		// Debug log must contain the truncation message
		const debugLog = join(pd, ".lazy-dev", "runs", "_gate-log", "gate-debug.log");
		expect(existsSync(debugLog)).toBe(true);
		const logContent = readFileSync(debugLog, "utf8");
		expect(logContent).toContain("stdin truncated: exceeded 16 MB cap");

		// Clean up helper
		rmSync(helperPath, { force: true });
	}, 10000);

	test("does not double-log when stdin ends before timeout fires", async () => {
		const pd = join(tmpDir, "no-double-log");
		mkdirSync(pd, { recursive: true });

		const helperPath = join(thisDir, "_test-stdin-helper.js");
		writeFileSync(
			helperPath,
			[
				'import { readStdinJson } from "./gate-io.js";',
				"const result = await readStdinJson(process.argv[2]);",
				'process.stdout.write(JSON.stringify(result) + "\\n");',
			].join("\n"),
		);

		const payload = JSON.stringify({ task_id: "T-0001", sentinel: "test" });
		const { out } = await spawnWithStdin(pd, payload);

		// Result must be the parsed object
		expect(JSON.parse(out)).toEqual({ task_id: "T-0001", sentinel: "test" });

		// At most one payload file should be written (no double-log)
		const logDir = join(pd, ".lazy-dev", "runs", "_gate-log");
		if (existsSync(logDir)) {
			const files = Array.from(
				new Bun.Glob("*.payload.json").scanSync({ cwd: logDir }),
			);
			expect(files.length).toBeLessThanOrEqual(1);
		}

		rmSync(helperPath, { force: true });
	}, 10000);
});
