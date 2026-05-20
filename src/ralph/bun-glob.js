// bun-glob.js — shared Bun.Glob accessor with a lightweight fallback.
//
// Returns Bun.Glob when running under Bun. Falls back to a simple glob
// implementation that handles the patterns used in allowed_paths
// (e.g. "src/*.js", "agents/*.md", ".gitignore").

export function getBunGlob() {
	if (typeof Bun !== "undefined" && Bun.Glob) return Bun.Glob;
	return SimpleGlob;
}

class SimpleGlob {
	constructor(pattern) {
		this._re = globToRegex(pattern);
	}
	match(path) {
		return this._re.test(path);
	}
}

function globToRegex(pattern) {
	let re = "^";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") {
			re += ".*";
			i += pattern[i + 2] === "/" ? 2 : 1;
		} else if (c === "*") {
			re += "[^/]*";
		} else if (c === "?") {
			re += "[^/]";
		} else if (".+^${}()|[]\\".includes(c)) {
			re += "\\" + c;
		} else {
			re += c;
		}
	}
	return new RegExp(re.replace(/(\.\*)+/g, ".*") + "$");
}
