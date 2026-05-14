import { describe, expect, test } from "bun:test";
import { scheduleNext } from "./schedule.js";

const task = (id, depends_on = []) => ({
	id,
	depends_on,
	agent: "code-small",
	scope: { allowed_paths: [] },
});

describe("scheduleNext", () => {
	test("dispatches all independent tasks up to maxParallel", () => {
		const tasks = [task("T-0001"), task("T-0002"), task("T-0003"), task("T-0004")];
		const r = scheduleNext({ tasks, statuses: {}, maxParallel: 3 });
		expect(r.kind).toBe("dispatch");
		expect(r.ids).toEqual(["T-0001", "T-0002", "T-0003"]);
	});

	test("respects depends_on ordering", () => {
		const tasks = [task("T-0001"), task("T-0002", ["T-0001"])];
		const r = scheduleNext({ tasks, statuses: {}, maxParallel: 3 });
		expect(r.kind).toBe("dispatch");
		expect(r.ids).toEqual(["T-0001"]);
	});

	test("unlocks dependent task after predecessor approved", () => {
		const tasks = [task("T-0001"), task("T-0002", ["T-0001"])];
		const r = scheduleNext({
			tasks,
			statuses: { "T-0001": "approved" },
			maxParallel: 3,
		});
		expect(r.kind).toBe("dispatch");
		expect(r.ids).toEqual(["T-0002"]);
	});

	test("returns wait when running tasks fill slots", () => {
		const tasks = [task("T-0001"), task("T-0002")];
		const r = scheduleNext({
			tasks,
			statuses: { "T-0001": "running", "T-0002": "running" },
			maxParallel: 2,
		});
		expect(r.kind).toBe("wait");
		expect(r.running).toEqual(["T-0001", "T-0002"]);
	});

	test("returns blocked on any failed task", () => {
		const tasks = [task("T-0001"), task("T-0002")];
		const r = scheduleNext({
			tasks,
			statuses: { "T-0001": "failed" },
			maxParallel: 3,
		});
		expect(r.kind).toBe("blocked");
		expect(r.failed).toEqual(["T-0001"]);
	});

	test("returns done_specialists when all approved", () => {
		const tasks = [task("T-0001"), task("T-0002")];
		const r = scheduleNext({
			tasks,
			statuses: { "T-0001": "approved", "T-0002": "approved" },
			maxParallel: 3,
		});
		expect(r.kind).toBe("done_specialists");
	});

	test("fills remaining slots after partial completion", () => {
		const tasks = [task("T-0001"), task("T-0002"), task("T-0003")];
		const r = scheduleNext({
			tasks,
			statuses: { "T-0001": "running" },
			maxParallel: 3,
		});
		expect(r.kind).toBe("dispatch");
		expect(r.ids).toEqual(["T-0002", "T-0003"]);
	});

	test("returns empty on no tasks", () => {
		const r = scheduleNext({ tasks: [], statuses: {}, maxParallel: 3 });
		expect(r.kind).toBe("empty");
	});

	test("diamond dependency", () => {
		// A → B, A → C, B+C → D
		const tasks = [
			task("T-0001"),
			task("T-0002", ["T-0001"]),
			task("T-0003", ["T-0001"]),
			task("T-0004", ["T-0002", "T-0003"]),
		];
		// After A approved, B and C dispatchable
		let r = scheduleNext({
			tasks,
			statuses: { "T-0001": "approved" },
			maxParallel: 3,
		});
		expect(r.kind).toBe("dispatch");
		expect(r.ids).toEqual(["T-0002", "T-0003"]);

		// After B and C approved, D dispatchable
		r = scheduleNext({
			tasks,
			statuses: {
				"T-0001": "approved",
				"T-0002": "approved",
				"T-0003": "approved",
			},
			maxParallel: 3,
		});
		expect(r.ids).toEqual(["T-0004"]);

		// After all approved, done
		r = scheduleNext({
			tasks,
			statuses: {
				"T-0001": "approved",
				"T-0002": "approved",
				"T-0003": "approved",
				"T-0004": "approved",
			},
			maxParallel: 3,
		});
		expect(r.kind).toBe("done_specialists");
	});
});
