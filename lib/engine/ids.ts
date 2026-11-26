// Tiny ID + random helpers used across the engine.
// Kept in one place so the simulation's randomness is easy to find (and later
// swap for a seeded RNG if we ever want fully reproducible runs).

/** Short id like "i-9f3a2b" for instances, "svc-..." for services, etc. */
export function shortId(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 8)}`;
}

/** Random integer in [min, max] inclusive. */
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Clamp n into [lo, hi]. NaN (a number that is not a number, e.g. from Math.round("abc"))
 * would sail straight through Math.max/min and poison whatever it is stored in, so it
 * becomes `lo` instead. Commands also reject non-numeric input up front (commands.ts);
 * this is the safety net underneath.
 */
export function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
