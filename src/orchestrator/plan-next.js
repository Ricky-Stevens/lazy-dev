#!/usr/bin/env node
// plan-next.js
//
// The wrangler's "what do I do next?" helper.
// Reads .lazy-dev/runs/<run-id>/ state and returns a single JSON action.
// May transition phase and perform internal side effects (merges, integration
// test); serialised via per-run advisory lock so concurrent calls can't
// double-advance state.
//
// Importable (MCP) or runnable (CLI).
//
// CLI:
//   node src/orchestrator/plan-next.js <run-id>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite, readJsonSafe } from "../mcp/_io.js";
import { withRunLock } from "../mcp/_lock.js";
import { requireSafeId } from "../mcp/_validation.js";
import { readUsage } from "../ralph/usage.js";
import { parsePerTaskVerdicts, parseReviewVerdict } from "../shared/parse-verdicts.js";
import { planIsSimple } from "./plan-gate.js";
import { integrationTestPhase, mergePhase } from "./plan-next-merge.js";
import { scheduleNext } from "./schedule.js";
import { readRunConfig } from "./settings.js";
import { validatePlan } from "./validate-plan.js";

const MAX_REVIEW_RETRIES = 1;

export function planNext({ runId, projectDir }) {
	requireSafeId(runId, "run_id");
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	if (!existsSync(runDir)) {
		return { phase: "error", action: "surface", detail: `run ${runId} not found at ${runDir}` };
	}
	return withRunLock(runDir, () => {
		const ctx = { runId, projectDir, runDir };
		ctx.status = readJsonSafe(join(runDir, "status.json")) || { phase: "plan" };

		switch (ctx.status.phase) {
			case "plan":
				return planPhase(ctx);
			case "approve":
				return approvePhase(ctx);
			case "specialists":
				return specialistsPhase(ctx);
			case "review":
				return reviewPhase(ctx);
			case "merge":
				return mergePhase(ctx, { loadTasks, advancePhase });
			case "integration_test":
				return integrationTestPhase(ctx, { advancePhase });
			case "done":
				return { phase: "done", action: "summarise" };
			case "cancelled":
				return { phase: "error", action: "surface", detail: "run was cancelled" };
			default:
				return {
					phase: "error",
					action: "surface",
					detail: `unknown phase: ${ctx.status.phase}`,
				};
		}
	});
}

// ── phase handlers ──────────────────────────────────────────────────────────

function planPhase(ctx) {
	const { runDir, runId, projectDir } = ctx;
	const masterSpec = join(runDir, "master-spec.md");
	const tasksJson = join(runDir, "tasks.json");
	if (!existsSync(masterSpec) || !existsSync(tasksJson)) {
		return { phase: "plan", action: "dispatch_planner" };
	}
	const plan = readJsonSafe(tasksJson);
	const cfg = readRunConfig(projectDir, runId);
	const result = validatePlan(plan, {
		forbiddenPathsGlobal: cfg.safety?.forbidden_paths_global || [],
	});
	if (!result.ok) {
		return {
			phase: "error",
			action: "surface",
			detail: `plan invalid: ${result.errors.join("; ")}`,
		};
	}
	const tasks = plan.tasks;

	if (planIsSimple(tasks, cfg)) {
		writeFileSync(
			join(runDir, "approval.md"),
			"Auto-approved (simple plan, no code-big, under threshold).\n",
		);
		advancePhase(ctx, "specialists");
		return specialistsPhase(ctx);
	}

	const summary = {
		run_id: runId,
		master_spec_path: masterSpec,
		tasks_json_path: tasksJson,
		task_count: tasks.length,
		tasks: tasks.map((t) => ({
			id: t.id,
			agent: t.agent,
			title: t.title,
			depends_on: t.depends_on || [],
			allowed_paths: t.scope?.allowed_paths || [],
		})),
	};
	advancePhase(ctx, "approve");
	return { phase: "approve", action: "show_gate", summary };
}

function approvePhase(ctx) {
	const { runDir } = ctx;
	if (existsSync(join(runDir, "approval.md"))) {
		advancePhase(ctx, "specialists");
		return specialistsPhase(ctx);
	}
	return { phase: "approve", action: "await_user" };
}

