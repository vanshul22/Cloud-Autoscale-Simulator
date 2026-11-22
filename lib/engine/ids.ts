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

/** Clamp n into [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
