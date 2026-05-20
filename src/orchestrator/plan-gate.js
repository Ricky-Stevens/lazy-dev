// plan-gate.js
// Decides whether a plan needs human spec review before execution. The rule
// is: a plan is "simple" when it's small enough that spec-level review adds
// no value — the planner's output IS the spec, and if it's wrong the model
// picked the wrong plan. Simple plans auto-advance to specialists; complex
// plans go through the gate so the user can refine before committing.
//
// Override:
//   LAZY_DEV_APPROVAL=required  — always gate, regardless of plan size
//   LAZY_DEV_APPROVAL=skip      — never gate, even for large plans
//
// Config shape (from .lazy-dev/settings.json's `approval` block):
//   approval:
//     auto_approve_max_tasks: 2          # default
//     require_gate_agents: [code-big]  # default
//
// Any task using an agent in require_gate_agents forces the gate regardless
// of count. Any plan larger than auto_approve_max_tasks forces the gate.

export function planIsSimple(tasks, cfg = {}) {
	const envOverride = process.env.LAZY_DEV_APPROVAL;
	if (envOverride === "required") return false;
	if (envOverride === "skip") return true;
	if (envOverride && envOverride !== "required" && envOverride !== "skip") {
		console.error(
			`LAZY_DEV_APPROVAL="${envOverride}" is not a recognized value (expected "required" or "skip"); ignoring`,
		);
	}
	const threshold = cfg.approval || {};
	const maxTasks = threshold.auto_approve_max_tasks ?? 2;
	const gateAgents = new Set(threshold.require_gate_agents || ["code-big"]);
	if (!Array.isArray(tasks) || tasks.length === 0) return true;
	if (tasks.some((t) => gateAgents.has(t.agent))) return false;
	if (tasks.length <= maxTasks) return true;
	return false;
}
