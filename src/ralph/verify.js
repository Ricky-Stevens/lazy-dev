// verify.js
// Executes completion_criteria from a task envelope against a worktree.
//
// Four kinds:
//   shell       — runs cmd, compares exit code to must_exit (default 0)
//   grep        — pattern in file or glob must_match (true|false)
//   file_exists — path must exist
//   diff_scope  — changed files (git diff --name-only base..HEAD) must all
//                 lie inside scope.allowed_paths globs
//
// Returns an array of { id, kind, passed, details } in envelope order.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { tail } from "../mcp/_io.js";
import { getBunGlob } from "./bun-glob.js";
import { cheapHash } from "./hash.js";

function isPathTraversal(p) {
	return p.startsWith("/") || p.includes("/../") || p.startsWith("../") || join(p).includes("..");
}

export function runVerifiers({
	criteria,
	cwd,
	scopeAllowedPaths = [],
	gitBaseRef,
	projectDir,
	precomputedDiff = null,
}) {
	const ctx = { cwd, scopeAllowedPaths, gitBaseRef, projectDir, precomputedDiff };
	const results = [];
	for (const c of criteria) {
		try {
			results.push(runOne(c, ctx));
		} catch (err) {
			results.push({
				id: c.id,
				kind: c.kind,
				passed: false,
				details: `verifier error: ${err.message}`,
			});
		}
	}
	return results;
}

function runOne(c, ctx) {
	switch (c.kind) {
		case "shell":
			return runShell(c, ctx);
		case "grep":
			return runGrep(c, ctx);
		case "file_exists":
			return runFileExists(c, ctx);
		case "diff_scope":
			return runDiffScope(c, ctx);
		default:
			return {
				id: c.id,
				kind: c.kind,
				passed: false,
				details: `unknown verifier kind: ${c.kind}`,
			};
	}
}

const SHELL_CMD_ALLOWED_PREFIXES = new Set([
	"bun",
	"bunx",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"node",
	"go",
	"pytest",
	"python",
	"python3",
	"cargo",
	"make",
	"tsc",
	"biome",
	"eslint",
	"prettier",
	"jest",
	"vitest",
	"mocha",
	"grep",
	"test",
	"wc",
	"diff",
	"find",
	"ls",
	"cat",
	"head",
	"tail",
	"true",
	"false",
	"echo",
	"exit",
	"dotnet",
	"mvn",
	"gradle",
	"mix",
	"rspec",
	"phpunit",
]);

const SHELL_CMD_BLOCKED_PATTERNS = [
	/\bcurl\b/,
	/\bwget\b/,
	/\bfetch\b/,
	/\brm\s+-rf\b/,
	/\brm\s+--no-preserve-root\b/,
	/\bssh\b/,
	/\bscp\b/,
	/\brsync\b/,
	/\bnc\b/,
	/\bncat\b/,
	/\bnetcat\b/,
	/\bsocat\b/,
	/\bchmod\b/,
	/\bchown\b/,
	/\beval\b/,
	/\bsource\b/,
	/\bbase64\b.*\|/,
	/\|\s*sh\b/,
	/\|\s*bash\b/,
	/>\s*\//, // redirect to absolute path
	/\$\(.*\bcat\b.*\/(\.ssh|\.env|\.gnupg|credentials|secrets)\b/,
];

function validateShellCmd(cmd) {
	const tokens = cmd.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return "shell verifier cmd is empty";
	const first = tokens[0].replace(/^.*\//, ""); // strip path prefix
	if (!SHELL_CMD_ALLOWED_PREFIXES.has(first)) {
		return `shell verifier command "${first}" is not in the allowed list. Use a .lazy-dev/verifiers/ override script for custom commands.`;
	}
	for (const pattern of SHELL_CMD_BLOCKED_PATTERNS) {
		if (pattern.test(cmd)) {
			return `shell verifier command matches blocked pattern ${pattern}. Use a .lazy-dev/verifiers/ override script for custom commands.`;
		}
	}
	return null;
}

function runShell(c, { cwd, projectDir }) {
	if (!c.cmd) {
		return {
			id: c.id,
			kind: c.kind,
			passed: false,
			details: "shell verifier missing cmd",
		};
	}
	const mustExit = Number.isInteger(c.must_exit) ? c.must_exit : 0;
	const tokens = c.cmd.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return { id: c.id, kind: c.kind, passed: false, details: "shell verifier cmd is empty" };
	}

	// Validate the command against the allowlist before executing.
	// User overrides (.lazy-dev/verifiers/) bypass this check since they're
	// user-authored scripts, not planner output.
	const override = resolveVerifierOverride(c.cmd, projectDir);
	if (!override) {
		const rejection = validateShellCmd(c.cmd);
		if (rejection) {
			return { id: c.id, kind: c.kind, passed: false, details: rejection };
		}
	}
	const execOpts = {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10 * 60_000,
		maxBuffer: 10 * 1024 * 1024,
	};

	let exitCode = 0;
	let stderr = "";
	let stdoutTail = "";
	try {
		const out = override
			? execFileSync("bash", [override.script, ...override.args], execOpts)
			: execFileSync("bash", ["-c", c.cmd], execOpts);
		stdoutTail = tail(out, 40);
	} catch (err) {
		if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
			return {
				id: c.id,
				kind: c.kind,
				passed: false,
				details: `TIMED OUT after ${Math.round(execOpts.timeout / 1000)}s — the command did not complete. Check for hanging network calls, blocked I/O, or infinite loops.\n--- stdout tail ---\n${tail(err.stdout?.toString?.() ?? "", 20)}`,
				failure_signature: cheapHash(`${c.id}|timeout`),
			};
		}
		exitCode = typeof err.status === "number" ? err.status : 1;
		stderr = tail(err.stderr?.toString?.() ?? "", 40);
		stdoutTail = tail(err.stdout?.toString?.() ?? "", 40);
	}
	const passed = exitCode === mustExit;
	return {
		id: c.id,
		kind: c.kind,
		passed,
		details: passed
			? `exit=${exitCode}`
			: `exit=${exitCode} (expected ${mustExit})\n--- stderr tail ---\n${stderr}\n--- stdout tail ---\n${stdoutTail}`,
		failure_signature: passed ? null : cheapHash(`${c.id}|${exitCode}`),
	};
}

