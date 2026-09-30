/**
 * Parse a `--seed` CLI argument into a deterministic 32-bit integer.
 *
 * A bare integer is used as-is. Any other string — most importantly a git SHA
 * like `36f5b42a1c` — is stably hashed rather than fed to `Number.parseInt`,
 * which silently truncated `"36f5b42a1c"` to `36` and collapsed an
 * alpha-leading SHA to `NaN` (which `SeededRng` then folded into a single
 * constant). That quietly broke the "deterministic, replayable" guarantee on
 * the one command users copy (S-044). Hashing keeps every distinct seed string
 * mapped to a distinct, reproducible integer with no precision loss.
 */
export function parseSeed(raw: string): number {
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (Number.isSafeInteger(value)) return value;
  }
  return fnv1a32(trimmed);
}

/** FNV-1a, 32-bit. Deterministic, dependency-free, returns an unsigned int. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
