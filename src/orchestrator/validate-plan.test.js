import { describe, expect, test } from "bun:test";
import { validatePlan } from "./validate-plan.js";

describe("validatePlan", () => {
	const baseTask = (over = {}) => ({
		id: "T-0001",
		title: "test",
		agent: "code-small",
		scope: { allowed_paths: ["src/a.js"] },
		completion_criteria: [{ id: "x", kind: "shell", cmd: "true" }],
		...over,
	});

	test("accepts a single valid task", () => {
		const r = validatePlan({ tasks: [baseTask()] });
		expect(r.ok).toBe(true);
	});

	test("rejects empty tasks", () => {
		const r = validatePlan({ tasks: [] });
		expect(r.ok).toBe(false);
	});

	test("rejects orchestrator-managed agents", () => {
		const r = validatePlan({ tasks: [baseTask({ agent: "planner" })] });
		expect(r.ok).toBe(false);
		expect(r.errors.join("\n")).toContain("orchestrator-managed");
	});

	test("rejects unknown agents", () => {
		const r = validatePlan({
			tasks: [baseTask({ agent: "not-a-real-agent" })],
		});
		expect(r.ok).toBe(false);
	});

	test("rejects malformed task ids", () => {
		const r = validatePlan({ tasks: [baseTask({ id: "T-1" })] });
		expect(r.ok).toBe(false);
	});

	test("rejects duplicate ids", () => {
		const r = validatePlan({ tasks: [baseTask(), baseTask()] });
		expect(r.ok).toBe(false);
		expect(r.errors.join("\n")).toContain("duplicate");
	});

	test("requires mechanical completion_criteria", () => {
		const r = validatePlan({ tasks: [baseTask({ completion_criteria: [] })] });
		expect(r.ok).toBe(false);
	});

	test("detects depends_on referencing unknown id", () => {
		const r = validatePlan({ tasks: [baseTask({ depends_on: ["T-9999"] })] });
		expect(r.ok).toBe(false);
	});

	test("detects simple cycle", () => {
		const a = baseTask({ id: "T-0001", depends_on: ["T-0002"] });
		const b = baseTask({
			id: "T-0002",
			depends_on: ["T-0001"],
			scope: { allowed_paths: ["src/b.js"] },
		});
		const r = validatePlan({ tasks: [a, b] });
		expect(r.ok).toBe(false);
		expect(r.errors.join("\n")).toContain("cycle");
	});

	test("requires depends_on for overlapping allowed_paths", () => {
		const a = baseTask({
			id: "T-0001",
			scope: { allowed_paths: ["src/pricing/a.js"] },
		});
		const b = baseTask({
			id: "T-0002",
			scope: { allowed_paths: ["src/pricing/**"] },
		});
		const r = validatePlan({ tasks: [a, b] });
		expect(r.ok).toBe(false);
		expect(r.errors.join("\n")).toMatch(/overlapping allowed_paths/);
	});

	test("accepts overlapping allowed_paths when depends_on declared", () => {
		const a = baseTask({
			id: "T-0001",
			scope: { allowed_paths: ["src/pricing/a.js"] },
		});
		const b = baseTask({
			id: "T-0002",
			scope: { allowed_paths: ["src/pricing/**"] },
			depends_on: ["T-0001"],
		});
		const r = validatePlan({ tasks: [a, b] });
		expect(r.ok).toBe(true);
	});

	test("allows parallel tasks sharing merge-safe paths without depends_on", () => {
		const a = baseTask({
			id: "T-0001",
			scope: { allowed_paths: ["internal/domain/*.go", "go.mod", "go.sum"] },
		});
		const b = baseTask({
			id: "T-0002",
			scope: { allowed_paths: ["internal/clients/*.go", "go.mod", "go.sum"] },
		});
		const r = validatePlan({ tasks: [a, b] }, { mergeSafePaths: ["go.mod", "go.sum"] });
		expect(r.ok).toBe(true);
	});

	test("accepts non-overlapping sibling paths", () => {
		const a = baseTask({
			id: "T-0001",
			scope: { allowed_paths: ["src/pricing/a.js"] },
		});
		const b = baseTask({
			id: "T-0002",
			scope: { allowed_paths: ["src/auth/b.js"] },
		});
		const r = validatePlan({ tasks: [a, b] });
		expect(r.ok).toBe(true);
	});

	test("requires grep verifier to have pattern + target", () => {
		const r = validatePlan({
			tasks: [baseTask({ completion_criteria: [{ id: "g", kind: "grep" }] })],
		});
		expect(r.ok).toBe(false);
	});

	test("rejects allowed_paths overlapping forbidden_paths_global", () => {
		const r = validatePlan(
			{ tasks: [baseTask({ scope: { allowed_paths: ["src/**"] } })] },
			{ forbiddenPathsGlobal: ["src/secrets/**"] },
		);
		expect(r.ok).toBe(false);
		expect(r.errors.join("\n")).toContain("forbidden pattern");
	});

	test("accepts allowed_paths disjoint from forbidden_paths_global", () => {
		const r = validatePlan(
			{ tasks: [baseTask({ scope: { allowed_paths: ["src/app/**"] } })] },
			{ forbiddenPathsGlobal: ["src/secrets/**"] },
		);
		// Conservative glob heuristic still triggers here because src/** could contain src/secrets/**
		// but src/app/** vs src/secrets/** share only first segment "src" then diverge.
		// Expected behaviour: NOT overlapping (the globs diverge at part 2).
		expect(r.ok).toBe(true);
	});

	test("root-level file does NOT overlap **/.env forbidden glob", () => {
		const r = validatePlan(
			{ tasks: [baseTask({ scope: { allowed_paths: ["hi.js"] } })] },
			{
				forbiddenPathsGlobal: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/secrets/**"],
			},
		);
		expect(r.ok).toBe(true);
	});

	test(".env file DOES overlap **/.env forbidden glob", () => {
		const r = validatePlan(
			{ tasks: [baseTask({ scope: { allowed_paths: [".env"] } })] },
			{ forbiddenPathsGlobal: ["**/.env"] },
		);
		expect(r.ok).toBe(false);
	});

	test("accepts effort-variant agents (low, high)", () => {
		for (const agent of ["code-small-low", "code-small-high", "code-big-low", "code-big-high"]) {
			const r = validatePlan({ tasks: [baseTask({ agent })] });
			expect(r.ok).toBe(true);
		}
	});

	test("normalizes LLM field-name drift in completion_criteria", () => {
		const r = validatePlan({
			tasks: [
				baseTask({
					completion_criteria: [
						{ type: "shell", name: "test", cmd: "bun test", expect: 0 },
						{ kind: "grep", pattern: "greet", file: "hi.js" },
					],
				}),
			],
		});
		expect(r.ok).toBe(true);
	});
});
