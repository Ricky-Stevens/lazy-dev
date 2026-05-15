#!/usr/bin/env node
// gate.js — the Ralph gate algorithm.
//
// Called via hooks/ralph-gate.sh (bash wrapper) on SubagentStop. Receives
// the hook payload JSON on stdin.
//
// Task resolution: sentinel-first — extracts run-id and task-id from the
// sentinel body (task_id field), with cwd path parsing as a fallback.
//
// Hook decision contract:
//   - exit 0 with empty stdout → subagent exits cleanly (APPROVE/FAIL)
//   - stdout JSON → retry prompt for the subagent
//   - never exits non-zero

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	buildRetryPrompt,
	emitRetry,
	logDebug,
	logPayload,
	readEnvelope,
	readStdinJson,
} from "./gate-io.js";
import {
	checkScope,
	deriveWorktreePath,
	findMostRecentRun,
	resolveBaseRef,
	resolveFromSentinel,
	resolveTaskFromCwd,
} from "./gate-resolve.js";
import { recordAgentUsage, updateUsageIteration } from "./gate-telemetry.js";
import { cheapHash } from "./hash.js";
import { parseSentinel } from "./parse-sentinel.js";
import { StateStore } from "./state.js";
import { runVerifiers } from "./verify.js";

const DEFAULTS = {
	max_iter: 3,
	same_diff_twice: "stop",
	same_failure_twice: "stop",
};

const MAX_ITER_HARD_CAP = 10;

// Per-run agents (planner, reviewer, wrangler) produce run-level artefacts,
// not per-task work. Short-circuit so their SubagentStop events don't try to
// resolve a task_id and end up mis-attributed.
const PER_RUN_AGENT_PREFIXES = ["planner", "reviewer", "wrangler"];

function isPerRunAgent(bareName) {
	return PER_RUN_AGENT_PREFIXES.some((p) => bareName === p || bareName.startsWith(`${p}-`));
}

