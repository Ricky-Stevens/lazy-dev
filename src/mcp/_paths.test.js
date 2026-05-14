import { describe, expect, test } from "bun:test";
import { guardPath, PathError, resolveRunDir, resolveTaskDir } from "./_paths.js";

describe("guardPath", () => {
	test("accepts paths inside root", () => {
		expect(guardPath("/a/b", "c/d")).toBe("/a/b/c/d");
		expect(guardPath("/a/b", "c")).toBe("/a/b/c");
	});

	test("rejects .. escape", () => {
		expect(() => guardPath("/a/b", "../c")).toThrow(PathError);
		expect(() => guardPath("/a/b", "c/../../d")).toThrow(PathError);
	});

	test("rejects absolute paths outside root", () => {
		expect(() => guardPath("/a/b", "/etc/passwd")).toThrow(PathError);
	});

	test("accepts absolute path that resolves inside root", () => {
		expect(guardPath("/a/b", "/a/b/c")).toBe("/a/b/c");
	});

	test("root itself is allowed", () => {
		expect(guardPath("/a/b", "")).toBe("/a/b");
		expect(guardPath("/a/b", ".")).toBe("/a/b");
	});
});

describe("resolveRunDir + resolveTaskDir", () => {
	test("happy path", () => {
		const p = resolveRunDir("/proj", "2026-04-19T00-00-00Z-abc123");
		expect(p).toBe("/proj/.lazy-dev/runs/2026-04-19T00-00-00Z-abc123");
	});

	test("run_id with .. rejected", () => {
		expect(() => resolveRunDir("/proj", "../etc")).toThrow(PathError);
	});

	test("task dir cannot escape run dir via task_id", () => {
		expect(() => resolveTaskDir("/proj", "2026-04-19T00-00-00Z-abc123", "../../../etc")).toThrow(
			PathError,
		);
	});
});
