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

	test("same exit code with different stderr produces identical signature (oscillation fix)", () => {
		writeFileSync(join(cwd, "flaky.sh"), '#!/bin/bash\necho "error at line $RANDOM" >&2; exit 1');
		execSync(`chmod +x ${join(cwd, "flaky.sh")}`);
		const c = { id: "flaky", kind: "shell", cmd: join(cwd, "flaky.sh") };
		const r1 = runVerifiers({ criteria: [c], cwd })[0];
		const r2 = runVerifiers({ criteria: [c], cwd })[0];
		expect(r1.passed).toBe(false);
		expect(r2.passed).toBe(false);
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

describe("runVerifiers — error handling", () => {
	test("unknown verifier kind returns failure", () => {
		const r = runVerifiers({
			criteria: [{ id: "unk", kind: "UNKNOWN" }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("unknown verifier kind");
	});

	test("exception in verifier is caught and reported", () => {
		const r = runVerifiers({
			criteria: [{ id: "bad", kind: "shell" }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("missing cmd");
	});

	test("empty criteria returns empty results", () => {
		const r = runVerifiers({ criteria: [], cwd });
		expect(r).toEqual([]);
	});
});

describe("runVerifiers — shell edge cases", () => {
	test("shell verifier with empty cmd string", () => {
		const r = runVerifiers({
			criteria: [{ id: "e", kind: "shell", cmd: "   " }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("empty");
	});

	test("shell verifier passes with custom must_exit=0 on success", () => {
		const r = runVerifiers({
			criteria: [{ id: "x", kind: "shell", cmd: "true", must_exit: 0 }],
			cwd,
		});
		expect(r[0].passed).toBe(true);
		expect(r[0].details).toContain("exit=0");
	});

	test("shell verifier uses verifier override when available", () => {
		const verifierDir = join(cwd, ".lazy-dev", "verifiers");
		mkdirSync(verifierDir, { recursive: true });
		writeFileSync(join(verifierDir, "mycheck.sh"), "#!/bin/bash\nexit 0\n");
		execSync(`chmod +x ${join(verifierDir, "mycheck.sh")}`);

		const r = runVerifiers({
			criteria: [{ id: "ov", kind: "shell", cmd: "mycheck" }],
			cwd,
			projectDir: cwd,
		});
		expect(r[0].passed).toBe(true);
	});
});

describe("runVerifiers — grep edge cases", () => {
	test("grep missing pattern returns failure", () => {
		const r = runVerifiers({
			criteria: [{ id: "gp", kind: "grep", in_file: "a.txt" }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("missing pattern");
	});

	test("grep rejects path traversal in in_file", () => {
		const r = runVerifiers({
			criteria: [{ id: "gt", kind: "grep", pattern: "x", in_file: "../etc/passwd" }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("path traversal");
	});

	test("grep rejects path traversal in in_glob", () => {
		const r = runVerifiers({
			criteria: [{ id: "gt", kind: "grep", pattern: "x", in_glob: "../../**" }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("path traversal");
	});

	test("grep with neither in_file nor in_glob fails", () => {
		const r = runVerifiers({
			criteria: [{ id: "gn", kind: "grep", pattern: "x" }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("in_file or in_glob");
	});

	test("must_match defaults to true", () => {
		writeFileSync(join(cwd, "test.txt"), "hello");
		const r = runVerifiers({
			criteria: [{ id: "gd", kind: "grep", pattern: "hello", in_file: "test.txt" }],
			cwd,
		});
		expect(r[0].passed).toBe(true);
	});

	test("must_match=false fails when pattern is found", () => {
		writeFileSync(join(cwd, "test.txt"), "hello");
		const r = runVerifiers({
			criteria: [
				{ id: "gf", kind: "grep", pattern: "hello", in_file: "test.txt", must_match: false },
			],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].failure_signature).toBeTruthy();
	});

	test("grep with in_glob matches multiple files", () => {
		writeFileSync(join(cwd, "a.txt"), "target");
		writeFileSync(join(cwd, "b.txt"), "nope");
		const r = runVerifiers({
			criteria: [{ id: "gg", kind: "grep", pattern: "target", in_glob: "*.txt", must_match: true }],
			cwd,
		});
		expect(r[0].passed).toBe(true);
		expect(r[0].details).toContain("a.txt");
	});

	test("grep skips files that don't exist", () => {
		const r = runVerifiers({
			criteria: [
				{ id: "gm", kind: "grep", pattern: "x", in_file: "nonexistent.txt", must_match: true },
			],
			cwd,
		});
		expect(r[0].passed).toBe(false);
	});
});

describe("runVerifiers — file_exists edge cases", () => {
	test("file_exists missing path returns failure", () => {
		const r = runVerifiers({
			criteria: [{ id: "fp", kind: "file_exists" }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("missing path");
	});

	test("file_exists rejects path traversal", () => {
		const r = runVerifiers({
			criteria: [{ id: "ft", kind: "file_exists", path: "../../../etc/passwd" }],
			cwd,
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("path traversal");
	});

	test("file_exists produces failure_signature when missing", () => {
		const r = runVerifiers({
			criteria: [{ id: "fs", kind: "file_exists", path: "missing.txt" }],
			cwd,
		});
		expect(r[0].failure_signature).toBeTruthy();
	});
});

describe("runVerifiers — diff_scope edge cases", () => {
	test("diff_scope without gitBaseRef fails", () => {
		const r = runVerifiers({
			criteria: [{ id: "ds", kind: "diff_scope" }],
			cwd,
			scopeAllowedPaths: ["src/**"],
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("gitBaseRef");
	});

	test("diff_scope fails when git diff fails", () => {
		const r = runVerifiers({
			criteria: [{ id: "ds", kind: "diff_scope" }],
			cwd,
			scopeAllowedPaths: ["src/**"],
			gitBaseRef: "nonexistent-ref",
		});
		expect(r[0].passed).toBe(false);
		expect(r[0].details).toContain("git diff failed");
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