main().catch((err) => {
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	try {
		const log = `${projectDir}/.lazy-dev/runs/_gate-log/gate-crash.log`;
		mkdirSync(dirname(log), { recursive: true });
		writeFileSync(log, `${new Date().toISOString()} FATAL: ${err.stack || err.message}\n`, {
			flag: "a",
		});
	} catch (e) {
		console.error(`gate crash (log write failed): ${err.message} (${e.message})`);
	}

	// Write a FAILED marker if we can resolve the task — prevents the state
	// machine from seeing the task as "running" forever after a gate crash.
	try {
		const resolved = globalThis.__gateResolved;
		if (resolved?.runId && resolved?.taskId) {
			const state = new StateStore({
				projectDir,
				runId: resolved.runId,
				taskId: resolved.taskId,
				kind: "task",
			});
			state.markFailed("gate_crash", {
				error: err.message,
				stack: err.stack?.split("\n").slice(0, 5).join("\n"),
			});
		}
	} catch {
		// Best-effort — if this also fails, the crash log is the only trace.
	}

	process.exit(1);
});

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: gate orchestration requires branching on many sentinel/verifier states; splitting would obscure the sequential decision logic
async function main() {
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const payload = await readStdinJson(projectDir);
	if (!payload) return;

	const agentType = payload.agent_type || "";
	const agentId = payload.agent_id || "";
	const lastMsg = payload.last_assistant_message || "";
	const payloadCwd = payload.cwd || projectDir;

	if (!agentType.startsWith("lazy-dev:")) return;

	// Only log payloads for lazy-dev agents — avoids disk I/O on every
	// non-lazy-dev SubagentStop in the project.
	logPayload(projectDir, payload);

	const bareAgentName = agentType.slice("lazy-dev:".length);
	const isPerRun = isPerRunAgent(bareAgentName);
	const sentinel = parseSentinel(lastMsg);
	const log = (msg) => logDebug(projectDir, msg);

	const resolved = isPerRun
		? null
		: resolveFromSentinel(projectDir, sentinel) || resolveTaskFromCwd(projectDir, payloadCwd);

	// Stash for the crash handler so it can write a FAILED marker on unhandled errors.
	globalThis.__gateResolved = resolved;

	const usageRunId = isPerRun ? findMostRecentRun(projectDir) : resolved?.runId || null;

	if (usageRunId) {
		recordAgentUsage({
			projectDir,
			runId: usageRunId,
			agentId,
			agentType,
			bareAgentName,
			taskId: isPerRun ? null : (resolved?.taskId ?? null),
			iteration: 0,
			transcriptPath: payload.agent_transcript_path,
			payload,
			logDebug: log,
		});
	}

	if (isPerRun) {
		if (usageRunId) {
			const retryMsg = verifyPerRunOutput(projectDir, usageRunId, bareAgentName, log);
			if (retryMsg) return emitRetry(retryMsg);
		}
		log(`per-run agent ${agentType}; usage recorded, no task-level gate work`);
		return;
	}
	if (!resolved) {
		log(`could not resolve task for ${agentType} (cwd=${payloadCwd}); approving`);
		return;
	}
	const { runId, taskId } = resolved;

	const envelopePath = locateEnvelope(projectDir, runId, taskId);
	if (!envelopePath) {
		log(`envelope missing for ${agentType} task=${taskId}; approving`);
		return;
	}
	const envelope = readEnvelope(envelopePath.path);
	const kind = envelopePath.kind;

	const worktree =
		envelope?.worktree_path || deriveWorktreePath(projectDir, runId, taskId) || payloadCwd;
	const budget = { ...DEFAULTS, ...(envelope?.budget || {}) };
	budget.max_iter = Math.min(budget.max_iter, MAX_ITER_HARD_CAP);
	const policy = { ...DEFAULTS, ...(envelope?.no_change_policy || {}) };

	const state = new StateStore({ projectDir, runId, taskId, kind });

	// If a previous iteration wrote a "verifier_retry_pending" FAILED marker
	// (the gate emitted a retry prompt), clear it — the agent DID resume
	// since we're processing another SubagentStop event.
	clearRetryPendingFailure(state);

	const prev = state.load();
	const iteration = (prev.iteration || 0) + 1;
	updateUsageIteration(projectDir, runId, agentId, iteration);

	// 1. SENTINEL
	if (sentinel.kind === "blocked") {
		state.recordIteration({
			iteration,
			sentinelKind: "blocked",
			sentinelBody: null,
			verifierResults: [],
			diffHash: null,
			failingSignature: null,
			notes: sentinel.reason,
		});
		state.markFailed("specialist_blocked", { reason: sentinel.reason, iteration });
		return;
	}

	if (sentinel.kind !== "completed") {
		state.recordIteration({
			iteration,
			sentinelKind: sentinel.kind,
			sentinelBody: null,
			verifierResults: [],
			diffHash: null,
			failingSignature: sentinel.detail,
			notes: sentinel.detail,
		});
		if (iteration >= budget.max_iter) {
			state.markFailed("max_iter_without_sentinel", { detail: sentinel.detail, iteration });
			return;
		}
		return emitRetry(
			`Your final message did not contain a valid ---COMPLETED---{...json...}---END--- block.\nProblem: ${sentinel.detail}\n\nEnd your next message with the sentinel exactly as specified in your system prompt. You still need to do the work — this is iteration ${iteration} of ${budget.max_iter}.`,
		);
	}

	// 1b. TASK_ID — required for task-level agents so the gate resolves the envelope.
	if (!sentinel.body?.task_id) {
		if (iteration >= budget.max_iter) {
			state.markFailed("missing_task_id", { iteration });
			return;
		}
		return emitRetry(
			"Your sentinel is missing `task_id`. Include it in the JSON body: " +
				`{ "task_id": "${taskId}", "summary": "..." }. This is iteration ${iteration} of ${budget.max_iter}.`,
		);
	}

	// 2. AUTO-COMMIT FALLBACK
	autoCommit(projectDir, runId, taskId, worktree, log);

	// 3. SCOPE + DIFF HASH
	const gitBaseRef = resolveBaseRef(worktree, envelope);
	const allowedPaths = envelope?.scope?.allowed_paths || [];
	const scopeResult = checkScope(worktree, gitBaseRef, allowedPaths);
	const { diffHash, violation } = scopeResult;

	if (scopeResult.error) {
		log(`scope check error: ${scopeResult.error}`);
	}

	if (violation) {
		state.recordIteration({
			iteration,
			sentinelKind: "completed",
			sentinelBody: sentinel.body,
			verifierResults: [],
			diffHash,
			failingSignature: null,
			notes: `scope violation: ${violation.join(", ")}`,
		});
		state.markFailed("out_of_scope", { iteration, files: violation });
		return;
	}

	// 4. VERIFIERS — pass precomputed diff data to avoid a redundant git-diff call
	const verifierResults = runVerifiers({
		criteria: envelope?.completion_criteria || [],
		cwd: worktree,
		scopeAllowedPaths: allowedPaths,
		gitBaseRef,
		projectDir,
		precomputedDiff: scopeResult._changedFiles,
	});

	const failing = verifierResults.filter((r) => !r.passed);
	const failingSignature = failing.length
		? cheapHash(failing.map((r) => `${r.id}:${r.failure_signature || ""}`).join("|"))
		: null;

	// 5. CIRCUIT BREAKERS
	state.recordIteration({
		iteration,
		sentinelKind: "completed",
		sentinelBody: sentinel.body,
		verifierResults,
		diffHash,
		failingSignature,
	});

	// Reload after recordIteration so we compare against the persisted history,
	// not the stale pre-write snapshot. The entry immediately before the one just
	// written is at index [length - 2].
	const post = state.load();

	if (iteration >= 2) {
		const last = post.history[post.history.length - 2];
		if (policy.same_diff_twice === "stop" && last?.diff_hash && last.diff_hash === diffHash) {
			state.markFailed("oscillation_same_diff", { iteration, diff_hash: diffHash });
			return;
		}
		if (
			policy.same_failure_twice === "stop" &&
			failingSignature &&
			last?.failing_signature === failingSignature
		) {
			state.markFailed("oscillation_same_failure", {
				iteration,
				failing: failing.map((f) => f.id),
			});
			return;
		}
	}

	// 6. DECISION
	if (failing.length === 0) {
		state.markApproved(sentinel.body);
		return;
	}
	if (iteration >= budget.max_iter) {
		state.markFailed("max_iter_reached", { iteration, failing: failing.map((f) => f.id) });
		return;
	}

	// 7. RETRY — write a provisional FAILED marker so the state machine can
	// detect orphaned tasks if the retry prompt is never delivered.
	state.markFailed("verifier_retry_pending", {
		iteration,
		failing: failing.map((f) => f.id),
	});
	return emitRetry(buildRetryPrompt(verifierResults, iteration, budget.max_iter));
}

