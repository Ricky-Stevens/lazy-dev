// glob-overlap.js — conservative glob intersection heuristics for plan validation.
//
// Determines whether two sets of glob patterns could match a common path.
// Does not enumerate the filesystem — uses structural comparison.

// Returns a representative overlapping glob string, or null if no intersection.
export function globsIntersect(a, b) {
	for (const ga of a)
		for (const gb of b) {
			if (globsMayOverlap(ga, gb)) return `${ga} ∩ ${gb}`;
		}
	return null;
}

export function globsMayOverlap(a, b) {
	if (a === b) return true;
	const aParts = globToParts(a);
	const bParts = globToParts(b);
	const n = Math.min(aParts.length, bParts.length);
	for (let i = 0; i < n; i++) {
		const x = aParts[i];
		const y = bParts[i];
		if (x === "**" || y === "**") {
			const starSide = x === "**" ? aParts : bParts;
			const otherSide = x === "**" ? bParts : aParts;
			const afterStar = starSide.slice(i + 1);

			if (afterStar.length > 0) {
				const otherRemaining = otherSide.slice(i);
				let anyAlign = false;
				for (let off = 0; off <= otherRemaining.length - afterStar.length; off++) {
					let ok = true;
					for (let k = 0; k < afterStar.length; k++) {
						const sp = afterStar[k];
						const op = otherRemaining[off + k];
						if (sp === "**" || op === "**") {
							ok = true;
							break;
						}
						if (sp === op || partMatchesSingle(sp, op) || partMatchesSingle(op, sp)) continue;
						ok = false;
						break;
					}
					if (ok) {
						anyAlign = true;
						break;
					}
				}
				if (!anyAlign) return false;
			}
			return true;
		}
		if (x === y) continue;
		if (partMatchesSingle(x, y) || partMatchesSingle(y, x)) continue;
		return false;
	}
	if (aParts.length === bParts.length) return true;
	return false;
}

function globToParts(g) {
	return g.split("/").filter(Boolean);
}

function partMatchesSingle(pattern, literal) {
	if (pattern === "*") return !literal.includes("/");
	if (!pattern.includes("*")) return pattern === literal;
	const re = new RegExp(
		`^${pattern.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`,
	);
	return re.test(literal);
}
