// =============================================================================
// tick.ts  —  Advances the world by one step. THE heart of the simulation.
//
// One tick = one simulated "moment". For each service, in this fixed order:
//
//   1. traffic     : pattern -> desired RPS -> ease current RPS toward it
//   2. lifecycle   : booting instances warm up; draining ones are removed
//   3. distribute  : spread RPS across healthy instances (balancer, checkpoint 2)
//   4. measure     : utilisation, latency, errors, cost  (metrics.ts)
//   5. autoscale   : ask autoscaler.ts how many instances we want, then act
//   6. record      : push a Metric point for the charts, set service status
//
// ORDER MATTERS. Example: we measure *before* scaling so the autoscaler reacts to
// the load it just observed, and new instances start "booting" (not yet serving),
// which is exactly why real autoscaling lags behind a sudden spike.
//
// Later features (healing, queue, scheduler, deployments) each add one step to
// this list. Because every step is its own function, the order is easy to read.
// =============================================================================

import { makeInstance } from "../defaults";
import { decideDesiredCount } from "./autoscaler";
import {
  capacityRps,
  errorRatePct,
  p95LatencyMs,
  servingInstances,
  utilisationPct,
} from "./metrics";
import { normalizeQueue, stepQueue } from "./queue";
import { SPIKE_DURATION_TICKS, desiredRps, easeToward } from "./traffic";
import type { Platform, Service, SimEvent } from "./types";

const MAX_EVENTS = 200; // keep the global log bounded
const MAX_HISTORY = 120; // ~2 minutes of chart data at 1 tick/sec
const MAX_CATCHUP_TICKS = 300; // never simulate more than this in one request

// ----------------------------------------------------------------------------
// Tick-on-read: figure out how many ticks have "happened" since we last looked.
//
// Vercel has no background loop, so time only moves when someone polls. We
// convert elapsed wall-clock seconds into ticks (times the speed multiplier)
// and run that many steps. If nobody polled for an hour we cap the catch-up so
// a single request can't run forever.
// ----------------------------------------------------------------------------
export function advance(p: Platform, now: number = Date.now()): Platform {
  const elapsedSec = Math.floor((now - p.lastTickAt) / 1000);
  if (elapsedSec <= 0) return p;

  const ticks = Math.min(elapsedSec * p.speed, MAX_CATCHUP_TICKS);
  p.lastTickAt += elapsedSec * 1000; // consume only whole seconds; keep the remainder

  for (let i = 0; i < ticks; i++) tickOnce(p);
  return p;
}

/** Append an event to the global log (newest first, capped). */
export function log(
  p: Platform,
  service: string,
  level: SimEvent["level"],
  msg: string,
  kind?: SimEvent["kind"], // "status" = a health change worth a pop-up; omit for log-only
): void {
  p.events.unshift({ t: p.tick, service, level, msg, ...(kind ? { kind } : {}) });
  if (p.events.length > MAX_EVENTS) p.events.length = MAX_EVENTS;
}

/** One full step of the whole platform. */
export function tickOnce(p: Platform): void {
  p.tick += 1;
  // 1 tick = 1 simulated minute, so a whole day is 1440 ticks (24s at 60x speed).
  p.clockMinutes = (p.clockMinutes + 1) % 1440;
  for (const svc of p.services) tickService(p, svc);
}

// ----------------------------------------------------------------------------
// Service health: ONE status per service, and ONE notification per change.
//
// A monitoring system that pages you for every metric is a monitoring system you
// learn to ignore. So instead of one alert per symptom (error rate, latency, load)
// we boil everything down to a single traffic-light status:
//
//   ok       (green)  : healthy
//   warning  (yellow) : under strain, but users are not failing yet
//   critical (red)    : users are seeing errors
//
// and write exactly ONE event when that status CHANGES. Those events carry
// kind:"status", which is what the UI turns into a pop-up. Everything else
// (scale-ups, instance added/removed...) stays in the event log but is silent.
//
// HYSTERESIS: the bar to ENTER a state is higher than the bar to LEAVE it, so a
// metric hovering right at a threshold cannot flip the status every tick.
// ----------------------------------------------------------------------------
type Health = NonNullable<Service["alertLevel"]>;

