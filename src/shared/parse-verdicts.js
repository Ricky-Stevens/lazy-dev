// parse-verdicts.js
// Shared parsers for reviewer output. Used by plan-next.js (for phase
// routing) and review.js (for exposing per-task verdict on `review.js verdict`).
//
// The reviewer writes review.md with the shape:
//   **Verdict:** PASS_ALL | CHANGES_REQUESTED | BLOCK
//   ## T-0001 (<agent>) -- PASS | CHANGES_REQUESTED | BLOCK

export function parseReviewVerdict(md) {
	const m = md.match(/^\*\*Verdict:\*\*\s*(PASS_ALL|CHANGES_REQUESTED|BLOCK)/im);
	return m ? m[1].toUpperCase() : null;
}

export function parsePerTaskVerdicts(md) {
	const out = {};
	const re = /^##\s+(T-\d{4,})\b.*?(?:—|--)\s*(PASS|CHANGES_REQUESTED|BLOCK)/gim;
	let m = re.exec(md);
	while (m !== null) {
		out[m[1]] = m[2].toUpperCase();
		m = re.exec(md);
	}
	return out;
}
