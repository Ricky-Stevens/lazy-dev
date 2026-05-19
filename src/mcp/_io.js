// _io.js
// Atomic write + bounded read helpers. Every MCP handler file-IO goes through
// these — never raw writeFileSync / readFileSync on paths under user control.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { JSON_MAX_BYTES } from "./_validation.js";

export class IOError extends Error {
	constructor(message) {
		super(message);
		this.name = "IOError";
	}
}

// tmp+rename write. Atomic against concurrent reads on POSIX.
export function atomicWrite(path, content) {
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

// Bounded read: checks file size before readFileSync. Prevents OOM on malicious
// or corrupted state files.
export function readBounded(path, maxBytes) {
	if (!existsSync(path)) return null;
	const size = statSync(path).size;
	if (size > maxBytes) {
		throw new IOError(`file exceeds ${maxBytes} byte cap (${path}, ${size} bytes)`);
	}
	return readFileSync(path, "utf8");
}

export function readJsonBounded(path, maxBytes = JSON_MAX_BYTES) {
	const raw = readBounded(path, maxBytes);
	if (raw === null) return null;
	try {
		return JSON.parse(raw);
	} catch (err) {
		throw new IOError(`invalid JSON at ${path}: ${err.message}`);
	}
}

// Lenient JSON read for internal orchestrator state. Returns null on missing
// file or parse error — callers treat corrupt state as empty.
// Optional maxBytes guard rejects oversized files (e.g. gate payload protection).
export function readJsonSafe(path, maxBytes) {
	if (!existsSync(path)) return null;
	try {
		if (maxBytes) {
			const size = statSync(path).size;
			if (size > maxBytes) return null;
		}
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export function tail(str, lines) {
	if (!str) return "";
	return str.split("\n").slice(-lines).join("\n");
}
