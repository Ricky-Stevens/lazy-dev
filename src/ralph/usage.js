// usage.js
// Append-only token accounting per run.
//
// The gate calls recordUsage(projectDir, runId, entry) on every SubagentStop.
// The file `.lazy-dev/runs/<run-id>/usage.json` is rewritten atomically
// (read-merge-write under a lockfile) so concurrent gate hits don't race.

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const createEmpty = () => ({
	version: 1,
	run_id: null,
	by_agent: {},
	by_model: {},
	by_effort: {},
	by_iteration: [],
	totals: {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
	},
});

function emptyBucket() {
	return {
		calls: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
	};
}

function addToBucket(bucket, entry) {
	bucket.calls += 1;
	bucket.input_tokens += num(entry.input_tokens);
	bucket.output_tokens += num(entry.output_tokens);
	bucket.cache_read_tokens += num(entry.cache_read_tokens);
	bucket.cache_creation_tokens += num(entry.cache_creation_tokens);
}

export function recordUsage(projectDir, runId, entry) {
	if (!projectDir || !runId || !entry) return;
	const file = join(projectDir, ".lazy-dev", "runs", runId, "usage.json");
	mkdirSync(dirname(file), { recursive: true });
	const lock = `${file}.lock`;
	let fd = null;
	try {
		fd = acquire(lock, 2000);
		const data = existsSync(file) ? safeRead(file) : createEmpty();
		data.run_id = runId;

		const agent = entry.agent_type || "unknown";
		const model = entry.model_actual || entry.model_expected || "unknown";
		const effort = entry.effort_expected || "unset";

		if (!data.by_agent[agent]) data.by_agent[agent] = emptyBucket();
		addToBucket(data.by_agent[agent], entry);

		if (!data.by_model) data.by_model = {};
		if (!data.by_model[model]) data.by_model[model] = emptyBucket();
		addToBucket(data.by_model[model], entry);

		if (!data.by_effort) data.by_effort = {};
		if (!data.by_effort[effort]) data.by_effort[effort] = emptyBucket();
		addToBucket(data.by_effort[effort], entry);

		data.totals.input_tokens += num(entry.input_tokens);
		data.totals.output_tokens += num(entry.output_tokens);
		data.totals.cache_read_tokens += num(entry.cache_read_tokens);
		data.totals.cache_creation_tokens += num(entry.cache_creation_tokens);

		data.by_iteration.push({
			at: new Date().toISOString(),
			agent_id: entry.agent_id || null,
			agent_type: agent,
			task_id: entry.task_id || null,
			iteration: entry.iteration ?? null,
			input_tokens: num(entry.input_tokens),
			output_tokens: num(entry.output_tokens),
			cache_read_tokens: num(entry.cache_read_tokens),
			cache_creation_tokens: num(entry.cache_creation_tokens),
			model_actual: entry.model_actual || null,
			model_expected: entry.model_expected || null,
			effort_expected: entry.effort_expected || null,
			model_mismatch: entry.model_mismatch || false,
		});

		writeAtomic(file, JSON.stringify(data, null, 2));
	} finally {
		if (fd !== null) closeSync(fd);
		try {
			rmSync(lock, { force: true });
		} catch {}
	}
}

export function readUsage(projectDir, runId) {
	const file = join(projectDir, ".lazy-dev", "runs", runId, "usage.json");
	if (!existsSync(file)) return createEmpty();
	return safeRead(file);
}

// Extracts usage fields from a SubagentStop payload. Claude Code v2.1.x
// doesn't populate payload.usage — the authoritative source is the agent
// transcript JSONL. Kept for forward-compatibility if a future version adds
// the field; falls back to zeros so the caller can combine with transcript
// data without special-casing missing keys.
export function extractUsageFromPayload(payload) {
	if (!payload || typeof payload !== "object") return {};
	const u = payload.usage || payload.stop_usage || payload.token_usage || {};
	return {
		input_tokens: num(u.input_tokens ?? u.prompt_tokens),
		output_tokens: num(u.output_tokens ?? u.completion_tokens),
		cache_read_tokens: num(u.cache_read_input_tokens ?? u.cache_read_tokens),
		cache_creation_tokens: num(u.cache_creation_input_tokens ?? u.cache_creation_tokens),
	};
}

// Sums usage across every assistant entry in a Claude Code agent transcript
// (JSONL). Each assistant entry carries message.usage with the canonical
// field names. Returns zeros if the transcript is unreadable.
export function extractUsageFromTranscript(transcriptPath) {
	const totals = {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_creation_tokens: 0,
	};
	if (!transcriptPath || !existsSync(transcriptPath)) return totals;
	let content;
	try {
		content = readFileSync(transcriptPath, "utf8");
	} catch {
		return totals;
	}
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const u = entry?.message?.usage;
		if (!u || typeof u !== "object") continue;
		totals.input_tokens += num(u.input_tokens);
		totals.output_tokens += num(u.output_tokens);
		totals.cache_read_tokens += num(u.cache_read_input_tokens);
		totals.cache_creation_tokens += num(u.cache_creation_input_tokens);
	}
	return totals;
}

// ── helpers ──

function num(x) {
	const n = Number(x);
	return Number.isFinite(n) ? n : 0;
}

function safeRead(file) {
	try {
		const data = JSON.parse(readFileSync(file, "utf8"));
		if (typeof data !== "object" || data === null) return createEmpty();
		if (!data.by_agent) data.by_agent = {};
		if (!data.by_model) data.by_model = {};
		if (!data.by_effort) data.by_effort = {};
		if (!data.by_iteration) data.by_iteration = [];
		if (!data.totals)
			data.totals = {
				input_tokens: 0,
				output_tokens: 0,
				cache_read_tokens: 0,
				cache_creation_tokens: 0,
			};
		return data;
	} catch {
		return createEmpty();
	}
}

function writeAtomic(path, text) {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

const STALE_LOCK_MS = 5_000;

function acquire(lock, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let backoff = 2;
	while (Date.now() < deadline) {
		// Clear a stale lock if the holder has been silent > STALE_LOCK_MS.
		if (existsSync(lock)) {
			try {
				const mtime = statSync(lock).mtimeMs;
				if (Date.now() - mtime > STALE_LOCK_MS) {
					rmSync(lock, { force: true });
				}
			} catch {
				// Race on stat/unlink is fine — fall through and retry.
			}
		}
		try {
			return openSync(lock, "wx");
		} catch (e) {
			if (e.code !== "EEXIST") throw e; // unexpected error — don't spin
		}
		const jitter = 1 + Math.random() * 2;
		if (typeof Bun !== "undefined" && Bun.sleepSync) Bun.sleepSync(backoff * jitter);
		backoff = Math.min(backoff * 1.5, 50);
	}
	throw new Error(`usage lock contention: ${lock}`);
}
