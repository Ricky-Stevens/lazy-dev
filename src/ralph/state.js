// state.js
// Reads and writes per-task iteration state under
//   <project>/.lazy-dev/runs/<run-id>/tasks/<task-id>/
//
// Keyed by task-id (not agent-id). The gate resolves task-id from the
// worktree cwd path — no _pending directory dance needed.

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
import { join } from "node:path";

export class StateStore {
	constructor({ projectDir, runId, taskId, kind = "task" }) {
		if (!projectDir) throw new Error("projectDir required");
		if (!runId) throw new Error("runId required");
		if (!taskId) throw new Error("taskId required");
		this.projectDir = projectDir;
		this.runId = runId;
		this.taskId = taskId;
		this.kind = kind;
		const bucket = kind === "merge" ? "merges" : "tasks";
		this.taskDir = join(projectDir, ".lazy-dev", "runs", runId, bucket, taskId);
		mkdirSync(this.taskDir, { recursive: true });
	}

	get stateFile() {
		return join(this.taskDir, "state.json");
	}
	get approvedMarker() {
		return join(this.taskDir, "APPROVED");
	}
	get failedMarker() {
		return join(this.taskDir, "FAILED");
	}

	load() {
		if (!existsSync(this.stateFile)) {
			// Seed dispatched_at from the envelope if available — otherwise the
			// envelope was written (e.g. dispatch.js) but we're here on the first
			// SubagentStop. completed_at gets written per-iteration by recordIteration.
			const envPath = join(this.taskDir, "envelope.json");
			let dispatchedAt = null;
			if (existsSync(envPath)) {
				try {
					const env = JSON.parse(readFileSync(envPath, "utf8"));
					dispatchedAt = env.dispatched_at || null;
				} catch {}
			}
			return {
				task_id: this.taskId,
				run_id: this.runId,
				iteration: 0,
				history: [],
				dispatched_at: dispatchedAt,
				started_at: new Date().toISOString(),
			};
		}
		let raw;
		try {
			raw = readFileSync(this.stateFile, "utf8");
			return JSON.parse(raw);
		} catch {
			const corrupt = `${this.stateFile}.corrupt-${Date.now()}`;
			try {
				writeFileSync(corrupt, raw ?? "");
			} catch {}
			return {
				task_id: this.taskId,
				run_id: this.runId,
				iteration: 0,
				history: [],
				started_at: new Date().toISOString(),
				recovered_from_corrupt: corrupt,
			};
		}
	}

	save(state) {
		const lock = `${this.stateFile}.lock`;
		let fd = null;
		const deadline = Date.now() + 3000;
		let backoff = 2;
		while (Date.now() < deadline) {
			try {
				fd = openSync(lock, "wx");
				break;
			} catch (e) {
				if (e.code !== "EEXIST") throw e;
				// Detect stale lock: if the lock file is older than 5 seconds,
				// the writer that created it likely crashed without cleanup.
				try {
					const lockStat = statSync(lock);
					if (Date.now() - lockStat.mtimeMs > 5000) {
						rmSync(lock, { force: true });
						continue;
					}
				} catch {
					// Lock was deleted between the EEXIST and stat — retry immediately.
					continue;
				}
				const jitter = 1 + Math.random() * 2;
				if (typeof Bun !== "undefined" && Bun.sleepSync) Bun.sleepSync(backoff * jitter);
				backoff = Math.min(backoff * 1.5, 50);
			}
		}
		if (fd === null) throw new Error(`state lock contention: ${lock}`);
		try {
			const tmp = `${this.stateFile}.tmp`;
			writeFileSync(tmp, JSON.stringify(state, null, 2));
			renameSync(tmp, this.stateFile);
		} finally {
			closeSync(fd);
			try {
				rmSync(lock, { force: true });
			} catch {}
		}
	}

	recordIteration({
		iteration,
		sentinelKind,
		sentinelBody,
		verifierResults,
		diffHash,
		failingSignature,
		notes,
	}) {
		const s = this.load();
		s.iteration = iteration;
		const now = new Date().toISOString();
		s.history.push({
			iteration,
			at: now,
			sentinel_kind: sentinelKind,
			sentinel_summary: sentinelBody?.summary ?? null,
			verifier_results: verifierResults,
			diff_hash: diffHash,
			failing_signature: failingSignature,
			notes: notes ?? null,
		});
		// Mark completed_at on the final (approving/failing) iteration — keep it
		// simple: always update. The state file is overwritten each call, so
		// completed_at reflects the most recent sentinel event.
		s.completed_at = now;
		this.save(s);
		return s;
	}

	markApproved(sentinelBody) {
		writeFileSync(
			this.approvedMarker,
			JSON.stringify(
				{
					at: new Date().toISOString(),
					sentinel: sentinelBody,
				},
				null,
				2,
			),
		);
	}

	markFailed(reason, details = {}) {
		writeFileSync(
			this.failedMarker,
			JSON.stringify(
				{
					at: new Date().toISOString(),
					reason,
					details,
				},
				null,
				2,
			),
		);
	}
}
