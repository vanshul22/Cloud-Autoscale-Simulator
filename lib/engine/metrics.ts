// =============================================================================
// metrics.ts  —  Derives the numbers an operator would watch on a dashboard.
//
// Nothing here changes the world; these are pure functions of the current
// state. Keeping "measure" separate from "decide" (autoscaler) and "act" (tick)
// makes each piece easy to test and to explain.
// =============================================================================

import { clamp } from "./ids";
import type { Instance, Service } from "./types";

/** Instances that are actually allowed to receive traffic. */
export function servingInstances(instances: Instance[]): Instance[] {
  return instances.filter((i) => i.status === "healthy");
}

/** Total RPS the healthy fleet can absorb before it starts to saturate. */
export function capacityRps(svc: Service): number {
  return servingInstances(svc.instances).length * svc.autoscale.rpsPerInstance;
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
 * p95 latency in ms. A real queueing system gets slow *non-linearly*: fine at
 * 50% load, painful at 90%, awful past 100%. We model that with 1/(1-u):
 *   util 50% -> ~2x base latency, 90% -> ~10x, >=97% -> clamped (saturated).
 */
export function p95LatencyMs(svc: Service): number {
  const BASE_MS = 40;
  const u = clamp(utilisationPct(svc) / 100, 0, 0.97);
  const ms = BASE_MS / (1 - u);
  return Math.round(clamp(ms, BASE_MS, 5000));
}

/**
 * Error rate %. When demand exceeds capacity the excess can't be served; that
 * fraction fails (timeouts/502s). Later the queue will absorb some of it, but
 * for now the excess is simply dropped.
 */
export function errorRatePct(svc: Service): number {
  const cap = capacityRps(svc);
  if (svc.currentRps <= 0) return 0;
  if (cap === 0) return 100;
  const excess = Math.max(0, svc.currentRps - cap);
  return clamp((excess / svc.currentRps) * 100, 0, 100);
}

/** Estimated spend rate in $/hour for everything that's running (booting too). */
export function costPerHour(svc: Service): number {
  const billable = svc.instances.filter(
    (i) => i.status !== "crashloop" && i.status !== "restarting",
  ).length;
  return Math.round(billable * svc.costPerInstanceHr * 100) / 100;
}
