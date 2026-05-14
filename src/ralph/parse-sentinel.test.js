import { describe, expect, test } from "bun:test";
import { parseSentinel } from "./parse-sentinel.js";

describe("parseSentinel", () => {
	test("parses a clean COMPLETED block", () => {
		const msg =
			'some prose\n\n---COMPLETED---\n{"summary":"did the thing","diff_paths":["a.js"]}\n---END---';
		const r = parseSentinel(msg);
		expect(r.kind).toBe("completed");
		expect(r.body.summary).toBe("did the thing");
		expect(r.body.diff_paths).toEqual(["a.js"]);
	});

	test("parses COMPLETED wrapped in ```json fences", () => {
		const msg = '---COMPLETED---\n```json\n{"summary":"fenced"}\n```\n---END---';
		const r = parseSentinel(msg);
		expect(r.kind).toBe("completed");
		expect(r.body.summary).toBe("fenced");
	});

	test("parses BLOCKED", () => {
		const msg = "---BLOCKED---\nCannot proceed: live network needed.\n---END---";
		const r = parseSentinel(msg);
		expect(r.kind).toBe("blocked");
		expect(r.reason).toContain("live network");
	});

	test("missing markers", () => {
		const r = parseSentinel("just prose and no sentinel");
		expect(r.kind).toBe("missing");
	});

	test("missing END token", () => {
		const r = parseSentinel('---COMPLETED---\n{"summary":"x"}');
		expect(r.kind).toBe("malformed");
		expect(r.detail).toContain("---END--- not found");
	});

	test("malformed JSON inside COMPLETED", () => {
		const r = parseSentinel("---COMPLETED---\n{broken: json}\n---END---");
		expect(r.kind).toBe("malformed");
	});

	test("missing required summary field", () => {
		const r = parseSentinel('---COMPLETED---\n{"diff_paths":[]}\n---END---');
		expect(r.kind).toBe("malformed");
		expect(r.detail).toContain("summary");
	});

	test("picks the later of two markers", () => {
		const msg =
			"---BLOCKED---\nearly mistake\n---END---\n" +
			"then I recovered\n" +
			'---COMPLETED---\n{"summary":"done"}\n---END---';
		const r = parseSentinel(msg);
		expect(r.kind).toBe("completed");
	});

	test("nested braces in JSON don't break parsing", () => {
		const msg = '---COMPLETED---\n{"summary":"x","agent_specific":{"a":{"b":1}}}\n---END---';
		const r = parseSentinel(msg);
		expect(r.kind).toBe("completed");
		expect(r.body.agent_specific.a.b).toBe(1);
	});

	test("string braces inside JSON don't break parsing", () => {
		const msg = '---COMPLETED---\n{"summary":"has } in it"}\n---END---';
		const r = parseSentinel(msg);
		expect(r.kind).toBe("completed");
		expect(r.body.summary).toBe("has } in it");
	});

	test("empty input", () => {
		const r = parseSentinel("");
		expect(r.kind).toBe("missing");
	});

	test("null input returns missing", () => {
		const r = parseSentinel(null);
		expect(r.kind).toBe("missing");
	});

	test("non-string input returns missing", () => {
		const r = parseSentinel(123);
		expect(r.kind).toBe("missing");
	});

	test("empty BLOCKED block returns malformed", () => {
		const r = parseSentinel("---BLOCKED---\n---END---");
		expect(r.kind).toBe("malformed");
		expect(r.detail).toContain("empty");
	});

	test("COMPLETED with no JSON object returns malformed", () => {
		const r = parseSentinel("---COMPLETED---\njust plain text\n---END---");
		expect(r.kind).toBe("malformed");
		expect(r.detail).toContain("no JSON");
	});

	test("COMPLETED with array body returns malformed", () => {
		const r = parseSentinel("---COMPLETED---\n[1,2,3]\n---END---");
		expect(r.kind).toBe("malformed");
		expect(r.detail).toContain("JSON object");
	});

	test("COMPLETED with empty summary returns malformed", () => {
		const r = parseSentinel('---COMPLETED---\n{"summary":""}\n---END---');
		expect(r.kind).toBe("malformed");
		expect(r.detail).toContain("summary");
	});

	test("COMPLETED with numeric summary returns malformed", () => {
		const r = parseSentinel('---COMPLETED---\n{"summary":42}\n---END---');
		expect(r.kind).toBe("malformed");
		expect(r.detail).toContain("summary");
	});

	test("BLOCKED takes priority when it appears after COMPLETED", () => {
		const msg =
			'---COMPLETED---\n{"summary":"done"}\n---END---\nthen\n---BLOCKED---\nactually stuck\n---END---';
		const r = parseSentinel(msg);
		expect(r.kind).toBe("blocked");
		expect(r.reason).toContain("stuck");
	});

	test("handles escaped characters in JSON", () => {
		const msg = '---COMPLETED---\n{"summary":"has \\"quotes\\" and \\\\backslash"}\n---END---';
		const r = parseSentinel(msg);
		expect(r.kind).toBe("completed");
		expect(r.body.summary).toContain("quotes");
	});

	test("handles unbalanced braces (no closing brace)", () => {
		const r = parseSentinel('---COMPLETED---\n{"summary":"test\n---END---');
		expect(r.kind).toBe("malformed");
	});
});
