// _paths.js
// Path construction helpers that enforce the trust boundary.
// Every handler that builds a path from user (LLM) input goes through guardPath.
// The guard: path.resolve(root, candidate) must start with path.resolve(root) + sep.
// Defeats `..` escapes, absolute-path override, symlink traversal.

import { resolve, sep } from "node:path";

export class PathError extends Error {
	constructor(message) {
		super(message);
		this.name = "PathError";
	}
}

// Returns the resolved absolute path if it's inside root, otherwise throws.
export function guardPath(root, candidate) {
	if (typeof root !== "string" || typeof candidate !== "string") {
		throw new PathError("guardPath requires string arguments");
	}
	const rootAbs = resolve(root);
	const candidateAbs = resolve(rootAbs, candidate);
	const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
	if (candidateAbs !== rootAbs && !candidateAbs.startsWith(rootPrefix)) {
		throw new PathError(`path escapes root: ${candidate} → ${candidateAbs}`);
	}
	return candidateAbs;
}

// Canonical run directory — built from validated run_id only.
export function resolveRunDir(projectDir, runId) {
	const runsRoot = resolve(projectDir, ".lazy-dev", "runs");
	return guardPath(runsRoot, runId);
}

// Canonical task directory for a given (runId, taskId).
export function resolveTaskDir(projectDir, runId, taskId) {
	const runDir = resolveRunDir(projectDir, runId);
	return guardPath(runDir, `tasks/${taskId}`);
}
