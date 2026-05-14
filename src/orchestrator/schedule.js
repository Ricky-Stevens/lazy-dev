// schedule.js
// Given the current state of a run's tasks, returns the next actions for the
// wrangler to take. Pure function — no I/O.
//
// Task statuses:
//   pending    — never dispatched
//   running    — dispatched, waiting for APPROVED/FAILED marker
//   approved   — verifiers passed
//   failed     — circuit breaker tripped or specialist blocked
//   cancelled  — run was cancelled
//
// Input: { tasks: [...], statuses: { "T-0001": "pending", ... }, maxParallel: 3 }
// Output:
//   { kind: "dispatch", ids: ["T-0001", "T-0002"] }
//       → wrangler dispatches these in parallel this round
//   { kind: "wait", running: ["T-0003"] }
//       → wrangler polls until one of these changes state
//   { kind: "blocked", failed: ["T-0002"] }
//       → at least one task failed; orchestrator surfaces to user
//   { kind: "done_specialists" }
//       → every task approved; orchestrator moves to reviewer phase
//   { kind: "empty" }
//       → no tasks (should not happen if validator ran)

export function scheduleNext({ tasks, statuses, maxParallel = 3 }) {
	if (!tasks || tasks.length === 0) return { kind: "empty" };

	const status = (id) => statuses[id] || "pending";

	// Collect current state
	const pending = [];
	const running = [];
	const failed = [];
	const approved = [];
	for (const t of tasks) {
		const s = status(t.id);
		if (s === "pending") pending.push(t);
		else if (s === "running") running.push(t.id);
		else if (s === "failed" || s === "cancelled") failed.push(t.id);
		else if (s === "approved") approved.push(t.id);
	}

	// If anything failed, surface immediately — no new dispatches, even if
	// parallelism has slack and unrelated tasks could proceed.
	if (failed.length) return { kind: "blocked", failed };

	if (pending.length === 0 && running.length === 0) {
		return { kind: "done_specialists" };
	}

	// Tasks whose dependencies are all approved are eligible.
	const eligible = pending.filter((t) =>
		(t.depends_on || []).every((d) => status(d) === "approved"),
	);

	const slots = Math.max(0, maxParallel - running.length);
	const toDispatch = eligible.slice(0, slots);

	if (toDispatch.length > 0) {
		return { kind: "dispatch", ids: toDispatch.map((t) => t.id) };
	}

	// Nothing dispatchable right now — we're waiting on running tasks
	// (or on dependencies that are still gating eligibility).
	if (running.length > 0) return { kind: "wait", running };

	// No running tasks, pending but not eligible → something is stuck.
	// Most likely cause: a pending task's depends_on resolves to another
	// pending task with no in-flight work. Shouldn't happen if validator
	// caught cycles; surface defensively.
	return {
		kind: "blocked",
		failed: [],
		detail: `no tasks eligible; pending but unable to dispatch: ${pending.map((t) => t.id).join(", ")}`,
	};
}
