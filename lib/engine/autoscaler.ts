// =============================================================================
// autoscaler.ts  —  ⭐ CHECKPOINT 1: YOU write the scaling decision.
//
// Every tick, the engine measures how busy the fleet is and asks this function:
//   "Given how loaded we are, how many instances do we WANT?"
//
// The engine (tick.ts) then does the plumbing: if you answer 5 and we have 3, it
// boots 2 more; if you answer 2 and we have 3, it drains 1. This function does
// NOT create or remove anything. It only returns a number. That's deliberate:
// a pure "number in, number out" function is trivial to unit-test and to reason
// about.
//
// ---------------------------------------------------------------------------
// INPUTS
//   avgUtilPct  : fleet utilisation, e.g. 85 means 85% full. Can exceed 100.
//   current     : how many instances we have right now (healthy + booting).
//   cfg         : { min, max, rpsPerInstance, scaleUpAt, scaleDownAt,
//                   cooldownTicks, lb }
//   cooldownLeft: ticks remaining before we're allowed to act again (0 = free).
//
// RETURN
//   the desired instance count (an integer).
//
// ---------------------------------------------------------------------------
// THE DESIGN QUESTIONS (this is where your judgment shapes behaviour)
//
//  1. DEADBAND / FLAPPING. scaleUpAt=70 and scaleDownAt=30 leave a gap on
//     purpose. Between 30% and 70% you do NOTHING. If both were 50, utilisation
//     wobbling around 50 would add/remove an instance every tick ("flapping"),
//     which is expensive and unstable.
//
//  2. HOW BIG A STEP? Adding exactly +1 is gentle but slow in a big spike.
//     Alternatively compute the count that would bring utilisation back to a
//     target:  ceil(current * avgUtilPct / targetUtil). Proportional scaling
//     reacts fast but can overshoot. Which feels right for a demo? You choose.
//
//  3. SCALE DOWN SHOULD BE CAUTIOUS. Scaling up too late hurts users; scaling
//     down too early just wastes a little money. Many real systems scale up
//     fast and down slowly. (Hint: removing 1 at a time is a common policy.)
//
//  4. COOLDOWN. While cooldownLeft > 0, new instances are still booting and
//     haven't affected utilisation yet. Acting again would double-count the
//     problem. Respect the cooldown by returning `current` unchanged.
//
//  5. ALWAYS CLAMP to [cfg.min, cfg.max]. Min protects availability; max
//     protects your wallet.
//
// ---------------------------------------------------------------------------
// THE POLICY BELOW IS A WORKING FIRST VERSION. Read it, then change it:
//   - try a fixed "+1 per step" scale-up and compare how a spike plays out
//   - try scaling down faster, and watch it flap
//   - try a different targetUtil
// =============================================================================

import { clamp } from "./ids";
import type { AutoscaleConfig } from "./types";

export function decideDesiredCount(
  avgUtilPct: number,
  current: number,
  cfg: AutoscaleConfig,
  cooldownLeft: number,
): number {
  // Rule 0: min/max are hard limits, even during cooldown. (If you raise `min`
  // in the config, the fleet must grow to it immediately.)
  const bounded = clamp(current, cfg.min, cfg.max);
  if (bounded !== current) return bounded;

  // Rule 1: COOLDOWN. Instances we just ordered are still booting and have not
  // taken load yet, so utilisation still looks bad. Acting again would
  // double-count the same problem, so we wait it out.
  if (cooldownLeft > 0) return current;

  // ---- SCALE UP: proportional (fast) ---------------------------------------
  if (avgUtilPct > cfg.scaleUpAt) {
    // Aim for the MIDDLE of the deadband (e.g. 50% when the band is 30-70%):
    // high enough not to waste money, low enough to leave headroom for growth.
    const targetUtil = (cfg.scaleUpAt + cfg.scaleDownAt) / 2;

    // Instances needed so that  load / (n * capacity) == targetUtil.
    // Since avgUtilPct = load / (current * capacity), that is:
    const needed = Math.ceil((current * avgUtilPct) / targetUtil);

    // Two guard rails on the jump:
    //   at least +1   -> we are over the threshold, so always add something
    //   at most x2    -> a glitchy reading (e.g. 999% with zero healthy
    //                    instances) must not order 100 servers in one go
    const want = Math.max(current + 1, Math.min(needed, current * 2));
    return clamp(want, cfg.min, cfg.max);
  }

  // ---- SCALE DOWN: cautious (slow) -----------------------------------------
  // Removing capacity too early hurts users; keeping it a bit too long only
  // costs a little money. So: one instance at a time, and only if the
  // remaining fleet would NOT immediately be over the scale-up threshold.
  // That second check is what stops flapping (remove -> overload -> add -> ...).
  if (avgUtilPct < cfg.scaleDownAt && current > cfg.min) {
    const utilAfterRemoval = (avgUtilPct * current) / (current - 1);
    if (utilAfterRemoval < cfg.scaleUpAt) return current - 1;
  }

  // ---- DEADBAND: between the thresholds, do nothing ------------------------
  return current;
}
