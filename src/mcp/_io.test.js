import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, IOError, readBounded, readJsonBounded, readJsonSafe, tail } from "./_io.js";

let dir;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mcp-io-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("atomicWrite", () => {
	test("writes and leaves no .tmp behind", () => {
		const p = join(dir, "file.json");
		atomicWrite(p, '{"a":1}');
		expect(readFileSync(p, "utf8")).toBe('{"a":1}');
	});

	test("overwrites existing file", () => {
		const p = join(dir, "file.json");
		writeFileSync(p, "old");
		atomicWrite(p, "new");
		expect(readFileSync(p, "utf8")).toBe("new");
	});
});

describe("readBounded", () => {
	test("reads small files", () => {
		const p = join(dir, "f.txt");
		writeFileSync(p, "hello");
		expect(readBounded(p, 10)).toBe("hello");
	});

	test("returns null for missing files", () => {
		expect(readBounded(join(dir, "nope.txt"), 10)).toBeNull();
	});

	test("throws on oversize", () => {
		const p = join(dir, "big.txt");
		writeFileSync(p, "x".repeat(100));
		expect(() => readBounded(p, 50)).toThrow(IOError);
	});
});

describe("readJsonBounded", () => {
	test("parses valid JSON", () => {
		const p = join(dir, "f.json");
		writeFileSync(p, '{"x":1}');
		expect(readJsonBounded(p, 100)).toEqual({ x: 1 });
	});

	test("throws on invalid JSON", () => {
		const p = join(dir, "f.json");
		writeFileSync(p, "not-json{");
		expect(() => readJsonBounded(p, 100)).toThrow(IOError);
	});
});

describe("readJsonSafe", () => {
	test("parses valid JSON", () => {
		const p = join(dir, "f.json");
		writeFileSync(p, '{"x":1}');
		expect(readJsonSafe(p)).toEqual({ x: 1 });
	});

	test("returns null for missing file", () => {
		expect(readJsonSafe(join(dir, "nope.json"))).toBeNull();
	});

	test("returns null for invalid JSON", () => {
		const p = join(dir, "bad.json");
		writeFileSync(p, "not-json{");
		expect(readJsonSafe(p)).toBeNull();
	});

	test("returns null when file exceeds maxBytes", () => {
		const p = join(dir, "big.json");
		writeFileSync(p, '{"x":1}');
		expect(readJsonSafe(p, 3)).toBeNull();
	});
});

describe("tail", () => {
	test("returns last N lines", () => {
		expect(tail("a\nb\nc\nd\ne", 3)).toBe("c\nd\ne");
	});

	test("returns empty string for falsy input", () => {
		expect(tail("", 5)).toBe("");
		expect(tail(null, 5)).toBe("");
	});

	test("returns full string when fewer lines than N", () => {
		expect(tail("a\nb", 5)).toBe("a\nb");
	});
});