function nextHealth(
  prev: Health,
  errRate: number,
  p95: number,
  util: number,
  scaleUpAt: number,
): Health {
  // Red: enter above 5% errors; once red, stay red until errors fall below 1%.
  if (errRate > 5 || (prev === "critical" && errRate >= 1)) return "critical";

  // Yellow: enter when slow or running hot; once yellow (or just recovering from
  // red), stay until clearly calm: p95 under 300 ms AND 10 points below the
  // scale-up line.
  const hot = p95 > 500 || util > scaleUpAt;
  const stillStrained = p95 >= 300 || util >= scaleUpAt - 10;
  if (hot || (prev !== "ok" && stillStrained)) return "warning";

  return "ok";
}

function evaluateAlerts(
  p: Platform,
  svc: Service,
  errRate: number,
  p95: number,
  util: number,
): void {
  const prev: Health = svc.alertLevel ?? "ok"; // older saved worlds lack this field
  const next = nextHealth(prev, errRate, p95, util, svc.autoscale.scaleUpAt);
  if (next === prev) return; // no change -> no notification

  svc.alertLevel = next;
  const healthy = servingInstances(svc.instances).length;
  const facts = `error rate ${errRate.toFixed(1)}%, p95 ${p95} ms, utilisation ${Math.round(Math.min(util, 999))}%, ${healthy} healthy instance(s)`;

  if (next === "critical") {
    log(p, svc.id, "error", `ALERT: users are seeing failures (${facts}).`, "status");
  } else if (next === "warning") {
    log(
      p,
      svc.id,
      "warn",
      prev === "critical"
        ? `IMPROVING: errors have cleared but the service is still strained (${facts}).`
        : `WARNING: service is under strain (${facts}).`,
      "status",
    );
  } else {
    log(p, svc.id, "info", `RESOLVED: service is healthy again (${facts}).`, "status");
  }
}