function specialistsPhase(ctx) {
	const { runId, projectDir } = ctx;
	const tasks = loadTasks(ctx);
	if (!tasks) return { phase: "error", action: "surface", detail: "no tasks found" };

	const cfg = readRunConfig(projectDir, runId);
	const statuses = buildStatuses(ctx, tasks);
	const maxParallel =
		Number(process.env.AGENT_WRANGLER_MAX_PARALLEL) || cfg.parallelism?.max_parallel || 3;

	const usage = readUsage(projectDir, runId);
	const runCap = cfg.budget?.per_run || {};
	if (runCap.max_input_tokens && usage.totals.input_tokens >= runCap.max_input_tokens) {
		return { phase: "error", action: "surface", detail: "per-run input-token cap reached" };
	}
	if (runCap.max_output_tokens && usage.totals.output_tokens >= runCap.max_output_tokens) {
		return { phase: "error", action: "surface", detail: "per-run output-token cap reached" };
	}

	let warning = null;
	const warnPct = cfg.budget?.warn_at_pct ?? 70;
	if (runCap.max_output_tokens) {
		const pct = (usage.totals.output_tokens / runCap.max_output_tokens) * 100;
		if (pct >= warnPct) warning = `output tokens at ${pct.toFixed(0)}% of per-run cap`;
	}

	const taskStatuses = tasks.map((t) => ({ id: t.id, status: statuses[t.id] }));
	const next = scheduleNext({ tasks, statuses, maxParallel });

	switch (next.kind) {
		case "dispatch":
			return {
				phase: "specialists",
				action: "dispatch",
				ids: next.ids,
				tasks: taskStatuses,
				warning,
			};
		case "wait":
			return {
				phase: "specialists",
				action: "wait",
				running: next.running,
				tasks: taskStatuses,
				warning,
			};
		case "blocked":
			return {
				phase: "specialists",
				action: "blocked",
				failed: next.failed,
				detail: next.detail || null,
				tasks: taskStatuses,
			};
		case "done_specialists":
			advancePhase(ctx, "review");
			return { phase: "review", action: "dispatch_reviewer", tasks: taskStatuses };
		default:
			return {
				phase: "error",
				action: "surface",
				detail: `unexpected scheduler result: ${next.kind}`,
			};
	}
}

function reviewPhase(ctx) {
	const { runDir, status } = ctx;
	const reviewPath = join(runDir, "review.md");
	if (!existsSync(reviewPath)) return { phase: "review", action: "dispatch_reviewer" };

	const md = readFileSync(reviewPath, "utf8");
	const verdict = parseReviewVerdict(md);
	const currentPass = Number(status.review_pass || 0);

	if (verdict === "PASS_ALL") {
		advancePhase(ctx, "merge");
		return { phase: "merge", action: "run_merge" };
	}

	if (verdict === "CHANGES_REQUESTED") {
		const perTask = parsePerTaskVerdicts(md);
		const needsRetry = Object.entries(perTask)
			.filter(([, v]) => v === "CHANGES_REQUESTED")
			.map(([id]) => id);

		if (currentPass >= MAX_REVIEW_RETRIES) {
			return {
				phase: "error",
				action: "surface",
				detail: `reviewer still requests changes after ${currentPass} retry pass(es); stopping. See review.md.`,
				tasks: needsRetry,
				review_path: reviewPath,
			};
		}

		bumpReviewPass(ctx);
		return {
			phase: "review",
			action: "auto_retry",
			tasks: needsRetry,
			review_path: reviewPath,
			pass: currentPass + 1,
		};
	}

	if (verdict === "BLOCK") {
		return { phase: "error", action: "surface", detail: "reviewer blocked the run; see review.md" };
	}

	return { phase: "error", action: "surface", detail: "could not parse reviewer verdict" };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function loadTasks(ctx) {
	const plan = readJsonSafe(join(ctx.runDir, "tasks.json"));
	return plan?.tasks || null;
}

function buildStatuses(ctx, tasks) {
	const out = {};
	for (const t of tasks) {
		out[t.id] = detectTaskStatus(ctx, t.id);
	}
	return out;
}

function detectTaskStatus(ctx, taskId) {
	const taskDir = join(ctx.runDir, "tasks", taskId);
	if (existsSync(join(taskDir, "RETRY"))) return "pending";
	if (existsSync(join(taskDir, "APPROVED"))) return "approved";
	if (existsSync(join(taskDir, "FAILED"))) return "failed";
	if (existsSync(join(taskDir, "envelope.json"))) return "running";
	return "pending";
}

function advancePhase(ctx, newPhase) {
	const statusPath = join(ctx.runDir, "status.json");
	const current = readJsonSafe(statusPath) || {};
	if (current.phase === newPhase) return;
	current.phase = newPhase;
	ctx.status = current;
	atomicWrite(statusPath, JSON.stringify(current, null, 2));
}

function bumpReviewPass(ctx) {
	const statusPath = join(ctx.runDir, "status.json");
	const current = readJsonSafe(statusPath) || {};
	current.review_pass = Number(current.review_pass || 0) + 1;
	ctx.status = current;
	atomicWrite(statusPath, JSON.stringify(current, null, 2));
}

// ── CLI entry ───────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const runId = process.argv[2];
	if (!runId) {
		process.stdout.write(
			`${JSON.stringify({ phase: "error", action: "surface", detail: "usage: plan-next.js <run-id>" })}\n`,
		);
		process.exit(0);
	}
	try {
		const result = planNext({ runId, projectDir });
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (err) {
		process.stdout.write(
			`${JSON.stringify({ phase: "error", action: "surface", detail: err.message })}\n`,
		);
	}
}
