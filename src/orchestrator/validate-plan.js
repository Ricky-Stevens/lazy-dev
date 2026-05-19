// validate-plan.js — validates a planner's tasks.json before specialist dispatch.

import { globsIntersect, globsMayOverlap } from "./glob-overlap.js";

// Orchestrator-managed agents are dispatched by plan_next, not by tasks.json.
const ORCHESTRATOR_MANAGED_PREFIXES = ["planner", "reviewer", "merger", "wrangler", "orchestrator"];

function isOrchestratorManaged(agentName) {
	return ORCHESTRATOR_MANAGED_PREFIXES.some(
		(p) => agentName === p || agentName.startsWith(`${p}-`),
	);
}

const VALID_KINDS = new Set(["shell", "grep", "file_exists", "diff_scope"]);
const VALID_AGENTS = new Set([
	"code-small",
	"code-medium",
	"code-big",
	"debug",
	"research",
	"docs",
	"format",
]);
const VALID_EFFORTS = new Set(["low", "medium", "high", "max"]);

const AGENT_MODEL_TIER = {
	"code-small": "haiku",
	"code-medium": "sonnet",
	"code-big": "opus",
	debug: "opus",
	research: "sonnet",
	docs: "haiku",
	format: "haiku",
};

const EFFORTS_FOR_TIER = {
	haiku: new Set(["low", "medium"]),
	sonnet: new Set(["low", "medium", "high"]),
	opus: new Set(["low", "medium", "high", "max"]),
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: plan validation checks many interdependent constraints (agent names, paths, deps, scopes); splitting would scatter related checks across files
export function validatePlan(plan, options = {}) {
	const errors = [];
	const warnings = [];
	const forbiddenGlobal = options.forbiddenPathsGlobal || [];
	const mergeSafe = new Set(options.mergeSafePaths || []);

	if (!plan || typeof plan !== "object") {
		return { ok: false, errors: ["tasks.json is empty or not an object"] };
	}
	const tasks = plan.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) {
		return {
			ok: false,
			errors: ["tasks.json must have a non-empty `tasks` array"],
		};
	}

	const seenIds = new Set();
	for (let i = 0; i < tasks.length; i++) {
		const t = tasks[i];
		const tag = `tasks[${i}]${t?.id ? ` (${t.id})` : ""}`;

		if (!t || typeof t !== "object") {
			errors.push(`${tag}: not an object`);
			continue;
		}
		if (typeof t.id !== "string" || !/^T-\d{4,}$/.test(t.id))
			errors.push(`${tag}: id must match /^T-\\d{4,}$/`);
		if (seenIds.has(t.id)) errors.push(`${tag}: duplicate id ${t.id}`);
		seenIds.add(t.id);

		if (typeof t.agent !== "string") errors.push(`${tag}: missing agent`);
		else if (isOrchestratorManaged(t.agent))
			errors.push(`${tag}: agent ${t.agent} is orchestrator-managed; do not schedule it`);
		else if (!VALID_AGENTS.has(t.agent)) errors.push(`${tag}: unknown agent ${t.agent}`);

		if (t.effort !== undefined) {
			if (!VALID_EFFORTS.has(t.effort)) {
				errors.push(
					`${tag}: unknown effort "${t.effort}"; pick one of ${Array.from(VALID_EFFORTS).join(", ")}`,
				);
			} else {
				const tier = AGENT_MODEL_TIER[t.agent];
				const tierEfforts = tier && EFFORTS_FOR_TIER[tier];
				if (tierEfforts && !tierEfforts.has(t.effort)) {
					warnings.push(
						`${tag}: effort "${t.effort}" is not effective for ${t.agent} (${tier}); supported: ${Array.from(tierEfforts).join(", ")}`,
					);
				}
			}
		}

		if (typeof t.goal !== "string" || !t.goal)
			errors.push(`${tag}: missing goal — specialist needs this to understand the task`);
		if (typeof t.details !== "string" || !t.details)
			errors.push(`${tag}: missing details — specialist needs implementation guidance`);
		if (typeof t.title !== "string" || !t.title)
			errors.push(`${tag}: missing title — shown in reviewer/doctor output`);
		if (t.budget && typeof t.budget === "object") {
			if (typeof t.budget.max_iter === "number" && t.budget.max_iter < 1)
				errors.push(`${tag}: budget.max_iter must be >= 1`);
		}

		if (!t.scope || !Array.isArray(t.scope.allowed_paths) || t.scope.allowed_paths.length === 0) {
			errors.push(`${tag}: scope.allowed_paths must be a non-empty array`);
		} else {
			// forbidden_paths_global check — any allowed path that overlaps a global
			// forbidden glob is rejected outright. Prevents a planner from routing
			// a specialist into .env, secrets/, etc.
			for (const ap of t.scope.allowed_paths) {
				for (const fg of forbiddenGlobal) {
					if (globsMayOverlap(ap, fg)) {
						errors.push(
							`${tag}: allowed_path "${ap}" overlaps forbidden pattern "${fg}". ` +
								`Replace ** with specific extensions (e.g., "${ap.replace(/\*\*$/, "*.go")}").`,
						);
					}
				}
			}
		}

		if (!Array.isArray(t.completion_criteria) || t.completion_criteria.length === 0) {
			errors.push(`${tag}: completion_criteria must be a non-empty array`);
		} else {
			const seenCriterionIds = new Set();
			for (let j = 0; j < t.completion_criteria.length; j++) {
				const c = t.completion_criteria[j];
				// Normalize common LLM field-name drift (planners sometimes improvise).
				if (c && typeof c === "object") {
					if (!c.kind && c.type) {
						c.kind = c.type;
						c.type = undefined;
					}
					if (!c.id && c.name) {
						c.id = c.name;
						c.name = undefined;
					}
					if (c.kind === "shell" && c.must_exit == null && c.expect != null) {
						c.must_exit = c.expect;
						c.expect = undefined;
					}
					if (c.kind === "shell" && c.must_exit == null && c.expected_exit != null) {
						c.must_exit = c.expected_exit;
						c.expected_exit = undefined;
					}
					if (c.kind === "grep" && !c.in_file && c.file) {
						c.in_file = c.file;
						c.file = undefined;
					}
					if (c.kind === "grep" && !c.in_glob && c.path_glob) {
						c.in_glob = c.path_glob;
						c.path_glob = undefined;
					}
					if (c.kind === "grep" && c.must_match == null && c.match != null) {
						c.must_match = c.match;
						c.match = undefined;
					}
					if (c.kind === "shell" && c.must_exit == null && c.exit_code != null) {
						c.must_exit = c.exit_code;
						c.exit_code = undefined;
					}
					if (!c.id && c.kind) {
						c.id = `${c.kind}_${j}`;
					}
				}
				const ctag = `${tag}.completion_criteria[${j}]${c?.id ? ` (${c.id})` : ""}`;
				if (!c || typeof c !== "object") {
					errors.push(`${ctag}: not an object`);
					continue;
				}
				if (typeof c.id !== "string" || !c.id) errors.push(`${ctag}: missing id`);
				else if (seenCriterionIds.has(c.id))
					errors.push(
						`${ctag}: duplicate criterion id "${c.id}" — ids must be unique within a task`,
					);
				else seenCriterionIds.add(c.id);
				if (!VALID_KINDS.has(c.kind)) errors.push(`${ctag}: unknown kind ${c.kind}`);
				if (c.kind === "shell") {
					if (typeof c.cmd !== "string") errors.push(`${ctag}: shell needs cmd`);
					else {
						if (/(?:^|\s)cd\s+/.test(c.cmd))
							errors.push(
								`${ctag}: shell cmd contains "cd ..." — verifiers run in the worktree automatically. Use bare commands without cd.`,
							);
						if (/^\s*grep\s/.test(c.cmd))
							warnings.push(
								`${ctag}: shell cmd is a grep command — use the built-in "grep" kind instead (portable, JS regex, better error messages).`,
							);
					}
				}
				if (c.kind === "grep") {
					if (typeof c.pattern !== "string") errors.push(`${ctag}: grep needs pattern`);
					else {
						try {
							new RegExp(c.pattern, "m");
						} catch (e) {
							errors.push(`${ctag}: grep pattern is invalid regex: ${e.message}`);
						}
					}
					if (!c.in_file && !c.in_glob) errors.push(`${ctag}: grep needs in_file or in_glob`);
					if (typeof c.in_file === "string" && c.in_file.startsWith("/"))
						errors.push(`${ctag}: in_file must be relative to worktree, not absolute`);
					if (typeof c.in_glob === "string" && c.in_glob.startsWith("/"))
						errors.push(`${ctag}: in_glob must be relative to worktree, not absolute`);
				}
				if (c.kind === "file_exists") {
					if (typeof c.path !== "string") errors.push(`${ctag}: file_exists needs path`);
					else if (c.path.startsWith("/"))
						errors.push(`${ctag}: path must be relative to worktree, not absolute`);
				}
			}
		}

		if (t.depends_on != null) {
			if (!Array.isArray(t.depends_on)) errors.push(`${tag}: depends_on must be an array`);
			else
				for (const d of t.depends_on)
					if (typeof d !== "string") errors.push(`${tag}: depends_on entries must be strings`);
		}
	}

	// ── Cross-task checks (run even if per-task errors exist so all issues are reported at once) ──

	// All depends_on ids must resolve.
	for (const t of tasks) {
		for (const d of t.depends_on || []) {
			if (!seenIds.has(d)) errors.push(`${t.id}: depends_on references unknown task ${d}`);
		}
	}

	// Cycle check — DFS topo.
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const WHITE = 0;
	const GRAY = 1;
	const BLACK = 2;
	const color = new Map(tasks.map((t) => [t.id, WHITE]));
	const cycleNodes = [];
	function visit(id) {
		color.set(id, GRAY);
		for (const d of byId.get(id)?.depends_on || []) {
			const c = color.get(d);
			if (c === GRAY) {
				cycleNodes.push(`${id} → ${d}`);
				return;
			}
			if (c === WHITE) visit(d);
		}
		color.set(id, BLACK);
	}
	for (const t of tasks) if (color.get(t.id) === WHITE) visit(t.id);
	if (cycleNodes.length) errors.push(`depends_on cycle detected: ${cycleNodes.join(", ")}`);

	// Scope-overlap check — every pair whose allowed_paths intersect must have
	// a depends_on edge in one direction (transitively). Merge-safe paths
	// (go.mod, package.json, etc.) are excluded — they're additive and merge cleanly.
	const nonMergeSafe = (paths) => paths.filter((p) => !mergeSafe.has(p));
	const reaches = computeReachability(tasks);
	for (let i = 0; i < tasks.length; i++) {
		for (let j = i + 1; j < tasks.length; j++) {
			const a = tasks[i];
			const b = tasks[j];
			const aPaths = nonMergeSafe(a.scope?.allowed_paths || []);
			const bPaths = nonMergeSafe(b.scope?.allowed_paths || []);
			const overlap = globsIntersect(aPaths, bPaths);
			if (!overlap) continue;
			const ordered = reaches.get(a.id)?.has(b.id) || reaches.get(b.id)?.has(a.id);
			if (!ordered) {
				errors.push(
					`${a.id} and ${b.id} have overlapping allowed_paths (${overlap}) but neither depends on the other; declare depends_on so the orchestrator runs them serially.`,
				);
			}
		}
	}

	const result = errors.length ? { ok: false, errors } : { ok: true };
	if (warnings.length) result.warnings = warnings;
	return result;
}

// Transitive depends_on reachability. reaches.get(A) = set of ids A depends on (directly or indirectly).
function computeReachability(tasks) {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const cache = new Map();
	function r(id) {
		if (cache.has(id)) return cache.get(id);
		const acc = new Set();
		cache.set(id, acc);
		for (const d of byId.get(id)?.depends_on || []) {
			acc.add(d);
			for (const x of r(d)) acc.add(x);
		}
		return acc;
	}
	for (const t of tasks) r(t.id);
	return cache;
}
