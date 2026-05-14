import { describe, expect, test } from "bun:test";
import { cheapHash } from "./hash.js";

describe("cheapHash", () => {
	test("returns null for empty string", () => {
		expect(cheapHash("")).toBe(null);
	});

	test("returns null for null", () => {
		expect(cheapHash(null)).toBe(null);
	});

	test("returns null for undefined", () => {
		expect(cheapHash(undefined)).toBe(null);
	});

	test("returns a hex string for non-empty input", () => {
		const result = cheapHash("hello");
		expect(typeof result).toBe("string");
		expect(result).toMatch(/^[0-9a-f]+$/);
	});

	test("same input always produces same hash", () => {
		expect(cheapHash("foo")).toBe(cheapHash("foo"));
	});

	test("different inputs produce different hashes", () => {
		expect(cheapHash("foo")).not.toBe(cheapHash("bar"));
	});

	test("handles long strings", () => {
		const long = "a".repeat(100_000);
		const result = cheapHash(long);
		expect(typeof result).toBe("string");
		expect(result).toMatch(/^[0-9a-f]+$/);
	});
});