function runGrep(c, { cwd }) {
	if (!c.pattern) {
		return {
			id: c.id,
			kind: c.kind,
			passed: false,
			details: "grep verifier missing pattern",
		};
	}
	const mustMatch = c.must_match !== false; // default true
	const re = new RegExp(c.pattern, "m");

	let files = [];
	if (c.in_file) {
		files = [c.in_file];
		if (isPathTraversal(c.in_file)) {
			return {
				id: c.id,
				kind: c.kind,
				passed: false,
				details: `grep in_file rejected: path traversal detected in "${c.in_file}"`,
			};
		}
	} else if (c.in_glob) {
		if (isPathTraversal(c.in_glob)) {
			return {
				id: c.id,
				kind: c.kind,
				passed: false,
				details: `grep in_glob rejected: path traversal detected in "${c.in_glob}"`,
			};
		}
		const G = getBunGlob();
		const g = new G(c.in_glob);
		files = [...g.scanSync(cwd)];
	} else {
		return {
			id: c.id,
			kind: c.kind,
			passed: false,
			details: "grep verifier needs in_file or in_glob",
		};
	}

	const MAX_GREP_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
	let matched = false;
	const matches = [];
	const skipped = [];
	for (const f of files) {
		const full = join(cwd, f);
		if (!existsSync(full)) continue;
		try {
			const size = statSync(full).size;
			if (size > MAX_GREP_FILE_BYTES) {
				skipped.push(f);
				continue;
			}
		} catch {
			continue;
		}
		const content = readFileSync(full, "utf8");
		if (re.test(content)) {
			matched = true;
			matches.push(f);
		}
	}

	const passed = mustMatch ? matched : !matched;
	const skippedNote =
		skipped.length > 0 ? ` (skipped ${skipped.length} file(s) >10MB: ${skipped.join(", ")})` : "";
	return {
		id: c.id,
		kind: c.kind,
		passed,
		details:
			(passed
				? mustMatch
					? `matched in: ${matches.join(", ")}`
					: "no matches (as required)"
				: mustMatch
					? `no match in ${files.length} file(s)`
					: `unexpected match in: ${matches.join(", ")}`) + skippedNote,
		failure_signature: passed ? null : cheapHash(`${c.id}|${matches.join(",")}`),
	};
}

function runFileExists(c, { cwd }) {
	if (!c.path) {
		return {
			id: c.id,
			kind: c.kind,
			passed: false,
			details: "file_exists verifier missing path",
		};
	}
	if (isPathTraversal(c.path)) {
		return {
			id: c.id,
			kind: c.kind,
			passed: false,
			details: `file_exists rejected: path traversal detected in "${c.path}"`,
		};
	}
	const full = join(cwd, c.path);
	const passed = existsSync(full);
	return {
		id: c.id,
		kind: c.kind,
		passed,
		details: passed ? `exists: ${c.path}` : `missing: ${c.path}`,
		failure_signature: passed ? null : cheapHash(`${c.id}|missing`),
	};
}

function runDiffScope(c, { cwd, scopeAllowedPaths, gitBaseRef, precomputedDiff }) {
	if (!gitBaseRef) {
		return {
			id: c.id,
			kind: c.kind,
			passed: false,
			details: "diff_scope needs gitBaseRef",
		};
	}
	let changed = [];
	if (precomputedDiff) {
		changed = precomputedDiff;
	} else {
		try {
			const out = execFileSync("git", ["diff", "--name-only", `${gitBaseRef}...HEAD`], {
				cwd,
				encoding: "utf8",
				timeout: 30_000,
				maxBuffer: 10 * 1024 * 1024,
			});
			changed = out
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);
		} catch (err) {
			return {
				id: c.id,
				kind: c.kind,
				passed: false,
				details: `git diff failed: ${err.message}`,
			};
		}
	}

	const G = getBunGlob();
	const allowed = scopeAllowedPaths.map((p) => new G(p));
	const outside = changed.filter((f) => !allowed.some((g) => g.match(f)));
	const passed = outside.length === 0;
	return {
		id: c.id,
		kind: c.kind,
		passed,
		details: passed
			? `all ${changed.length} changed file(s) within scope`
			: `${outside.length} file(s) outside scope: ${outside.join(", ")}`,
		failure_signature: passed ? null : cheapHash(`${c.id}|${outside.join(",")}`),
	};
}

// --- helpers ---

// If the cmd is a bare token like `typecheck` or `test` and a file
// <project>/.lazy-dev/verifiers/<name>.sh exists, run that script
// instead. This gives projects a clean extension point without editing
// the plug-in.
// Returns { script, args } if a user verifier override exists, or null.
// Uses structured args to avoid shell injection entirely.
function resolveVerifierOverride(cmd, projectDir) {
	if (!projectDir) return null;
	const tokens = cmd.trim().split(/\s+/);
	const firstToken = tokens[0] || "";
	if (!/^[A-Za-z0-9_-]+$/.test(firstToken)) return null;
	const script = join(projectDir, ".lazy-dev", "verifiers", `${firstToken}.sh`);
	if (!existsSync(script)) return null;
	return { script, args: tokens.slice(1) };
}
