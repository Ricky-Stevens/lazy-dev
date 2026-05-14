import { describe, expect, test } from "bun:test";
import {
	BRIEF_MAX_BYTES,
	requireSafeId,
	requireSafeIdArray,
	sanitiseBrief,
	ValidationError,
} from "./_validation.js";

describe("requireSafeId", () => {
	test("accepts alnum + _ . : -", () => {
		for (const id of ["T-0001", "run-id-123", "x.y:z_0"]) {
			expect(requireSafeId(id, "x")).toBe(id);
		}
	});

	test("rejects traversal and path separators", () => {
		for (const id of ["../etc", "foo/bar", "a\\b", ""]) {
			expect(() => requireSafeId(id, "x")).toThrow(ValidationError);
		}
	});

	test("rejects non-strings", () => {
		expect(() => requireSafeId(null, "x")).toThrow(ValidationError);
		expect(() => requireSafeId(123, "x")).toThrow(ValidationError);
	});
});

describe("requireSafeIdArray", () => {
	test("validates every element", () => {
		expect(requireSafeIdArray(["T-0001", "T-0002"], "ids")).toEqual(["T-0001", "T-0002"]);
		expect(() => requireSafeIdArray(["T-0001", "../x"], "ids")).toThrow(ValidationError);
	});

	test("rejects empty array", () => {
		expect(() => requireSafeIdArray([], "ids")).toThrow(ValidationError);
	});
});

describe("sanitiseBrief", () => {
	test("strips NUL bytes", () => {
		expect(sanitiseBrief("hello\0world")).toBe("helloworld");
	});

	test("rejects empty / whitespace-only", () => {
		expect(() => sanitiseBrief("")).toThrow(ValidationError);
		expect(() => sanitiseBrief("   \n\t  ")).toThrow(ValidationError);
	});

	test("rejects oversize briefs", () => {
		const huge = "x".repeat(BRIEF_MAX_BYTES + 1);
		expect(() => sanitiseBrief(huge)).toThrow(ValidationError);
	});

	test("accepts normal briefs", () => {
		expect(sanitiseBrief("Build a thing")).toBe("Build a thing");
	});
});
