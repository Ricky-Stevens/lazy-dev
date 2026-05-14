import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerifiers } from "./verify.js";

let cwd;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "lazy-dev-verify-"));
});

afterEach(() => {
	try {
		rmSync(cwd, { recursive: true, force: true });
	} catch {}
});

describe("runVerifiers — shell", () => {
	test("pass on exit 0", () => {
		const r = runVerifiers({
			criteria: [{ id: "ok", kind: "shell", cmd: "true" }],
			cwd,
		});
		expect(r[0].passed).toBe(true);
	});

	test("fail on non-zero exit", () => {
		const r = runVerifiers({
			criteria: [{ id: "bad", kind: "shell", cmd: "false" }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].failure_signature).toBeTruthy();
	});

	test("respects custom must_exit", () => {
		// bun -e "process.exit(2)" exits with code 2 without shell metacharacters.
		const r = runVerifiers({
			criteria: [{ id: "ex2", kind: "shell", cmd: "bun -e process.exit(2)", must_exit: 2 }],
			cwd,
		});
		expect(r[0].passed).toBe(true);
	});

	test("same failing cmd produces stable failure_signature", () => {
		const c = { id: "x", kind: "shell", cmd: "false" };
		const r1 = runVerifiers({ criteria: [c], cwd })[0];
		const r2 = runVerifiers({ criteria: [c], cwd })[0];
		expect(r1.passed).toBe(false);
		expect(r1.failure_signature).toBe(r2.failure_signature);
	});
});

describe("runVerifiers — grep", () => {
	test("must_match true passes when pattern found", () => {
		writeFileSync(join(cwd, "a.txt"), "hello world");
		const r = runVerifiers({
			criteria: [
				{
					id: "g",
					kind: "grep",
					pattern: "hello",
					in_file: "a.txt",
					must_match: true,
				},
			],
			cwd,
		});
		expect(r[0].passed).toBe(true);
	});

	test("must_match false passes when pattern absent", () => {
		writeFileSync(join(cwd, "a.txt"), "hello world");
		const r = runVerifiers({
			criteria: [
				{
					id: "g",
					kind: "grep",
					pattern: "goodbye",
					in_file: "a.txt",
					must_match: false,
				},
			],
			cwd,
		});
		expect(r[0].passed).toBe(true);
	});

	test("must_match true fails when pattern absent", () => {
		writeFileSync(join(cwd, "a.txt"), "hello world");
		const r = runVerifiers({
			criteria: [
				{
					id: "g",
					kind: "grep",
					pattern: "missing",
					in_file: "a.txt",
					must_match: true,
				},
			],
			cwd,
		});
		expect(r[0].passed).toBe(false);
	});
});

describe("runVerifiers — file_exists", () => {
	test("passes when file exists", () => {
		writeFileSync(join(cwd, "f.txt"), "x");
		const r = runVerifiers({
			criteria: [{ id: "fe", kind: "file_exists", path: "f.txt" }],
			cwd,
		});
		expect(r[0].passed).toBe(true);
	});

	test("fails when missing", () => {
		const r = runVerifiers({
			criteria: [{ id: "fe", kind: "file_exists", path: "missing.txt" }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
	});
});

describe("runVerifiers — diff_scope", () => {
	function initRepo() {
		execSync("git init -q && git config user.email a@b.c && git config user.name t", { cwd });
		writeFileSync(join(cwd, "a.js"), "export const a = 1;\n");
		writeFileSync(join(cwd, "b.js"), "export const b = 1;\n");
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src/c.js"), "export const c = 1;\n");
		execSync("git add . && git commit -q -m init", { cwd });
	}

	test("passes when all changed files are in scope", () => {
		initRepo();
		writeFileSync(join(cwd, "a.js"), "export const a = 2;\n");
		execSync("git add . && git commit -q -m change", { cwd });

		const r = runVerifiers({
			criteria: [{ id: "scope", kind: "diff_scope" }],
			cwd,
			scopeAllowedPaths: ["a.js", "b.js"],
			gitBaseRef: "HEAD~1",
		});
		expect(r[0].passed).toBe(true);
	});

	test("fails when a changed file is outside scope", () => {
		initRepo();
		writeFileSync(join(cwd, "a.js"), "export const a = 2;\n");
		writeFileSync(join(cwd, "src/c.js"), "export const c = 2;\n");
		execSync("git add . && git commit -q -m change", { cwd });

		const r = runVerifiers({
			criteria: [{ id: "scope", kind: "diff_scope" }],
			cwd,
			scopeAllowedPaths: ["a.js"],
			gitBaseRef: "HEAD~1",
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("src/c.js");
	});

	test("glob scope pattern matches nested files", () => {
		initRepo();
		writeFileSync(join(cwd, "src/c.js"), "export const c = 2;\n");
		execSync("git add . && git commit -q -m change", { cwd });

		const r = runVerifiers({
			criteria: [{ id: "scope", kind: "diff_scope" }],
			cwd,
			scopeAllowedPaths: ["src/**"],
			gitBaseRef: "HEAD~1",
		});
		expect(r[0].passed).toBe(true);
	});
});
