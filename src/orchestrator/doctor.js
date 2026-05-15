#!/usr/bin/env node
// doctor.js
// One-shot run diagnostic. Dumps status.json, per-task state, gate log tail,
// usage totals, and unmerged branches.
//
// Importable (MCP) or runnable (CLI).
//
// CLI: node src/orchestrator/doctor.js [run-id]

import { execFileSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { readJsonSafe } from "../mcp/_io.js";
import { DOCTOR_MAX_TASKS, DOCTOR_OUTPUT_MAX_BYTES, requireSafeId } from "../mcp/_validation.js";

const PAYLOAD_PREVIEW_BYTES = 1024;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: diagnostic dump function with many reporting branches; splitting would obscure the sequential report structure
export function doctor({ runId, projectDir } = {}) {
	const pd = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const runsDir = join(pd, ".lazy-dev", "runs");
	const rid = runId || findMostRecentRun(runsDir);
	if (!rid) return `no runs found under ${runsDir}\n`;
	requireSafeId(rid, "run_id");

	const runDir = join(runsDir, rid);
	if (!existsSync(runDir)) return `run ${rid} not found at ${runDir}\n`;

	const lines = [];
	lines.push(`# lazy-dev:doctor — run ${rid}`);
	lines.push("");

	const status = readJsonSafe(join(runDir, "status.json"));
	if (status) {
		lines.push("## status.json");
		lines.push(`- phase: ${status.phase || "(unset)"}`);
		lines.push(`- review_pass: ${status.review_pass ?? 0}`);
		if (status.integration_test) {
			const it = status.integration_test;
			lines.push(
				`- integration_test: ${it.passed ? "PASS" : it.skipped ? "skipped" : `FAIL (exit ${it.exit_code})`}`,
			);
		}
		lines.push("");
	} else {
		lines.push("## status.json: missing or invalid");
		lines.push("");
	}

	const tasksDir = join(runDir, "tasks");
	if (existsSync(tasksDir)) {
		lines.push("## tasks");
		const taskIds = readdirSync(tasksDir).sort().slice(0, DOCTOR_MAX_TASKS);
		for (const tid of taskIds) {
			const td = join(tasksDir, tid);
			const marks = [];
			if (existsSync(join(td, "APPROVED"))) marks.push("APPROVED");
			let failReason = null;
			if (existsSync(join(td, "FAILED"))) {
				marks.push("FAILED");
				const failData = readJsonSafe(join(td, "FAILED"));
				failReason = failData?.reason || null;
			}
			if (existsSync(join(td, "RETRY"))) marks.push("RETRY");
			if (existsSync(join(td, "envelope.json"))) marks.push("envelope");
			const state = readJsonSafe(join(td, "state.json"));
			const iter = state?.iteration ?? "—";
			const lastFail = state?.history?.length
				? state.history[state.history.length - 1]?.failing_signature || "—"
				: "—";
			const diffNote = existsSync(join(td, "diff.patch"))
				? `${statSync(join(td, "diff.patch")).size}B`
				: "n/a";
			const wall = formatWallClock(state?.dispatched_at, state?.completed_at);
			const reasonSuffix = failReason ? ` reason=${failReason}` : "";
			lines.push(
				`- ${tid}: [${marks.join(", ") || "—"}] iter=${iter} diff=${diffNote} failing=${lastFail} wall=${wall}${reasonSuffix}`,
			);
		}
		lines.push("");
	}

	const gateLog = join(runsDir, "_gate-log", "gate-debug.log");
	if (existsSync(gateLog)) {
		lines.push("## gate-debug.log (last 20 lines)");
		const content = readFileSync(gateLog, "utf8");
		lines.push("```");
		lines.push(...content.split("\n").filter(Boolean).slice(-20));
		lines.push("```");
		lines.push("");
	}

	const gateLogDir = join(runsDir, "_gate-log");
	if (existsSync(gateLogDir)) {
		const payloads = readdirSync(gateLogDir)
			.filter((f) => f.endsWith(".payload.json"))
			.sort()
			.slice(-3);
		if (payloads.length) {
			lines.push("## recent gate payloads");
			for (const p of payloads) {
				const filePath = join(gateLogDir, p);
				const fd = openSync(filePath, "r");
				const buf = Buffer.alloc(PAYLOAD_PREVIEW_BYTES);
				const bytesRead = readSync(fd, buf, 0, PAYLOAD_PREVIEW_BYTES, 0);
				closeSync(fd);
				const raw = buf.toString("utf8", 0, bytesRead).trim();
				const short = bytesRead >= PAYLOAD_PREVIEW_BYTES ? `${raw}…` : raw;
				lines.push(`- ${p}`);
				lines.push(`  ${short}`);
			}
			lines.push("");
		}
	}

	const usage = readJsonSafe(join(runDir, "usage.json"));
	if (usage?.totals) {
		lines.push("## usage totals");
		lines.push(
			`- tokens: input=${usage.totals.input_tokens} output=${usage.totals.output_tokens} cache_read=${usage.totals.cache_read_tokens} cache_create=${usage.totals.cache_creation_tokens}`,
		);

		if (usage.by_agent && Object.keys(usage.by_agent).length) {
			lines.push("");
			lines.push("### by agent (calls / in / out / cache-read)");
			for (const [agent, a] of Object.entries(usage.by_agent)) {
				const bare = agent.startsWith("lazy-dev:") ? agent.slice("lazy-dev:".length) : agent;
				const modelEffort = lookupAgentModelEffort(usage, bare);
				lines.push(
					`- ${agent} [${modelEffort}]: calls=${a.calls} in=${a.input_tokens} out=${a.output_tokens} cache_read=${a.cache_read_tokens}`,
				);
			}
		}

		if (usage.by_model && Object.keys(usage.by_model).length) {
			lines.push("");
			lines.push("### by model (spend grouped across agents)");
			for (const [model, m] of Object.entries(usage.by_model)) {
				lines.push(
					`- ${model}: calls=${m.calls} in=${m.input_tokens} out=${m.output_tokens} cache_read=${m.cache_read_tokens}`,
				);
			}
		}

		if (usage.by_effort && Object.keys(usage.by_effort).length) {
			lines.push("");
			lines.push("### by effort (effort_expected; effort_actual not recoverable from transcript)");
			for (const [effort, e] of Object.entries(usage.by_effort)) {
				lines.push(
					`- ${effort}: calls=${e.calls} in=${e.input_tokens} out=${e.output_tokens} cache_read=${e.cache_read_tokens}`,
				);
			}
		}

		const mismatches = (usage.by_iteration || []).filter((it) => it.model_mismatch);
		if (mismatches.length) {
			lines.push("");
			lines.push("### MODEL MISMATCHES (declared vs actual)");
			for (const m of mismatches) {
				lines.push(
					`- ${m.agent_type} task=${m.task_id || "(per-run)"} expected=${m.model_expected} actual=${m.model_actual}`,
				);
			}
		}

		lines.push("");
	}

	lines.push("## branches");
	try {
		const branches = execFileSync("git", ["-C", pd, "branch", "-a", "--no-color"], {
			encoding: "utf8",
			timeout: 10_000,
		});
		const lazyBranches = branches
			.split("\n")
			// Strip git's prefix markers: `*` (current), `+` (checked out in worktree),
			// plus leading/trailing whitespace.
			.map((b) => b.replace(/^\s*[*+]?\s*/, "").trim())
			.filter((b) => b.startsWith(`lazy-dev/${rid}/`));
		if (lazyBranches.length === 0) {
			lines.push("- (no lazy-dev branches for this run)");
		} else {
			for (const b of lazyBranches) {
				let ancestor = false;
				try {
					execFileSync("git", ["-C", pd, "merge-base", "--is-ancestor", b, "HEAD"], {
						stdio: ["ignore", "ignore", "ignore"],
						timeout: 5_000,
					});
					ancestor = true;
				} catch {}
				lines.push(`- ${b} ${ancestor ? "(merged)" : "(UNMERGED)"}`);
			}
		}
	} catch (err) {
		lines.push(`- (git unavailable: ${err.message})`);
	}
	lines.push("");

	let report = `${lines.join("\n")}\n`;
	if (Buffer.byteLength(report, "utf8") > DOCTOR_OUTPUT_MAX_BYTES) {
		report = `${report.slice(0, DOCTOR_OUTPUT_MAX_BYTES)}\n\n[… truncated at ${DOCTOR_OUTPUT_MAX_BYTES} bytes]\n`;
	}
	return report;
}

function findMostRecentRun(runsDir) {
	if (!existsSync(runsDir)) return null;
	const entries = readdirSync(runsDir)
		.filter((e) => !e.startsWith("_"))
		.map((e) => ({ e, mt: statSync(join(runsDir, e)).mtimeMs }))
		.sort((a, b) => b.mt - a.mt);
	return entries[0]?.e || null;
}

// Find a recent iteration entry for this agent, pull the observed model +
// declared effort. Used to decorate the by-agent lines with right-sizing data.
function lookupAgentModelEffort(usage, bareAgentName) {
	const qualified = `lazy-dev:${bareAgentName}`;
	const hit = (usage.by_iteration || []).find(
		(e) => e.agent_type === qualified || e.agent_type === bareAgentName,
	);
	const model = hit?.model_actual || hit?.model_expected || "?";
	const effort = hit?.effort_expected || "?";
	return `${model} / effort=${effort}`;
}

function formatWallClock(dispatchedAt, completedAt) {
	if (!dispatchedAt || !completedAt) return "—";
	const a = Date.parse(dispatchedAt);
	const b = Date.parse(completedAt);
	if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return "—";
	const secs = Math.round((b - a) / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const rem = secs % 60;
	return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

// ── CLI entry ───────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
	const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const runId = process.argv[2] || undefined;
	try {
		process.stdout.write(doctor({ runId, projectDir }));
	} catch (err) {
		process.stdout.write(`doctor failed: ${err.message}\n`);
	}
}
