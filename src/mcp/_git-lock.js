// _git-lock.js
// Project-level advisory lock for git operations that modify the main worktree
// (dep merges, branch operations). Separate from the per-run lock because git
// operations cross run boundaries — two concurrent dispatches from different
// runs must not merge into the main worktree simultaneously.

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STALE_LOCK_MS = 120_000;
const LOCK_RETRY_MS = 100;
const LOCK_MAX_WAIT_MS = 180_000;

function gitLockPath(projectDir) {
	return join(projectDir, ".lazy-dev", ".git-lock");
}

export function withGitLock(projectDir, fn) {
	const path = gitLockPath(projectDir);
	mkdirSync(join(projectDir, ".lazy-dev"), { recursive: true });
	const deadline = Date.now() + LOCK_MAX_WAIT_MS;

	while (Date.now() < deadline) {
		if (existsSync(path)) {
			try {
				const mtime = statSync(path).mtimeMs;
				if (Date.now() - mtime > STALE_LOCK_MS) {
					rmSync(path, { force: true });
				}
			} catch {
				continue;
			}
		}

		if (!existsSync(path)) {
			try {
				writeFileSync(path, `${process.pid} ${Date.now()}\n`, { flag: "wx" });
				try {
					return fn();
				} finally {
					try {
						rmSync(path, { force: true });
					} catch {}
				}
			} catch {
				// Lost the race; retry.
			}
		}

		if (typeof Bun !== "undefined" && Bun.sleepSync) {
			Bun.sleepSync(LOCK_RETRY_MS);
		} else {
			const until = Date.now() + LOCK_RETRY_MS;
			while (Date.now() < until) {}
		}
	}

	throw new Error(`timed out waiting for git lock at ${path}`);
}
