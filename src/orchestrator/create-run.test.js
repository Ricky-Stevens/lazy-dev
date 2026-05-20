import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRun } from "./create-run.js";

const CLI_PATH = resolve(import.meta.dirname, "create-run.js");

let tmpDir;

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "create-run-test-"));
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function initGitRepo(dir) {
	execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
	writeFileSync(join(dir, "README.md"), "init\n");
	execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

describe("createRun", () => {
	test("creates run dir with brief.md and status.json", () => {
		const result = createRun({ brief: "Fix the login bug", projectDir: tmpDir });
		expect(result.run_id).toBeDefined();
		expect(result.run_dir).toContain(".lazy-dev/runs/");

		expect(existsSync(join(result.run_dir, "brief.md"))).toBe(true);
		expect(existsSync(join(result.run_dir, "status.json"))).toBe(true);

		const brief = readFileSync(join(result.run_dir, "brief.md"), "utf8");
		expect(brief.trim()).toBe("Fix the login bug");

		const status = JSON.parse(readFileSync(join(result.run_dir, "status.json"), "utf8"));
		expect(status.run_id).toBe(result.run_id);
		expect(status.phase).toBe("plan");
	});

	test("run_id has timestamp-hex format", () => {
		const result = createRun({ brief: "test", projectDir: tmpDir });
		expect(result.run_id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[a-f0-9]{6}$/);
	});

	test("strips NUL bytes from brief", () => {
		const result = createRun({ brief: "hello\x00world", projectDir: tmpDir });
		const brief = readFileSync(join(result.run_dir, "brief.md"), "utf8");
		expect(brief).not.toContain("\x00");
		expect(brief.trim()).toBe("helloworld");
	});

	test("throws on empty brief", () => {
		expect(() => createRun({ brief: "", projectDir: tmpDir })).toThrow();
	});

	test("throws on whitespace-only brief", () => {
		expect(() => createRun({ brief: "   \n  ", projectDir: tmpDir })).toThrow();
	});

	test("throws on non-string brief", () => {
		expect(() => createRun({ brief: 123, projectDir: tmpDir })).toThrow();
	});

	test("each run gets a unique ID", () => {
		const a = createRun({ brief: "a", projectDir: tmpDir });
		const b = createRun({ brief: "b", projectDir: tmpDir });
		expect(a.run_id).not.toBe(b.run_id);
	});

	test("sets needs_git_init when projectDir is not a git repo", () => {
		const noGitDir = mkdtempSync(join(tmpdir(), "create-run-no-git-"));
		try {
			const result = createRun({ brief: "test", projectDir: noGitDir });
			expect(result.warning).toContain("not a git repository");
			const status = JSON.parse(readFileSync(join(result.run_dir, "status.json"), "utf8"));
			expect(status.needs_git_init).toBe(true);
		} finally {
			rmSync(noGitDir, { recursive: true, force: true });
		}
	});

	test("does not set needs_git_init when projectDir is a git repo", () => {
		const gitDir = mkdtempSync(join(tmpdir(), "create-run-git-"));
		try {
			initGitRepo(gitDir);
			const result = createRun({ brief: "test", projectDir: gitDir });
			expect(result.warning).toBeUndefined();
			const status = JSON.parse(readFileSync(join(result.run_dir, "status.json"), "utf8"));
			expect(status.needs_git_init).toBeUndefined();
		} finally {
			rmSync(gitDir, { recursive: true, force: true });
		}
	});
});

describe("create-run CLI", () => {
	test("--brief creates a run", () => {
		const result = spawnSync("node", [CLI_PATH, "--brief", "CLI test"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
			timeout: 10_000,
		});
		expect(result.status).toBe(0);
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
		expect(output.run_id).toBeDefined();
	});

	test("--brief-file reads brief from file", () => {
		const briefFile = join(tmpDir, "test-brief.md");
		writeFileSync(briefFile, "Brief from file");
		const result = spawnSync("node", [CLI_PATH, "--brief-file", briefFile], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
			timeout: 10_000,
		});
		expect(result.status).toBe(0);
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(true);
	});

	test("missing brief returns error", () => {
		const result = spawnSync("node", [CLI_PATH], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
		expect(output.detail).toContain("brief is required");
	});

	test("nonexistent brief-file returns error", () => {
		const result = spawnSync("node", [CLI_PATH, "--brief-file", "/nonexistent/file.md"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
			timeout: 10_000,
		});
		const output = JSON.parse(result.stdout.trim());
		expect(output.ok).toBe(false);
		expect(output.detail).toContain("not found");
	});

	test("unexpected positional arg exits non-zero", () => {
		const result = spawnSync("node", [CLI_PATH, "bare-arg"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
			timeout: 10_000,
		});
		expect(result.status).not.toBe(0);
	});

	test("missing value for flag exits non-zero", () => {
		const result = spawnSync("node", [CLI_PATH, "--brief"], {
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
			timeout: 10_000,
		});
		expect(result.status).not.toBe(0);
	});
});
