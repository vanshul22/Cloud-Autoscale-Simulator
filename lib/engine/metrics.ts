// =============================================================================
// metrics.ts  —  Derives the numbers an operator would watch on a dashboard.
//
// Nothing here changes the world; these are pure functions of the current
// state. Keeping "measure" separate from "decide" (autoscaler) and "act" (tick)
// makes each piece easy to test and to explain.
// =============================================================================

import { clamp } from "./ids";
import type { Instance, Service } from "./types";

/**
 * Instances that are actually allowed to receive traffic: healthy AND not on
 * standby (the idle "green" fleet of a blue-green deployment is warm but not in the
 * nginx upstream until the cutover).
 */
export function servingInstances(instances: Instance[]): Instance[] {
  return instances.filter((i) => i.status === "healthy" && !i.standby);
}

/** How many req/s ONE instance can serve: its size times the standard capacity. */
export function instanceCapacityRps(inst: Instance, rpsPerInstance: number): number {
  return Math.max(1, inst.weight || 1) * rpsPerInstance;
}

/** Total RPS the healthy fleet can absorb before it starts to saturate. */
export function capacityRps(svc: Service): number {
  return servingInstances(svc.instances).reduce(
    (sum, i) => sum + instanceCapacityRps(i, svc.autoscale.rpsPerInstance),
    0,
  );
}

/**
 * Utilisation %, i.e. how full the fleet is. Can exceed 100 when overloaded.
 * With zero healthy instances any traffic means "infinitely overloaded"; we
 * report 999 so charts and rules have a finite, obviously-bad number.
 */
export function utilisationPct(svc: Service): number {
  const cap = capacityRps(svc);
  if (cap === 0) return svc.currentRps > 0 ? 999 : 0;
  return (svc.currentRps / cap) * 100;
}

/**
 * p95 latency in ms = time to be served + time spent WAITING IN THE QUEUE.
 *
 * Service time: a real queueing system gets slow *non-linearly*: fine at 50% load,
 * painful at 90%, awful past 100%. We model that with 1/(1-u):
 *   util 50% -> ~2x base latency, 90% -> ~10x, >=97% -> clamped (saturated).
 *
 * Queue time: a request that sat in line for N ticks waited about N seconds (a
 * tick is one second of traffic). The oldest waiter approximates the tail (p95).
 * This is the price of a queue: fewer errors, but slower answers.
 */
export function p95LatencyMs(svc: Service): number {
  const BASE_MS = 40;
  // The tail is set by the WORST instance, not the average: if one instance is
  // overloaded or slow, the unlucky requests it serves define p95. With evenly
  // loaded identical instances this equals the fleet-wide figure.
  // A dead instance answers nothing (its requests fail fast), so it has no latency
  // to report; only instances that actually respond count toward the tail.
  const serving = servingInstances(svc.instances).filter(
    (i) => i.fault !== "crash" && i.fault !== "oom",
  );
  let serviceMs: number;
  if (serving.length === 0) {
    serviceMs = 1500; // nothing is serving: report the saturated figure
  } else {
    serviceMs = Math.max(
      ...serving.map((i) => {
        const u = clamp(i.rps / instanceCapacityRps(i, svc.autoscale.rpsPerInstance), 0, 0.97);
        return (BASE_MS * (i.latencyFactor ?? 1)) / (1 - u);
      }),
    );
    serviceMs = clamp(serviceMs, BASE_MS, 1500);
  }
  const queueMs = (svc.queue.oldestAge ?? 0) * 1000;
  return Math.round(clamp(serviceMs + queueMs, BASE_MS, 10000));
}

/**
 * Error rate %: the share of this tick's requests that FAILED. Overflow the queue
 * is still holding is NOT an error yet: it shows up as latency instead, until it
 * overflows or times out.
 */
export function errorRatePct(svc: Service): number {
  if (svc.currentRps <= 0) return 0;
  const q = svc.queue;
  if (q.rejectedNow === undefined) {
    // A world saved before the queue existed, read before its first tick: use the
    // old rule (everything over capacity fails) so the numbers are still sane.
    const cap = capacityRps(svc);
    if (cap === 0) return 100;
    return clamp((Math.max(0, svc.currentRps - cap) / svc.currentRps) * 100, 0, 100);
  }
  // Everything that failed this tick: refused by a full queue, gave up after retries,
  // sent to a dead/erroring instance, or refused instantly by an open circuit breaker.
  const h = svc.health;
  const failed = q.rejectedNow + (q.failedNow ?? 0) + (h.faultFailedNow ?? 0) + (h.shedNow ?? 0);
  return clamp((failed / svc.currentRps) * 100, 0, 100);
}

/** Estimated spend rate in $/hour for everything that's running (booting too). */
export function costPerHour(svc: Service): number {
  const billable = svc.instances.filter(
    (i) => i.status !== "crashloop" && i.status !== "restarting",
  ).length;
  return Math.round(billable * svc.costPerInstanceHr * 100) / 100;
}
