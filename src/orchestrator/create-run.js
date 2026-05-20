#!/usr/bin/env node

// create-run.js
// Creates a new lazy-dev run directory atomically. Single owner of the
// status.json schema and run-dir layout.
//
// Importable (MCP handlers) or runnable (CLI).
//
// CLI usage:
//   node src/orchestrator/create-run.js --brief "<text>"
//   node src/orchestrator/create-run.js --brief-file <path>
//
// Output: { ok, run_id, run_dir } or { ok: false, detail }.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../mcp/_io.js";
import { sanitiseBrief } from "../mcp/_validation.js";

function isGitRepo(dir) {
	try {
		execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: dir,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5_000,
		});
		return true;
	} catch {
		return false;
	}
}

// Core: pure function, used by MCP handler + CLI wrapper.
export function createRun({ brief, projectDir }) {
	const cleanBrief = sanitiseBrief(brief);
	const runId = generateRunId();
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	mkdirSync(runDir, { recursive: true });

	const needsGitInit = !isGitRepo(projectDir);
	const status = { run_id: runId, phase: "plan" };
	if (needsGitInit) status.needs_git_init = true;

	atomicWrite(join(runDir, "brief.md"), `${cleanBrief.trim()}\n`);
	atomicWrite(join(runDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);

	const result = { run_id: runId, run_dir: runDir };
	if (needsGitInit) {
		result.warning =
			"Project directory is not a git repository. The planner will prepend a git-init " +
			"scaffolding task so that worktrees work for subsequent tasks.";
	}
	return result;
}

function generateRunId() {
	const ts = new Date().toISOString().replace(/\..+$/, "Z").replace(/:/g, "-");
	const suffix = randomBytes(3).toString("hex");
	return `${ts}-${suffix}`;
}

// ── CLI entry ───────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const args = parseArgs(process.argv.slice(2));
	try {
		const brief = resolveBrief(args);
		if (!brief) {
			out({ ok: false, detail: "brief is required (--brief <text> or --brief-file <path>)" });
			process.exit(0);
		}
		const result = createRun({ brief, projectDir });
		out({ ok: true, ...result });
	} catch (err) {
		out({ ok: false, detail: err.message });
	}
}

function resolveBrief(args) {
	if (args.brief) return args.brief;
	if (args["brief-file"]) {
		if (!existsSync(args["brief-file"]))
			throw new Error(`brief-file not found: ${args["brief-file"]}`);
		return readFileSync(args["brief-file"], "utf8");
	}
	return null;
}

function parseArgs(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) throw new Error(`unexpected positional arg: ${a}`);
		const key = a.slice(2);
		const val = argv[++i];
		if (val === undefined || val.startsWith("--")) throw new Error(`missing value for --${key}`);
		o[key] = val;
	}
	return o;
}

function out(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}
