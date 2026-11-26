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
import { distributeTraffic } from "./balancer";
import { evaluateAlerts as evaluateAlertRules, recordSlo } from "./alerts";
import { stepDeployment } from "./deploy";
import { admitFraction, faultFailures, instanceFailures, normalizeHealth, stepHealth } from "./healing";
import {
  capacityRps,
  errorRatePct,
  instanceCapacityRps,
  p95LatencyMs,
  servingInstances,
  utilisationPct,
} from "./metrics";
import { normalizeQueue, stepQueue } from "./queue";
import { effectiveBounds } from "./scheduler";
import { SPIKE_DURATION_TICKS, desiredRps, easeToward } from "./traffic";
import type { Instance, Platform, Service, SimEvent } from "./types";

// Keep the global log bounded. The whole world is saved to Redis on every tick, so
// every event costs bandwidth on the free plan; 120 is plenty to read back through.
const MAX_EVENTS = 120;
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
  // Alert rules look at every service's fresh numbers, so they run after all of them.
  evaluateAlertRules(p, (serviceId, level, msg) => log(p, serviceId, level, msg, "alert"));
}

// ----------------------------------------------------------------------------
// Split the incoming traffic across the serving instances.
//
// Normally the load balancer (balancer.ts) shares it across everything. During a
// CANARY deployment, though, the new version gets a fixed SHARE of the traffic
// (10%, then 50%...) no matter how many instances it has, and the old version gets
// the rest. That is what limits the blast radius of a bad release.
// ----------------------------------------------------------------------------
function routeTraffic(svc: Service, serving: Instance[], total: number): void {
  const { lb, rpsPerInstance } = svc.autoscale;
  const d = svc.deployment;
  if (!d || d.strategy !== "canary" || d.rollingBack) {
    distributeTraffic(serving, total, lb, rpsPerInstance);
    return;
  }
  const canary = serving.filter((i) => i.version === d.toVersion);
  const stable = serving.filter((i) => i.version !== d.toVersion);
  // Until a canary instance is actually serving, everything goes to the stable fleet.
  const share = canary.length === 0 ? 0 : stable.length === 0 ? 1 : d.trafficPctToNew / 100;
  distributeTraffic(canary, total * share, lb, rpsPerInstance);
  distributeTraffic(stable, total * (1 - share), lb, rpsPerInstance);
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
  const desired = desiredRps(svc.pattern, svc.patternTick, svc.targetRps, p.clockMinutes);
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

  // ---- 2b. HEALTH ----------------------------------------------------------
  // Health checks, restarts with backoff, crash loops and the circuit breaker
  // (healing.ts). Runs BEFORE distribution so a pulled-out instance gets no
  // traffic this tick, and a circuit breaker that just opened sheds it at once.
  svc.health = normalizeHealth(svc.health); // worlds saved before this feature
  stepHealth(svc, (level, msg) => log(p, svc.id, level, msg, "health"));
  const admit = admitFraction(svc.health); // 1 = all traffic, 0 = breaker open

  // ---- 2c. DEPLOYMENT ------------------------------------------------------
  // A rollout in progress (deploy.ts): start batches, check the health gate,
  // promote or roll back. Also finishes bringing a brand-new service live.
  stepDeployment(svc, p.tick, (level, msg) => log(p, svc.id, level, msg, "deploy"));
  if (svc.provisioning && svc.instances.length > 0 && svc.instances.every((i) => i.status === "healthy")) {
    svc.provisioning = false;
    log(p, svc.id, "info", `${svc.name} is live at https://${svc.domain}.`, "status");
  }

  // ---- 3. DISTRIBUTE -------------------------------------------------------
  // The load balancer decides how much each healthy instance is ASSIGNED
  // (balancer.ts). An instance can be assigned more than it can serve; that
  // excess is what the queue below has to deal with. A dead instance that health
  // checks haven't caught yet is still "healthy" here, so it still gets traffic.
  const serving = servingInstances(svc.instances);
  for (const inst of svc.instances) {
    inst.rps = 0;
    inst.conns = 0;
  }
  routeTraffic(svc, serving, svc.currentRps * admit);
  // What the instances can really serve directly: each one tops out at its own capacity.
  const servedDirect = serving.reduce(
    (sum, i) => sum + Math.min(i.rps, instanceCapacityRps(i, svc.autoscale.rpsPerInstance)),
    0,
  );

  // Requests that hit a dead or erroring instance, and requests the open circuit
  // breaker refused outright. Both count as failures in the error rate.
  svc.health.faultFailedNow = Math.round(faultFailures(serving, svc.autoscale.rpsPerInstance));
  svc.health.shedNow = Math.round(svc.currentRps * (1 - admit));

  // What the canary's users are experiencing: the failure rate among the requests the
  // NEW version served. This is the health gate's main signal (deploy.ts).
  if (svc.deployment) {
    const mine = serving.filter((i) => i.version === svc.deployment!.toVersion);
    const handled = mine.reduce(
      (s, i) => s + Math.min(i.rps, instanceCapacityRps(i, svc.autoscale.rpsPerInstance)),
      0,
    );
    const failed = mine.reduce((s, i) => s + instanceFailures(i, svc.autoscale.rpsPerInstance), 0);
    svc.deployment.newErrPct = handled > 0 ? (failed / handled) * 100 : 0;
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
    demandRps: svc.currentRps * admit, // the breaker keeps the rest out of the queue
    capacityRps: capacityRps(svc),
    servedRps: servedDirect,
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
  // Scheduled scaling: a schedule window overrides the min/max limits for its hours
  // (scheduler.ts). The reactive autoscaler then works inside those limits.
  const bounds = effectiveBounds(svc.schedules, p.clockMinutes, svc.autoscale);
  const prev = svc.scheduleState ?? { id: null, phase: "off" as const };
  const nowId = bounds.source?.id ?? null;
  if (nowId !== prev.id || bounds.phase !== prev.phase) {
    if (bounds.source) {
      const what = bounds.phase === "prewarm" ? "pre-warming for" : "started:";
      log(
        p,
        svc.id,
        "info",
        `Schedule ${what} "${bounds.source.note || "window"}": instances limited to ${bounds.min}-${bounds.max} (normally ${svc.autoscale.min}-${svc.autoscale.max}).`,
      );
    } else if (prev.id) {
      log(p, svc.id, "info", `Schedule window ended: back to the normal ${svc.autoscale.min}-${svc.autoscale.max} instance limits.`);
    }
    svc.scheduleState = { id: nowId, phase: bounds.phase };
  }
  const limits = { ...svc.autoscale, min: bounds.min, max: bounds.max };

  // Autoscaling can be switched off ("hands off"): then you size the fleet yourself.
  // The autoscaler also pauses during a deployment: it would otherwise see the
  // temporary extra instances and fight the rollout.
  const want =
    svc.autoscale.enabled === false || svc.deployment
      ? current
      : decideDesiredCount(util, current, limits, svc.cooldownLeft);

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
    // Drain the SMALLEST instances first (a large one carries more load), and among
    // equals the least busy one (least disruption).
    const victims = servingInstances(svc.instances)
      .sort((a, b) => (a.weight || 1) - (b.weight || 1) || a.rps - b.rps)
      .slice(0, remove);
    for (const v of victims) {
      v.status = "draining";
      log(p, svc.id, "info", `Instance ${v.id} draining (graceful shutdown).`);
    }
    svc.cooldownLeft = svc.autoscale.cooldownTicks;
  }

  // ---- 6. ALERT + RECORD ---------------------------------------------------
  const errRate = errorRatePct(svc);
  // What the circuit breaker watches next tick: the failure rate among requests
  // that were actually ADMITTED (otherwise an open breaker would always read 100%).
  const admitted = svc.currentRps * admit;
  svc.health.lastErrRate =
    admitted > 0
      ? Math.min(100, ((q.rejectedNow + q.failedNow + (svc.health.faultFailedNow ?? 0)) / admitted) * 100)
      : 0;
  const p95 = p95LatencyMs(svc);
  svc.status =
    errRate > 5 || util > 100 ? "degraded" : svc.deployment || svc.provisioning ? "deploying" : "live";
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

  // Remember what this minute of the day looked like (planned vs actual 24h view).
  // Created on first use, so worlds saved before this feature simply start filling it.
  const day = (svc.dayLog ??= {
    instances: new Array(1440).fill(-1),
    rps: new Array(1440).fill(-1),
  });
  day.instances[p.clockMinutes] = servingInstances(svc.instances).length;
  day.rps[p.clockMinutes] = Math.round(svc.currentRps);

  // The SLO's rolling log: how many requests there were, and how many failed.
  recordSlo(svc, p.tick, svc.currentRps, (errRate / 100) * svc.currentRps);
}
