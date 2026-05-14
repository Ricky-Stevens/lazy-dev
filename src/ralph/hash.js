// hash.js — shared FNV-1a hash used by gate and verifiers.

/**
 * 32-bit FNV-1a hash of a string. Returns null for empty/null input.
 * Used for circuit-breaker comparisons (diff hash, failure-signature hash).
 * Non-cryptographic — collision rate is ~1 in 4B per pair, acceptable for
 * oscillation detection where the consequence of a collision is a task being
 * stopped one iteration early, not a security bypass.
 */
export function cheapHash(s) {
	if (!s) return null;
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h * 16777619) >>> 0;
	}
	return h.toString(16);
}
