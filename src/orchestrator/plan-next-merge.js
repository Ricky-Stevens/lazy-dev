// plan-next-merge.js — merge and integration test phases for plan-next.
//
// Extracted from plan-next.js to keep file sizes manageable.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite, readJsonSafe, tail } from "../mcp/_io.js";
import { mergerPrepareLocked } from "./merge-conflicts.js";

export function mergePhase(ctx, { loadTasks, advancePhase }) {
	const { runDir, runId, projectDir } = ctx;
	const mergesDir = join(runDir, "merges");
	if (existsSync(mergesDir)) {
		const entries = readdirSync(mergesDir).filter((e) => {
			try {
				return statSync(join(mergesDir, e)).isDirectory();
			} catch {
				return false;
			}
		});
		for (const mid of entries) {
			const mdir = join(mergesDir, mid);
			if (existsSync(join(mdir, "FAILED"))) {
				return { phase: "error", action: "surface", detail: `merger failed for ${mid}` };
			}
			if (!existsSync(join(mdir, "APPROVED"))) {
				return { phase: "merge", action: "dispatch_merger", merge_id: mid };
			}
		}
	}

	const tasks = loadTasks(ctx) || [];
	const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || projectDir;
	const merged = [];
	for (const t of tasks) {
		if (!existsSync(join(runDir, "tasks", t.id, "APPROVED"))) continue;
		try {
			execFileSync(
				"bash",
				[join(pluginRoot, "src/orchestrator/worktree.sh"), "merge", runId, t.id],
				{
					cwd: projectDir,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 10 * 60_000,
					maxBuffer: 10 * 1024 * 1024,
				},
			);
			merged.push(t.id);
		} catch (err) {
			if (err.status === 3) {
				const conflictedFiles = (err.stdout || "")
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean);
				if (conflictedFiles.length === 0) {
					return {
						phase: "error",
						action: "surface",
						detail: `merge failed for ${t.id}: exit 3 but no conflict file list on stdout`,
					};
				}
				let prep;
				try {
					prep = mergerPrepareLocked({ runId, taskId: t.id, conflictedFiles, projectDir });
				} catch (prepErr) {
					return {
						phase: "error",
						action: "surface",
						detail: `mergerPrepare failed for ${t.id}: ${prepErr.message}`,
					};
				}
				return {
					phase: "merge",
					action: "dispatch_merger",
					merge_id: prep.merge_ids[0],
					task_id: t.id,
					pending_merges: prep.merge_ids,
				};
			}
			return {
				phase: "error",
				action: "surface",
				detail: `merge failed for ${t.id}: ${err.message}`,
			};
		}
	}

	advancePhase(ctx, "integration_test");
	return { phase: "integration_test", action: "run_integration_test", merged };
}

export function integrationTestPhase(ctx, { advancePhase }) {
	const { runDir, projectDir } = ctx;
	const cmd = detectTestCommand(projectDir);
	if (!cmd) {
		writeStatusField(runDir, "integration_test", {
			skipped: true,
			reason: "no test command detected",
		});
		advancePhase(ctx, "done");
		return { phase: "done", action: "summarise", integration_test: "skipped" };
	}
	const result = runTestCommand(cmd, projectDir);
	writeStatusField(runDir, "integration_test", result);
	if (result.passed) {
		advancePhase(ctx, "done");
		return {
			phase: "done",
			action: "summarise",
			integration_test: { command: cmd, passed: true },
		};
	}
	return {
		phase: "error",
		action: "surface",
		detail: `integration test failed: ${cmd} exited ${result.exit_code}`,
		integration_test: { command: cmd, passed: false, output_tail: result.output_tail },
	};
}

function detectTestCommand(dir) {
	const pkgPath = join(dir, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
			if (pkg?.scripts?.test) {
				if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")))
					return "bun test";
				if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm test";
				if (existsSync(join(dir, "yarn.lock"))) return "yarn test";
				return "npm test";
			}
		} catch {}
		if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun test";
	}
	if (existsSync(join(dir, "go.mod"))) return "go test ./...";
	if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "pytest.ini")))
		return "pytest";
	return null;
}

function runTestCommand(cmd, cwd) {
	const tokens = cmd.split(/\s+/).filter(Boolean);
	try {
		const out = execFileSync(tokens[0], tokens.slice(1), {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 15 * 60_000,
			maxBuffer: 20 * 1024 * 1024,
		});
		return { passed: true, exit_code: 0, output_tail: tail(out, 40) };
	} catch (err) {
		return {
			passed: false,
			exit_code: typeof err.status === "number" ? err.status : 1,
			output_tail: `${tail(err.stdout?.toString?.() || "", 20)}\n${tail(err.stderr?.toString?.() || "", 20)}`,
		};
	}
}

function writeStatusField(runDir, field, value) {
	const statusPath = join(runDir, "status.json");
	const current = readJsonSafe(statusPath) || {};
	current[field] = value;
	atomicWrite(statusPath, JSON.stringify(current, null, 2));
}
