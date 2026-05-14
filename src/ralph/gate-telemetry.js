// gate-telemetry.js — usage recording and model/effort verification for the
// Ralph gate. Extracted from gate.js.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { extractUsageFromPayload, extractUsageFromTranscript, recordUsage } from "./usage.js";

// Full usage-entry builder + writer. Extracts usage from the transcript,
// compares declared-vs-actual model, records declared effort.
export function recordAgentUsage({
	projectDir,
	runId,
	agentId,
	agentType,
	bareAgentName,
	taskId,
	iteration,
	transcriptPath,
	payload,
	logDebug,
}) {
	const transcriptUsage = extractUsageFromTranscript(transcriptPath);
	const payloadUsage = extractUsageFromPayload(payload);
	const merged = {
		input_tokens: transcriptUsage.input_tokens || payloadUsage.input_tokens || 0,
		output_tokens: transcriptUsage.output_tokens || payloadUsage.output_tokens || 0,
		cache_read_tokens: transcriptUsage.cache_read_tokens || payloadUsage.cache_read_tokens || 0,
		cache_creation_tokens:
			transcriptUsage.cache_creation_tokens || payloadUsage.cache_creation_tokens || 0,
	};

	const entry = {
		agent_id: agentId,
		agent_type: agentType,
		task_id: taskId,
		iteration,
		...merged,
	};

	const expectedEffort = readAgentFrontmatterField(bareAgentName, "effort");
	if (expectedEffort) entry.effort_expected = expectedEffort;

	if (transcriptPath) {
		const modelInfo = extractModelFromTranscript(transcriptPath);
		const expectedModel = readAgentFrontmatterField(bareAgentName, "model");
		entry.model_actual = modelInfo.model || "unknown";
		entry.model_expected = expectedModel || bareAgentName;
		if (modelInfo.model) {
			logDebug(
				`model verify: agent=${agentType} task=${taskId || "(per-run)"} model=${modelInfo.model} effort=${expectedEffort || "(unset)"}`,
			);
		}
		if (expectedModel && modelInfo.model && expectedModel !== modelInfo.model) {
			entry.model_mismatch = true;
			logDebug(
				`WARN model mismatch: agent=${agentType} task=${taskId || "(per-run)"} expected=${expectedModel} actual=${modelInfo.model}`,
			);
		}
	}

	recordUsage(projectDir, runId, entry);
}

// On retry iteration, bump the iteration counter on the most recent
// usage entry for that agent_id.
export function updateUsageIteration(projectDir, runId, agentId, iteration) {
	const path = join(projectDir, ".lazy-dev", "runs", runId, "usage.json");
	if (!existsSync(path)) return;
	try {
		const doc = JSON.parse(readFileSync(path, "utf8"));
		if (!doc.by_iteration) return;
		for (let i = doc.by_iteration.length - 1; i >= 0; i--) {
			if (doc.by_iteration[i].agent_id === agentId) {
				doc.by_iteration[i].iteration = iteration;
				break;
			}
		}
		writeFileSync(`${path}.tmp`, JSON.stringify(doc, null, 2));
		renameSync(`${path}.tmp`, path);
	} catch {
		// Best-effort; gate must not fail for bookkeeping.
	}
}

function readAgentFrontmatterField(bareAgentName, field) {
	if (!bareAgentName) return null;
	if (!/^[A-Za-z0-9_-]+$/.test(bareAgentName)) return null;
	if (!/^[a-z_]+$/.test(field)) return null;
	const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
	if (!pluginRoot) return null;
	const agentPath = join(pluginRoot, "agents", `${bareAgentName}.md`);
	if (!existsSync(agentPath)) return null;
	try {
		const content = readFileSync(agentPath, "utf8");
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!fmMatch) return null;
		const re = new RegExp(`^${field}:\\s*(\\S+)`, "m");
		const m = fmMatch[1].match(re);
		return m ? m[1].trim() : null;
	} catch {
		return null;
	}
}

function extractModelFromTranscript(transcriptPath) {
	try {
		if (!existsSync(transcriptPath)) return {};
		const content = readFileSync(transcriptPath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				const model =
					entry.model || entry.request?.model || entry.message?.model || entry.config?.model;
				if (model) return { model };
			} catch {
				// Malformed JSONL line; try next.
			}
		}
		return {};
	} catch {
		return {};
	}
}
