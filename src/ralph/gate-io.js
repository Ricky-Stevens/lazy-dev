// gate-io.js — stdin reading, logging, and retry prompt building for the
// Ralph gate. Extracted from gate.js.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readJsonSafe } from "../mcp/_io.js";

const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

export async function readStdinJson(projectDir) {
	return new Promise((resolve) => {
		let buf = "";
		let done = false;
		const finish = (val) => {
			if (!done) {
				done = true;
				resolve(val);
			}
		};

		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (d) => {
			buf += d;
		});
		process.stdin.on("end", () => {
			if (!buf.trim()) return finish(null);
			logPayload(projectDir, buf);
			try {
				finish(JSON.parse(buf));
			} catch {
				finish(null);
			}
		});
		setTimeout(() => {
			if (buf.trim()) {
				logPayload(projectDir, buf);
				try {
					finish(JSON.parse(buf));
				} catch {
					finish(null);
				}
			} else finish(null);
		}, 2000).unref?.();
	});
}

function logPayload(projectDir, raw) {
	try {
		const logDir = join(projectDir, ".lazy-dev", "runs", "_gate-log");
		mkdirSync(logDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		writeFileSync(join(logDir, `${stamp}-${process.pid}.payload.json`), raw);
	} catch {
		// Best-effort; must not block the gate decision.
	}
}

export function readEnvelope(path) {
	return readJsonSafe(path, MAX_ENVELOPE_BYTES);
}

export function emitRetry(reason) {
	process.stdout.write(
		`${JSON.stringify({
			decision: "block",
			reason,
			continue: false,
			stopReason: reason,
		})}\n`,
	);
}

export function buildRetryPrompt(results, iter, maxIter) {
	const failing = results.filter((r) => !r.passed);
	const passing = results.filter((r) => r.passed);
	const remaining = maxIter - iter;
	const isLastAttempt = remaining <= 0;

	const header = isLastAttempt
		? `Iteration ${iter} of ${maxIter}. THIS IS YOUR LAST ATTEMPT — if the same verifier fails again the harness stops and surfaces to the user.`
		: `Iteration ${iter} of ${maxIter}. ${remaining} attempt(s) remaining after this one.`;

	const lines = [header, "", "Failing verifiers:"];
	for (const r of failing) {
		lines.push(`  FAIL ${r.id}  (${r.kind})`);
		lines.push(`      ${(r.details || "").split("\n").join("\n      ")}`);
	}
	if (passing.length > 0) {
		lines.push("", `Passing (${passing.length}): ${passing.map((r) => r.id).join(", ")}`);
	}
	lines.push(
		"",
		"Fix only the failing items. Do not touch anything already passing.",
		"End with the completion sentinel exactly as specified in your system prompt.",
	);
	return lines.join("\n");
}

export function logDebug(projectDir, msg) {
	try {
		const log = join(projectDir, ".lazy-dev", "runs", "_gate-log", "gate-debug.log");
		mkdirSync(dirname(log), { recursive: true });
		writeFileSync(log, `${new Date().toISOString()} ${msg}\n`, { flag: "a" });
	} catch {
		// Best-effort; must not block the gate.
	}
}
