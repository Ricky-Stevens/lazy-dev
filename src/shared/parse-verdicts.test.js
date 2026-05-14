import { describe, expect, test } from "bun:test";
import { parsePerTaskVerdicts, parseReviewVerdict } from "./parse-verdicts.js";

describe("parseReviewVerdict", () => {
	test("parses PASS_ALL", () => {
		expect(parseReviewVerdict("**Verdict:** PASS_ALL\n")).toBe("PASS_ALL");
	});

	test("parses CHANGES_REQUESTED", () => {
		expect(parseReviewVerdict("**Verdict:** CHANGES_REQUESTED\n")).toBe("CHANGES_REQUESTED");
	});

	test("parses BLOCK", () => {
		expect(parseReviewVerdict("**Verdict:** BLOCK\n")).toBe("BLOCK");
	});

	test("returns null when no verdict line present", () => {
		expect(parseReviewVerdict("no verdict here")).toBeNull();
	});

	test("is case-insensitive on the label but preserves uppercase verdict", () => {
		expect(parseReviewVerdict("**verdict:** pass_all")).toBe("PASS_ALL");
	});
});

describe("parsePerTaskVerdicts", () => {
	test("extracts per-task verdicts from a typical review.md body", () => {
		const md = [
			"# Review",
			"**Verdict:** CHANGES_REQUESTED",
			"",
			"## T-0001 (code-small) — PASS",
			"body",
			"## T-0002 (code-small) — CHANGES_REQUESTED",
			"body",
			"## T-0003 (code-big) — BLOCK",
			"body",
		].join("\n");
		expect(parsePerTaskVerdicts(md)).toEqual({
			"T-0001": "PASS",
			"T-0002": "CHANGES_REQUESTED",
			"T-0003": "BLOCK",
		});
	});

	test("returns empty object when no per-task headings match", () => {
		expect(parsePerTaskVerdicts("nothing here")).toEqual({});
	});

	test("handles 4+ digit task ids", () => {
		const md = "## T-10234 (code-small) — PASS";
		expect(parsePerTaskVerdicts(md)).toEqual({ "T-10234": "PASS" });
	});
});
