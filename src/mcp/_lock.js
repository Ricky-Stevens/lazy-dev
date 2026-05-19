// _lock.js
// Per-run advisory lock. Writer tools acquire before mutating; readers don't.
// Rationale: the SubagentStop hook writes APPROVED/FAILED markers independently
// of the MCP server. Writer tools that read marker state and then act on it
// (e.g. plan_advance merging approved tasks) need mutual exclusion against
// other writers, not against the hook — the hook writes fast and is idempotent,
// and the writer always re-reads marker state inside the lock before deciding.

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STALE_LOCK_MS = 120_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 180_000;

export class LockError extends Error {
	constructor(message) {
		super(message);
		this.name = "LockError";
	}
}

function lockPath(runDir) {
	return join(runDir, ".lock");
}

// Acquire the run's advisory lock. Blocks up to LOCK_MAX_WAIT_MS.
// Returns a release function. Use in a try/finally.
export function acquireRunLock(runDir) {
	mkdirSync(runDir, { recursive: true });
	const path = lockPath(runDir);
	const deadline = Date.now() + LOCK_MAX_WAIT_MS;

	while (Date.now() < deadline) {
		// Clear a stale lock if the holder has been silent > STALE_LOCK_MS.
		if (existsSync(path)) {
			try {
				const mtime = statSync(path).mtimeMs;
				if (Date.now() - mtime > STALE_LOCK_MS) {
					rmSync(path, { force: true });
				}
			} catch {
				// Race on stat/unlink is fine — fall through and retry.
			}
		}

		if (!existsSync(path)) {
			try {
				// wx flag fails if file exists — atomic create.
				writeFileSync(path, `${process.pid} ${Date.now()}\n`, { flag: "wx" });
				return () => {
					try {
						rmSync(path, { force: true });
					} catch {
						// Release is best-effort; stale-check will clean on next acquire.
					}
				};
			} catch {
				// Lost the race; loop and retry.
			}
		}

		// Yield between acquire attempts. Use Bun.sleepSync when available;
		// fall back to a busy-spin only outside Bun (e.g. plain Node test runners).
		if (typeof Bun !== "undefined" && Bun.sleepSync) {
			Bun.sleepSync(LOCK_RETRY_MS);
		} else {
			const until = Date.now() + LOCK_RETRY_MS;
			while (Date.now() < until) {
				// busy-spin fallback for non-Bun environments
			}
		}
	}

	throw new LockError(`timed out waiting for run lock at ${path}`);
}

// Scope helper: runs fn with the lock held, releases regardless of outcome.
export function withRunLock(runDir, fn) {
	const release = acquireRunLock(runDir);
	try {
		return fn();
	} finally {
		release();
	}
}
