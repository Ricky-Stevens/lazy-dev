// settings.js
// Resolves the effective lazy-dev config by merging, in precedence order:
//   1. Plug-in defaults         (this file)
//   2. User global               (~/.claude/settings.json :: lazy-dev)
//   3. Project                   (<project>/.claude/settings.json :: lazy-dev
//                                 AND <project>/.lazy-dev/settings.json)
//   4. Per-run overrides         (<project>/.lazy-dev/runs/<run-id>/config.json
//                                 — written once at run start by the wrangler)
//
// The run-start snapshot is authoritative for the whole run — mid-run edits
// to any of 1-3 do NOT affect an active run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJsonSafe } from "../mcp/_io.js";

export const DEFAULTS = Object.freeze({
	routing: {
		confirm_before: ["feature", "refactor", "crosscutting"],
		classification_threshold_tokens: 40000,
		direct_mode_tools: ["Read", "Grep", "Edit", "Write", "Bash"],
	},
	budget: {
		// Advisory only — guides the planner's task sizing, never enforced at runtime.
		per_task: { max_input_tokens: 100000, max_output_tokens: 20000 },
		per_run: {},
		warn_at_pct: 70,
	},
	ralph: {
		max_iter: 3,
		no_change_policy: { same_diff_twice: "stop", same_failure_twice: "stop" },
	},
	merger: {
		max_files_per_task: 4,
		max_iter: 2,
		per_file_max_output_tokens: 4000,
	},
	parallelism: {
		max_parallel: 3,
		max_parallel_hard_cap: 8,
	},
	bootstrap: {
		install_cmd: "bun install --frozen-lockfile",
		copy_env_files: [".env", ".env.local"],
		port_hash_base: 3000,
	},
	verifier: {
		lint_cmd: "bunx biome check --error-on-warnings",
		format_cmd: "bunx biome format --write",
		test_cmd: "bun test",
	},
	approval: {
		auto_approve_max_tasks: 2,
		require_gate_agents: ["code-big"],
	},
	safety: {
		forbidden_paths_global: [
			".env",
			".env.*",
			"**/.env",
			"**/.env.*",
			"**/secrets/**",
			"**/credentials/**",
			"**/*.pem",
			"**/*.key",
			".claude/settings.json",
			".lazy-dev/settings.json",
		],
		merge_safe_paths: [
			"go.mod",
			"go.sum",
			"package.json",
			"package-lock.json",
			"yarn.lock",
			"bun.lockb",
			"bun.lock",
			"pnpm-lock.yaml",
		],
	},
	agents: {
		// Empty — overrides merged over the shipped roster.
	},
	telemetry: {
		store_prompts: false,
		store_diffs: true,
		cost_detail: "per-iteration",
	},
});

export function resolveSettings(projectDir = process.cwd()) {
	const userPath = join(homedir(), ".claude", "settings.json");
	const projClaude = join(projectDir, ".claude", "settings.json");
	const projLocal = join(projectDir, ".lazy-dev", "settings.json");

	let eff = structuredClone(DEFAULTS);
	eff = mergeDeep(eff, extract(readJsonSafe(userPath), "lazy-dev"));
	eff = mergeDeep(eff, extract(readJsonSafe(projClaude), "lazy-dev"));
	eff = mergeDeep(eff, readJsonSafe(projLocal) || {});

	// require_gate_agents is additive — user config can add agents but never remove the defaults.
	const defaultGate = DEFAULTS.approval.require_gate_agents;
	const merged = eff.approval.require_gate_agents || [];
	eff.approval.require_gate_agents = [...new Set([...defaultGate, ...merged])];

	// Normalise parallelism hard cap
	const pl = eff.parallelism;
	if (pl.max_parallel > pl.max_parallel_hard_cap) pl.max_parallel = pl.max_parallel_hard_cap;
	if (pl.max_parallel < 1) pl.max_parallel = 1;
	return eff;
}

// Write the effective config for a specific run, at run-start. This becomes
// the immutable source of truth for the run — plan-next and gate read from
// here, not from live settings.
export function snapshotForRun(projectDir, runId, overrides = {}) {
	const resolved = mergeDeep(resolveSettings(projectDir), overrides);
	const path = join(projectDir, ".lazy-dev", "runs", runId, "config.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(resolved, null, 2));
	return resolved;
}

const runConfigCache = new Map();

export function readRunConfig(projectDir, runId) {
	const key = `${projectDir}:${runId}`;
	if (runConfigCache.has(key)) return runConfigCache.get(key);
	const path = join(projectDir, ".lazy-dev", "runs", runId, "config.json");
	let cfg;
	if (!existsSync(path)) {
		cfg = resolveSettings(projectDir);
	} else {
		try {
			cfg = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			cfg = resolveSettings(projectDir);
		}
	}
	runConfigCache.set(key, cfg);
	return cfg;
}

// ── helpers ──

function extract(obj, key) {
	return obj && typeof obj === "object" && obj[key] && typeof obj[key] === "object" ? obj[key] : {};
}

function mergeDeep(base, over) {
	if (over === null || typeof over !== "object") return base;
	if (Array.isArray(over)) return [...over]; // arrays are replaced, not merged
	// Plain object over an array base: leave the base array unchanged.
	if (Array.isArray(base) && !Array.isArray(over)) return base;
	const out = Array.isArray(base) ? {} : { ...base };
	for (const k of Object.keys(over)) {
		const b = out[k];
		const o = over[k];
		if (
			b &&
			typeof b === "object" &&
			!Array.isArray(b) &&
			o &&
			typeof o === "object" &&
			!Array.isArray(o)
		) {
			out[k] = mergeDeep(b, o);
		} else if (Array.isArray(b) && o !== null && typeof o === "object" && !Array.isArray(o)) {
			// Plain object must not overwrite an array base — leave base unchanged.
			out[k] = b;
		} else {
			out[k] = o;
		}
	}
	return out;
}
