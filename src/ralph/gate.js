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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildRetryPrompt, emitRetry, logDebug, readEnvelope, readStdinJson } from "./gate-io.js";
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
	try {
		const log = `${process.env.CLAUDE_PROJECT_DIR || process.cwd()}/.lazy-dev/runs/_gate-log/gate-crash.log`;
		mkdirSync(dirname(log), { recursive: true });
		writeFileSync(log, `${new Date().toISOString()} FATAL: ${err.stack || err.message}\n`, {
			flag: "a",
		});
	} catch (e) {
		console.error(`gate crash (log write failed): ${err.message} (${e.message})`);
	}
	process.exit(0);
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

	const bareAgentName = agentType.slice("lazy-dev:".length);
	const isPerRun = isPerRunAgent(bareAgentName);
	const sentinel = parseSentinel(lastMsg);
	const log = (msg) => logDebug(projectDir, msg);

	const resolved = isPerRun
		? null
		: resolveFromSentinel(projectDir, sentinel) || resolveTaskFromCwd(projectDir, payloadCwd);

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

	// 2. AUTO-COMMIT FALLBACK
	autoCommit(projectDir, runId, taskId, log);

	// 3. SCOPE + DIFF HASH
	const gitBaseRef = resolveBaseRef(worktree, envelope);
	const allowedPaths = envelope?.scope?.allowed_paths || [];
	const { diffHash, violation } = checkScope(worktree, gitBaseRef, allowedPaths);

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

	// 4. VERIFIERS
	const verifierResults = runVerifiers({
		criteria: envelope?.completion_criteria || [],
		cwd: worktree,
		scopeAllowedPaths: allowedPaths,
		gitBaseRef,
		projectDir,
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

	// 7. RETRY
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

function autoCommit(projectDir, runId, taskId, log) {
	try {
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
