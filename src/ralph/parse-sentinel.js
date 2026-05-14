// parse-sentinel.js
// Extracts the completion/blocked sentinel from a specialist's final message.
//
// Returns one of:
//   { kind: "completed", body: <parsed JSON>, raw: <the JSON string> }
//   { kind: "blocked",   reason: <string>,    raw: <the text inside the block> }
//   { kind: "missing",   detail: <string> }     // no sentinel at all
//   { kind: "malformed", detail: <string>, raw: <best-effort extracted text> }
//
// The Ralph gate treats `completed` as "run verifiers now", `blocked` as
// "surface to orchestrator immediately", and anything else as "retry with a
// corrective prompt" (bounded by MAX_ITER).

const START_COMPLETED = "---COMPLETED---";
const START_BLOCKED = "---BLOCKED---";
const END = "---END---";

export function parseSentinel(lastAssistantMessage) {
	if (typeof lastAssistantMessage !== "string" || lastAssistantMessage.length === 0) {
		return { kind: "missing", detail: "empty last_assistant_message" };
	}

	const completedIdx = lastAssistantMessage.lastIndexOf(START_COMPLETED);
	const blockedIdx = lastAssistantMessage.lastIndexOf(START_BLOCKED);

	// Neither sentinel present
	if (completedIdx === -1 && blockedIdx === -1) {
		return {
			kind: "missing",
			detail: "no ---COMPLETED--- or ---BLOCKED--- marker found",
		};
	}

	// Both present — take whichever came later in the message
	const useCompleted = completedIdx > blockedIdx;
	const startIdx = useCompleted ? completedIdx : blockedIdx;
	const startToken = useCompleted ? START_COMPLETED : START_BLOCKED;
	const contentStart = startIdx + startToken.length;

	const endIdx = lastAssistantMessage.indexOf(END, contentStart);
	if (endIdx === -1) {
		return {
			kind: "malformed",
			detail: `${startToken} present but ---END--- not found after it`,
			raw: lastAssistantMessage.slice(contentStart).trim(),
		};
	}

	const inner = lastAssistantMessage.slice(contentStart, endIdx).trim();

	if (!useCompleted) {
		if (inner.length === 0) {
			return {
				kind: "malformed",
				detail: "---BLOCKED--- block is empty",
				raw: "",
			};
		}
		return { kind: "blocked", reason: inner, raw: inner };
	}

	// completed — expect JSON between the markers
	const jsonText = extractJson(inner);
	if (jsonText === null) {
		return {
			kind: "malformed",
			detail: "---COMPLETED--- block contains no JSON object",
			raw: inner,
		};
	}

	try {
		const body = JSON.parse(jsonText);
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return {
				kind: "malformed",
				detail: "sentinel body must be a JSON object",
				raw: jsonText,
			};
		}
		if (typeof body.summary !== "string" || body.summary.length === 0) {
			return {
				kind: "malformed",
				detail: "sentinel body missing required `summary` string",
				raw: jsonText,
			};
		}
		return { kind: "completed", body, raw: jsonText };
	} catch (err) {
		return {
			kind: "malformed",
			detail: `sentinel JSON parse failed: ${err.message}`,
			raw: jsonText,
		};
	}
}

// Finds the first balanced `{...}` block in the inner text. Tolerates
// surrounding prose or code fences that agents sometimes add despite
// instructions.
function extractJson(text) {
	// Strip common code-fence wrappers like ```json ... ```
	const fenceRe = /```(?:json)?\s*([\s\S]*?)\s*```/;
	const fenceMatch = text.match(fenceRe);
	const src = fenceMatch ? fenceMatch[1] : text;

	const firstBrace = src.indexOf("{");
	if (firstBrace === -1) return null;

	let depth = 0;
	let inString = false;
	let isEscaped = false;
	for (let i = firstBrace; i < src.length; i++) {
		const ch = src[i];
		if (isEscaped) {
			isEscaped = false;
			continue;
		}
		if (ch === "\\") {
			isEscaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return src.slice(firstBrace, i + 1);
		}
	}
	return null; // unbalanced
}
