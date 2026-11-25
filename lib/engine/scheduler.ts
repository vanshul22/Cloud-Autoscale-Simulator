// =============================================================================
// scheduler.ts  —  Scheduled scaling: capacity limits that follow the clock.
//
// Reactive autoscaling (autoscaler.ts) only reacts AFTER load arrives. But many
// workloads are predictable: a shop is busy 09:00-18:00, a batch system at night.
// A schedule lets you say, ahead of time, "during these hours keep at least 4
// instances". It does this by changing the autoscaler's min and max limits for the
// window; the reactive autoscaler keeps working inside those limits.
//
// Why bother, if the autoscaler would add instances anyway? Two reasons:
//   1. NO LAG. New instances take a few ticks to boot, so a reactive scaler is always
//      a little late to a sudden rush. A schedule has capacity already warm.
//   2. PRE-WARM. A window can start EARLY (prewarmMin) so the instances are booted and
//      ready at the moment traffic arrives.
//
// All times are "minutes since midnight" on the simulated clock (0..1439). One tick
// is one simulated minute, so a whole day takes 24 real minutes at 1x speed, or about
// 24 seconds at 60x.
// =============================================================================

import type { Schedule } from "./types";

export type Phase = "active" | "prewarm" | "off";

export interface Bounds {
  min: number;
  max: number;
  /** The schedule that produced these bounds, or null when the base limits apply. */
  source: Schedule | null;
  phase: Phase;
}

const DAY = 1440;

/** Is `minute` inside [from, to)? Handles windows that cross midnight (22:00-06:00). */
function inRange(minute: number, from: number, to: number): boolean {
  if (from === to) return false; // an empty window
  if (from < to) return minute >= from && minute < to;
  return minute >= from || minute < to; // wraps past midnight
}

/** Where is `minute` relative to this one schedule: inside it, in its pre-warm, or outside? */
export function windowPhase(s: Schedule, minute: number): Phase {
  if (s.enabled === false) return "off";
  if (inRange(minute, s.fromMin, s.toMin)) return "active";
  const lead = Math.max(0, s.prewarmMin ?? 0);
  if (lead > 0) {
    const earlyStart = (s.fromMin - lead + DAY) % DAY;
    if (inRange(minute, earlyStart, s.fromMin)) return "prewarm";
  }
  return "off";
}

// -----------------------------------------------------------------------------
// ⭐ THE OVERLAP RULE: the part of this file worth reading closely and tuning.
//
// What if two windows cover the same minute (say "business hours" 09-18 and "lunch
// rush" 12-14)? We need ONE answer for min and max. The rule here is:
//
//     the FIRST matching window in the list wins.
//
// That makes the list order a priority order you control: put the specific window
// ("lunch rush") above the broad one ("business hours"). Alternatives worth trying:
//   - take the HIGHEST min among matching windows (never less capacity than any
//     window asks for), or
//   - the window that STARTED most recently wins (newest rule overrides).
// Each is defensible; "first wins" is the easiest to predict and to debug.
// -----------------------------------------------------------------------------
export function effectiveBounds(
  schedules: Schedule[] | undefined,
  minute: number,
  base: { min: number; max: number },
): Bounds {
  for (const s of schedules ?? []) {
    const phase = windowPhase(s, minute);
    if (phase === "off") continue;
    const min = Math.max(0, Math.round(s.min));
    // Never let a window set a ceiling below its own floor.
    const max = Math.max(min, Math.round(s.max), 1);
    return { min, max, source: s, phase };
  }
  return { min: base.min, max: base.max, source: null, phase: "off" };
}

/**
 * How many minutes until the limits next change, and to what: the next moment any
 * enabled window starts (or its pre-warm begins) or ends. Null when there are none.
 */
export function nextChange(
  schedules: Schedule[] | undefined,
  minute: number,
  base: { min: number; max: number },
): { inMinutes: number; to: Bounds } | null {
  if (!(schedules ?? []).some((s) => s.enabled !== false)) return null;
  const now = effectiveBounds(schedules, minute, base);
  for (let ahead = 1; ahead <= DAY; ahead++) {
    const m = (minute + ahead) % DAY;
    const b = effectiveBounds(schedules, m, base);
    if (b.min !== now.min || b.max !== now.max || b.source?.id !== now.source?.id) {
      return { inMinutes: ahead, to: b };
    }
  }
  return null; // the limits never change (e.g. one window covering the whole day)
}

/** "HH:MM" for a minute-of-day. */
export function formatMinute(m: number): string {
  const x = ((Math.round(m) % DAY) + DAY) % DAY;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
}
