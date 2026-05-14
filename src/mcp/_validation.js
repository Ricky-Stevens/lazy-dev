// _validation.js
// Input sanitisers + constants used by every MCP tool handler.
// Schema-level `pattern` catches most; handler-level revalidation is belt-and-braces.

export const SAFE_ID_PATTERN = "^[\\w.:-]+$";
const SAFE_ID_REGEX = /^[\w.:-]+$/;

export const BRIEF_MAX_BYTES = 262144;
export const JSON_MAX_BYTES = 4 * 1024 * 1024;
export const MARKDOWN_MAX_BYTES = 1024 * 1024;
export const DOCTOR_OUTPUT_MAX_BYTES = 1024 * 1024;
export const STATUS_MAX_RUNS = 10;
export const DOCTOR_MAX_TASKS = 500;

export function requireSafeId(value, field) {
	if (typeof value !== "string" || value.length === 0) {
		throw new ValidationError(`${field} must be a non-empty string`);
	}
	if (!SAFE_ID_REGEX.test(value)) {
		throw new ValidationError(
			`${field} contains invalid characters (allowed: A-Z a-z 0-9 _ . : -)`,
		);
	}
	return value;
}

export function requireSafeIdArray(values, field) {
	if (!Array.isArray(values) || values.length === 0) {
		throw new ValidationError(`${field} must be a non-empty array of strings`);
	}
	for (let i = 0; i < values.length; i++) {
		requireSafeId(values[i], `${field}[${i}]`);
	}
	return values;
}

export function sanitiseBrief(brief) {
	if (typeof brief !== "string") {
		throw new ValidationError("brief must be a string");
	}
	// Strip NUL bytes (they'd terminate the file on read in many tools).
	const clean = brief.replace(/\0/g, "");
	if (Buffer.byteLength(clean, "utf8") > BRIEF_MAX_BYTES) {
		throw new ValidationError(`brief exceeds ${BRIEF_MAX_BYTES} byte cap`);
	}
	if (clean.trim().length === 0) {
		throw new ValidationError("brief must not be empty");
	}
	return clean;
}

export class ValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = "ValidationError";
	}
}
