// =============================================================================
// traffic.ts  —  Turns "what the user asked for" into "requests per second now".
//
// Two separate ideas live here:
//
//   1. PATTERN  : the *shape* of load over time (flat, spike, ramp, sine, noise).
//                 `desiredRps()` answers "if the clock says tick N, how much
//                 traffic does this pattern want right now?"
//
//   2. EASING   : real traffic doesn't teleport from 40 to 400 req/s in one
//                 instant. `easeToward()` moves the *current* RPS part-way to the
//                 desired value each tick, so charts show smooth ramps and the
//                 autoscaler has to react to a moving target.
//
// `service.targetRps` is the user's BASE load (the slider). The pattern modulates
// around it. `service.currentRps` is what the system is actually receiving.
// =============================================================================

import { clamp } from "./ids";
import type { Pattern } from "./types";

/** How many ticks a "spike" burst lasts before traffic returns to flat. */
export const SPIKE_DURATION_TICKS = 30;

/** Length of one full day/night cycle for the "sine" pattern, in ticks. */
const SINE_PERIOD_TICKS = 60;

/**
 * Desired RPS for a pattern at local time `t` (ticks since the pattern started).
 * `base` is the slider value. Always returns >= 0.
 */
export function desiredRps(
  pattern: Pattern,
  t: number,
  base: number,
  minuteOfDay = 0, // the simulated clock, 0..1439: only the "daily" pattern uses it
): number {
  switch (pattern) {
    case "flat":
      return base;

    case "daily": {
      // Traffic that follows the CLOCK (not the time since you pressed the button):
      // quiet at night, a broad daytime peak around 13:00 and a sharper evening peak
      // around 20:30. Two bell curves on a night-time floor. This is what makes a
      // schedule like "business hours need more instances" visibly sensible.
      const bump = (centre: number, spread: number) => {
        const d = Math.abs(minuteOfDay - centre);
        const wrapped = Math.min(d, 1440 - d); // distance on a circle: 23:50 is close to 00:10
        return Math.exp(-(wrapped * wrapped) / (2 * spread * spread));
      };
      return base * (0.25 + 1.1 * bump(13 * 60, 180) + 0.9 * bump(20.5 * 60, 90));
    }

    case "spike": {
      // Sharp rise over 5 ticks, hold at 5x, then decay over the last 10 ticks.
      const rise = clamp(t / 5, 0, 1);
      const fall = clamp((SPIKE_DURATION_TICKS - t) / 10, 0, 1);
      const envelope = Math.min(rise, fall); // 0..1
      return base * (1 + 4 * envelope);
    }

    case "ramp":
      // Steady climb: +3 RPS per tick, capped at 6x the base so it can't run away.
      return Math.min(base + 3 * t, base * 6);

    case "sine": {
      // Smooth day/night wave between 20% and 180% of base.
      const phase = (2 * Math.PI * t) / SINE_PERIOD_TICKS;
      return base * (1 + 0.8 * Math.sin(phase));
    }

    case "noise":
      // Base load with +/-30% random jitter every tick.
      return base * (1 + (Math.random() - 0.5) * 0.6);
  }
}

/**
 * Move `current` part-way toward `desired`.
 * `rate` is the fraction of the gap closed per tick (0.3 = close 30% of the gap).
 * We snap when within 0.5 RPS so it settles exactly instead of crawling forever.
 */
export function easeToward(current: number, desired: number, rate = 0.3): number {
  const gap = desired - current;
  if (Math.abs(gap) < 0.5) return desired;
  return current + gap * rate;
}
