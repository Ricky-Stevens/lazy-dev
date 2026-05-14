// bun-glob.js — shared Bun.Glob accessor.
//
// Returns Bun.Glob when running under Bun. Throws when Bun is unavailable so
// callers surface the problem immediately rather than silently matching zero
// files.

export function getBunGlob() {
	if (typeof Bun !== "undefined" && Bun.Glob) return Bun.Glob;
	throw new Error("Bun.Glob is required but Bun is not available");
}