// ── inline helpers ─────────────────────────────────────────────────────────

function locateEnvelope(projectDir, runId, taskId) {
	const taskPath = join(projectDir, ".lazy-dev", "runs", runId, "tasks", taskId, "envelope.json");
	if (existsSync(taskPath)) return { path: taskPath, kind: "task" };
	const mergePath = join(projectDir, ".lazy-dev", "runs", runId, "merges", taskId, "envelope.json");
	if (existsSync(mergePath)) return { path: mergePath, kind: "merge" };
	return null;
}

const PER_RUN_MAX_RETRIES = 2;

function verifyPerRunOutput(projectDir, runId, bareAgentName, log) {
	const runDir = join(projectDir, ".lazy-dev", "runs", runId);
	let missing = null;

	if (bareAgentName === "planner" || bareAgentName.startsWith("planner-")) {
		const need = [];
		if (!existsSync(join(runDir, "master-spec.md"))) need.push("master-spec.md");
		if (!existsSync(join(runDir, "tasks.json"))) need.push("tasks.json");
		if (need.length) missing = need;
	} else if (bareAgentName === "reviewer" || bareAgentName.startsWith("reviewer-")) {
		if (!existsSync(join(runDir, "review.md"))) missing = ["review.md"];
	}

	if (!missing) return null;

	const counterPath = join(runDir, `.${bareAgentName}-retries`);
	let count = 0;
	try {
		count = parseInt(readFileSync(counterPath, "utf8").trim(), 10) || 0;
	} catch {}

	if (count >= PER_RUN_MAX_RETRIES) {
		log(`per-run ${bareAgentName} output missing after ${count} retries; letting through`);
		return null;
	}
	writeFileSync(counterPath, String(count + 1));

	const list = missing.join(" and ");
	return (
		`You completed but ${list} not found in ${runDir}. ` +
		`You MUST use the Write tool to persist ${missing.length > 1 ? "these files" : "this file"}. ` +
		`Do not output file content in your response text — call the Write tool directly.`
	);
}

function clearRetryPendingFailure(state) {
	if (!existsSync(state.failedMarker)) return;
	try {
		const raw = readFileSync(state.failedMarker, "utf8");
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			// Corrupt marker — remove it so the task isn't permanently stuck.
			rmSync(state.failedMarker, { force: true });
			return;
		}
		if (data.reason === "verifier_retry_pending") {
			rmSync(state.failedMarker);
		}
	} catch {
		// File disappeared between check and read — harmless.
	}
}

function autoCommit(projectDir, runId, taskId, worktree, log) {
	try {
		// Quick check: if git status is clean, skip the subprocess entirely.
		// This is the common case — specialists almost always commit.
		const statusOut = execFileSync("git", ["status", "--porcelain"], {
			cwd: worktree,
			encoding: "utf8",
			timeout: 10_000,
		}).trim();
		if (!statusOut) return;

		const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || projectDir;
		const commitOut = execFileSync(
			"bash",
			[
				join(pluginRoot, "src/orchestrator/worktree.sh"),
				"commit",
				runId,
				taskId,
				`${taskId}: auto-commit at gate (specialist forgot to commit)`,
			],
			{ cwd: projectDir, encoding: "utf8", timeout: 30_000 },
		).trim();
		if (commitOut === "committed") {
			log(`WARN auto-committed for task=${taskId} — specialist skipped commit step`);
		}
	} catch (err) {
		log(`auto-commit skipped for ${taskId}: ${err.message}`);
	}
}