function tickService(p: Platform, svc: Service): void {
  // ---- 1. TRAFFIC ----------------------------------------------------------
  svc.patternTick += 1;
  if (svc.pattern === "spike" && svc.patternTick > SPIKE_DURATION_TICKS) {
    svc.pattern = "flat"; // a spike is a one-off burst, then back to normal
    log(p, svc.id, "info", "Traffic spike ended; back to baseline.");
  }
  const desired = desiredRps(svc.pattern, svc.patternTick, svc.targetRps);
  svc.currentRps = easeToward(svc.currentRps, desired);

  // ---- 2. INSTANCE LIFECYCLE ----------------------------------------------
  // Draining instances finished their goodbye tick: now actually remove them.
  svc.instances = svc.instances.filter((i) => {
    if (i.status !== "draining") return true;
    log(p, svc.id, "info", `Instance ${i.id} removed.`);
    return false;
  });

  // Booting instances count down, then join the pool.
  for (const inst of svc.instances) {
    if (inst.status !== "booting") continue;
    inst.bootTicksLeft -= 1;
    if (inst.bootTicksLeft <= 0) {
      inst.status = "healthy";
      log(p, svc.id, "info", `Instance ${inst.id} is healthy and receiving traffic.`);
      log(p, svc.id, "info", "nginx.conf updated: upstream pool changed (reload ok).");
    }
  }

  // ---- 3. DISTRIBUTE -------------------------------------------------------
  // TODO (checkpoint 2): replace this even split with balancer.ts so the LB
  // algorithm (round-robin / least-conn / weighted) decides who gets what.
  const serving = servingInstances(svc.instances);
  for (const inst of svc.instances) {
    inst.rps = 0;
    inst.conns = 0;
  }
  if (serving.length > 0) {
    const share = svc.currentRps / serving.length;
    for (const inst of serving) {
      inst.rps = Math.round(share * 10) / 10;
      inst.conns = Math.round(share * 0.4); // ~0.4s average request duration
    }
  }

  // ---- 3b. QUEUE -----------------------------------------------------------
  // Demand above capacity waits in the queue (or is rejected if it is full);
  // spare capacity drains it. See queue.ts. Runs before we measure, so errors
  // and latency reflect what the queue just did.
  svc.queue = normalizeQueue(svc.queue); // worlds saved before the queue existed
  const before = {
    depth: svc.queue.depth,
    rejecting: svc.queue.rejectedNow > 0,
    failing: svc.queue.failedNow > 0,
  };
  stepQueue(svc.queue, {
    tick: p.tick,
    demandRps: svc.currentRps,
    capacityRps: capacityRps(svc),
  });
  const q = svc.queue;
  // Log only when something CHANGES, not every tick it persists.
  if (q.rejectedNow > 0 && !before.rejecting) {
    log(p, svc.id, "warn", `Queue is full (${q.depth}/${q.capacity}): rejecting requests with HTTP 429.`);
  }
  if (q.failedNow > 0 && !before.failing) {
    log(p, svc.id, "warn", `${q.failedNow} request(s) failed after ${q.maxRetries} retries and moved to the dead-letter queue.`);
  }
  if (q.depth === 0 && before.depth > 0) {
    log(p, svc.id, "info", "Queue drained: no requests waiting.");
  }

  // ---- 4. MEASURE ----------------------------------------------------------
  const util = utilisationPct(svc);

  if (p.tick % 10 === 0) {
    log(
      p,
      svc.id,
      "info",
      `Average utilisation ${Math.round(util)}% across ${serving.length} instance(s) at ${Math.round(svc.currentRps)} req/s.`,
    );
  }

  // ---- 5. AUTOSCALE --------------------------------------------------------
  if (svc.cooldownLeft > 0) svc.cooldownLeft -= 1;

  // "Current" counts instances that are serving OR on their way (booting), so we
  // don't keep ordering more while the last batch is still starting up.
  const current = svc.instances.filter(
    (i) => i.status === "healthy" || i.status === "booting",
  ).length;
  const want = decideDesiredCount(util, current, svc.autoscale, svc.cooldownLeft);

  if (want > current) {
    const add = want - current;
    log(
      p,
      svc.id,
      "warn",
      `High load detected (${Math.round(util)}% utilisation). Scaling up ${current} -> ${want}.`,
    );
    for (let i = 0; i < add; i++) {
      const inst = makeInstance(svc.version, true);
      svc.instances.push(inst);
      log(p, svc.id, "info", `Instance ${inst.id} added (booting).`);
    }
    svc.cooldownLeft = svc.autoscale.cooldownTicks;
  } else if (want < current) {
    const remove = current - want;
    log(
      p,
      svc.id,
      "info",
      `Load is low (${Math.round(util)}% utilisation). Scaling down ${current} -> ${want}.`,
    );
    // Drain the least-busy healthy instances first (least disruption).
    const victims = servingInstances(svc.instances)
      .sort((a, b) => a.rps - b.rps)
      .slice(0, remove);
    for (const v of victims) {
      v.status = "draining";
      log(p, svc.id, "info", `Instance ${v.id} draining (graceful shutdown).`);
    }
    svc.cooldownLeft = svc.autoscale.cooldownTicks;
  }

  // ---- 6. ALERT + RECORD ---------------------------------------------------
  const errRate = errorRatePct(svc);
  const p95 = p95LatencyMs(svc);
  svc.status = errRate > 5 || util > 100 ? "degraded" : "live";
  evaluateAlerts(p, svc, errRate, p95, util);
  svc.metricsHistory.push({
    t: p.tick,
    rps: Math.round(svc.currentRps),
    util: Math.round(Math.min(util, 300)),
    p95,
    errRate: Math.round(errRate * 10) / 10,
    instances: servingInstances(svc.instances).length,
    queueDepth: svc.queue.depth,
    queueServed: svc.queue.servedNow,
    queueRejected: svc.queue.rejectedNow,
  });
  if (svc.metricsHistory.length > MAX_HISTORY) {
    svc.metricsHistory.splice(0, svc.metricsHistory.length - MAX_HISTORY);
  }
}
