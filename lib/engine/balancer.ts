// =============================================================================
// balancer.ts  —  How the load balancer (nginx) splits traffic across instances.
//
// With identical, healthy instances every algorithm gives the same even split, so
// the choice looks like it does not matter. It matters as soon as instances DIFFER,
// which is why instances have a size (weight) and can be slow (latencyFactor):
//
//   round-robin  : "deal requests like cards". Equal COUNT per instance. Ignores
//                  size and speed, so a small instance gets as much as a large one
//                  and gets overloaded while the large one idles. Simple and fair
//                  only when every instance is the same.
//
//   weighted     : share proportional to SIZE. A 2x instance gets twice the traffic.
//                  Fixes the size problem, but still blind to a slow instance.
//
//   least-conn   : send each request to the instance with the FEWEST ACTIVE
//                  connections per unit of size. A slow instance holds every
//                  connection longer, so it accumulates connections and is
//                  automatically given less. Adapts to size AND slowness.
//
// This runs once per tick. It only decides how many req/s each instance is ASSIGNED
// (inst.rps) and how many connections that implies (inst.conns). Whether an
// instance can actually serve its share is decided afterwards (see tick.ts).
// =============================================================================

import { instanceCapacityRps } from "./metrics";
import type { Instance, LbAlgo } from "./types";

/** Seconds a request takes at 50% load; the base for the connection estimate. */
const BASE_SERVICE_SECONDS = 0.2;

const slowness = (i: Instance) => i.latencyFactor ?? 1;
const size = (i: Instance) => Math.max(1, i.weight || 1);

export function distributeTraffic(
  serving: Instance[],
  totalRps: number,
  algo: LbAlgo,
  rpsPerInstance: number,
): void {
  if (serving.length === 0) return;
  const total = Math.max(0, totalRps);

  const shares = computeShares(serving, total, algo, rpsPerInstance);

  for (let k = 0; k < serving.length; k++) {
    const inst = serving[k];
    inst.rps = Math.round(shares[k] * 10) / 10;

    // Active connections by Little's law: connections = arrival rate x time each
    // request takes. Time grows as the instance fills up (1/(1-u)) and with its
    // slowness. This is also what least-conn "sees", so the displayed number and
    // the balancing decision agree.
    const u = Math.min(0.95, inst.rps / instanceCapacityRps(inst, rpsPerInstance));
    inst.conns = Math.round((inst.rps * BASE_SERVICE_SECONDS * slowness(inst)) / (1 - u));
  }
}

/** The req/s assigned to each instance, in the same order as `serving`. */
function computeShares(
  serving: Instance[],
  total: number,
  algo: LbAlgo,
  rpsPerInstance: number,
): number[] {
  const n = serving.length;
  const sizes = serving.map(size);
  const sumSize = sizes.reduce((a, b) => a + b, 0);

  // ---- round-robin: equal count, blind to everything ---------------------------
  if (algo === "round-robin") return serving.map(() => total / n);

  // ---- weighted: proportional to size ------------------------------------------
  const bySize = sizes.map((s) => (total * s) / sumSize);
  if (algo === "weighted") return bySize;

  // ---- least-conn --------------------------------------------------------------
  // Equilibrium: every instance ends up with the same connections per unit of size.
  //   connections_i = rps_i * T_i,   T_i = slowness_i / (1 - u_i),   u_i = rps_i / cap_i
  // Setting connections_i / size_i equal for all i works out to
  //   u_i / (1 - u_i) = c / slowness_i      =>   u_i = c / (c + slowness_i)
  // for one shared constant c. A slower instance (bigger slowness) gets a smaller u,
  // i.e. less traffic. We find the c where the assigned traffic adds up to `total`.
  const caps = serving.map((i) => instanceCapacityRps(i, rpsPerInstance));
  const fleetCap = caps.reduce((a, b) => a + b, 0);

  // Demand at or above the fleet's capacity: every instance is saturated, so
  // there is nothing to steer around; fall back to a size-proportional split.
  if (total >= fleetCap) return bySize;

  const assigned = (c: number) =>
    serving.reduce((sum, i, k) => sum + (caps[k] * c) / (c + slowness(i)), 0);

  // `assigned` rises smoothly from 0 to fleetCap as c grows, so bisect for the c
  // that hits `total`.
  let lo = 0;
  let hi = 1;
  while (assigned(hi) < total && hi < 1e9) hi *= 2;
  for (let step = 0; step < 50; step++) {
    const mid = (lo + hi) / 2;
    if (assigned(mid) < total) lo = mid;
    else hi = mid;
  }
  const c = (lo + hi) / 2;
  return serving.map((i, k) => (caps[k] * c) / (c + slowness(i)));
}
