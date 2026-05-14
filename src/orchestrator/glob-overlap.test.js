import { describe, expect, test } from "bun:test";
import { globsIntersect, globsMayOverlap } from "./glob-overlap.js";

describe("globsMayOverlap", () => {
	test("identical globs overlap", () => {
		expect(globsMayOverlap("src/foo.js", "src/foo.js")).toBe(true);
	});

	test("non-overlapping literal paths", () => {
		expect(globsMayOverlap("src/a.js", "lib/b.js")).toBe(false);
	});

	test("single wildcard matches any file in same dir", () => {
		expect(globsMayOverlap("src/*.js", "src/foo.js")).toBe(true);
	});

	test("single wildcard does not cross directories", () => {
		expect(globsMayOverlap("src/*.js", "src/sub/foo.js")).toBe(false);
	});

	test("** matches nested paths", () => {
		expect(globsMayOverlap("src/**/*.js", "src/deep/nested/foo.js")).toBe(true);
	});

	test("** at start matches everything", () => {
		expect(globsMayOverlap("**/*.test.js", "src/foo.test.js")).toBe(true);
	});

	test("both sides using **", () => {
		expect(globsMayOverlap("src/**/*.js", "src/**/*.test.js")).toBe(true);
	});

	test("different extensions with wildcard", () => {
		expect(globsMayOverlap("src/*.js", "src/*.ts")).toBe(false);
	});

	test("partial wildcard patterns", () => {
		expect(globsMayOverlap("src/foo*.js", "src/foobar.js")).toBe(true);
	});

	test("completely disjoint directories", () => {
		expect(globsMayOverlap("frontend/**", "backend/**")).toBe(false);
	});

	test("** with trailing segments that don't align", () => {
		expect(globsMayOverlap("src/**/*.css", "src/deep/file.js")).toBe(false);
	});

	test("different lengths without globstar", () => {
		expect(globsMayOverlap("src/a", "src/a/b")).toBe(false);
	});
});

describe("globsIntersect", () => {
	test("returns overlap string when sets intersect", () => {
		const result = globsIntersect(["src/*.js"], ["src/foo.js"]);
		expect(result).toContain("∩");
	});

	test("returns null when sets are disjoint", () => {
		const result = globsIntersect(["src/**"], ["lib/**"]);
		expect(result).toBe(null);
	});

	test("checks all pairs", () => {
		const result = globsIntersect(["a/**", "src/**"], ["lib/**", "src/foo.js"]);
		expect(result).toContain("src");
	});
});
