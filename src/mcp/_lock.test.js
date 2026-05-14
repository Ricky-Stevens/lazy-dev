import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, withRunLock } from "./_lock.js";

let dir;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mcp-lock-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("acquireRunLock", () => {
	test("acquires and releases", () => {
		const release = acquireRunLock(dir);
		expect(existsSync(join(dir, ".lock"))).toBe(true);
		release();
		expect(existsSync(join(dir, ".lock"))).toBe(false);
	});

	test("withRunLock runs fn and releases on success", () => {
		const result = withRunLock(dir, () => 42);
		expect(result).toBe(42);
		expect(existsSync(join(dir, ".lock"))).toBe(false);
	});

	test("withRunLock releases on throw", () => {
		expect(() =>
			withRunLock(dir, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(existsSync(join(dir, ".lock"))).toBe(false);
	});

	test("reclaims a stale lock (mtime > 5s)", () => {
		const lockFile = join(dir, ".lock");
		writeFileSync(lockFile, "stale");
		const past = new Date(Date.now() - 10_000);
		utimesSync(lockFile, past, past);
		const release = acquireRunLock(dir);
		release();
		expect(existsSync(lockFile)).toBe(false);
	});
});
