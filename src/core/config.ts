/**
 * Environment-variable parsing helpers.
 *
 * One shared vocabulary for turning stringy `[vars]`/secrets into typed values,
 * so every feature parses config the same way (and invalid input degrades the
 * same way: helpers return the fallback instead of throwing).
 */

/**
 * Split a comma-separated env var into trimmed, non-empty parts.
 * Whitespace around commas is ignored; a missing/empty var yields [].
 */
export function envList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Truthy check for on/off env vars. Accepts 'true'/'1'/'yes' (case-insensitive)
 * as true; anything else — including unset — falls back to the default.
 */
export function envBool(value: string | undefined, dflt: boolean): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return dflt;
  return v === 'true' || v === '1' || v === 'yes';
}

/** Integer env var with fallback when missing or non-numeric. */
export function envInt(value: string | undefined, dflt: number): number {
  const t = (value ?? '').trim();
  if (t === '') return dflt; // an empty var is a missing var, not zero
  const n = Number(t);
  return Number.isFinite(n) ? n : dflt;
}
