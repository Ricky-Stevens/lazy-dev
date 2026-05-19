import { readFileSync } from "node:fs";

export function extractPlanSummary(specPath) {
	let raw;
	try {
		raw = readFileSync(specPath, "utf8");
	} catch {
		return null;
	}

	const sections = {};
	let current = null;
	for (const line of raw.split("\n")) {
		const heading = line.match(/^##\s+(.+)$/);
		if (heading) {
			current = heading[1].trim().toLowerCase();
			sections[current] = [];
		} else if (current) {
			sections[current].push(line);
		}
	}
	const get = (...keys) => {
		for (const k of keys) {
			const match = Object.keys(sections).find((s) => s.includes(k));
			if (match) {
				const text = sections[match].join("\n").trim();
				if (text) return text;
			}
		}
		return null;
	};

	const title = raw.match(/^#\s+(.+)$/m);
	return {
		title: title ? title[1].replace(/^master spec\s*[-–—:]+\s*/i, "").trim() : null,
		problem: get("problem"),
		goal: get("goal"),
		approach: get("approach"),
		scope_in: get("scope -- in", "scope - in", "in scope"),
		scope_out: get("scope -- explicitly out", "scope - out", "out of scope", "explicitly out"),
		risks: get("risk", "gotcha"),
	};
}

const AGENT_MODEL = {
	"code-small": "Haiku",
	"code-medium": "Sonnet",
	"code-big": "Opus",
	debug: "Opus",
	research: "Sonnet",
	docs: "Haiku",
	format: "Haiku",
};

export function buildGateSummary(runId, specPath, tasksJsonPath, tasks) {
	return {
		run_id: runId,
		master_spec_path: specPath,
		tasks_json_path: tasksJsonPath,
		plan_summary: extractPlanSummary(specPath),
		task_count: tasks.length,
		tasks: tasks.map((t) => ({
			id: t.id,
			agent: t.agent,
			model: AGENT_MODEL[t.agent] || t.agent,
			effort: t.effort || null,
			title: t.title,
			goal: t.goal || null,
			depends_on: t.depends_on || [],
			allowed_paths: t.scope?.allowed_paths || [],
		})),
	};
}
