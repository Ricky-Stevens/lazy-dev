import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
