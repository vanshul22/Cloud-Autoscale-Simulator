// =============================================================================
// alerts.ts  —  Alert rules and SLOs: deciding WHEN a human should be told.
//
// Two ideas that real on-call teams live by:
//
// 1. ALERTS NEED A "FOR" CLAUSE. "p95 > 500 ms" is true for one unlucky tick all the
//    time; paging someone for that teaches them to ignore pages. A rule therefore has
//    to hold for N ticks in a row before it FIRES. Until then it is merely PENDING.
//    When the condition clears, the alert RESOLVES. Each of those is one event.
//
// 2. SLOs AND ERROR BUDGETS. Instead of "never fail", you promise "99.5% of requests
//    succeed". The remaining 0.5% is your ERROR BUDGET: failures you can afford. The
//    BURN RATE says how fast you are spending it (1 = exactly on budget, 10 = the
//    whole budget gone in a tenth of the window). Alerting on burn rate means you act
//    when users are being hurt faster than you can afford, not on every blip.
//
// Everything here is plain data in the world (rules, firing alerts, a small rolling
// request log), so it survives restarts and is shared by every viewer.
// =============================================================================

import type {
  AlertMetric,
  AlertRecord,
  AlertRule,
  AlertState,
  Platform,
  Service,
  Slo,
} from "./types";

type Emit = (serviceId: string, level: "info" | "warn" | "error", msg: string) => void;

const BUCKETS = 60; // 60 buckets...
const BUCKET_TICKS = 10; // ...of 10 ticks each = a 600-tick rolling window
const RECENT_BUCKETS = 6; // burn rate looks at the last 60 ticks
const MAX_HISTORY = 20;
export const MAX_ALERT_RULES = 12;

// ---- defaults -------------------------------------------------------------------
export function defaultAlertRules(): AlertRule[] {
  const r = (
    id: string,
    name: string,
    metric: AlertMetric,
    op: ">" | "<",
    threshold: number,
    forTicks: number,
    severity: "warning" | "critical",
  ): AlertRule => ({ id, name, metric, op, threshold, forTicks, severity, serviceId: "*", enabled: true });
  return [
    r("r-errors", "High error rate", "errRate", ">", 5, 3, "critical"),
    r("r-latency", "Slow responses", "p95", ">", 500, 5, "warning"),
    r("r-capacity", "Capacity nearly full", "utilisation", ">", 85, 5, "warning"),
    r("r-crashloop", "Instance crash-looping", "crashLoops", ">", 0, 1, "critical"),
    r("r-queue", "Queue backing up", "queueDepth", ">", 200, 3, "warning"),
    r("r-budget", "Error budget burning fast", "burnRate", ">", 2, 5, "warning"),
  ];
}

export function defaultSlo(): Slo {
  return {
    target: 99.5,
    log: { total: new Array(BUCKETS).fill(0), failed: new Array(BUCKETS).fill(0), id: new Array(BUCKETS).fill(-1) },
  };
}

/** Fill in alerting state for worlds saved before this feature existed. */
export function normalizeAlerts(p: Platform): void {
  p.alertRules ??= defaultAlertRules();
  p.alerts ??= [];
  p.alertHistory ??= [];
}

// ---- the SLO --------------------------------------------------------------------
/** Add one tick's requests to the rolling log. */
export function recordSlo(svc: Service, tick: number, total: number, failed: number): void {
  const slo = (svc.slo ??= defaultSlo());
  const bucket = Math.floor(tick / BUCKET_TICKS);
  const slot = bucket % BUCKETS;
  if (slo.log.id[slot] !== bucket) {
    // This slot still holds an old period: start it afresh.
    slo.log.id[slot] = bucket;
    slo.log.total[slot] = 0;
    slo.log.failed[slot] = 0;
  }
  slo.log.total[slot] += total;
  slo.log.failed[slot] += failed;
}

export interface SloSummary {
  target: number; // the promise, in %
  availability: number; // what we delivered over the window, in %
  windowRequests: number;
  failedRequests: number;
  allowedFailures: number; // the error budget in requests: (1 - target) x requests
  budgetRemainingPct: number; // 100 = untouched, 0 = spent
  burnRate: number; // recent failure rate / allowed failure rate (1 = on budget)
  ticksToExhaust: number | null; // at the current burn, ticks until the budget is spent
  met: boolean; // is availability currently at or above the target?
}

export function sloSummary(svc: Service, tick: number): SloSummary {
  const slo = svc.slo ?? defaultSlo();
  const now = Math.floor(tick / BUCKET_TICKS);
  let total = 0;
  let failed = 0;
  let recentTotal = 0;
  let recentFailed = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const age = now - slo.log.id[i]; // how many buckets ago this slot's period was
    if (slo.log.id[i] < 0 || age < 0 || age >= BUCKETS) continue; // empty or stale
    total += slo.log.total[i];
    failed += slo.log.failed[i];
    if (age < RECENT_BUCKETS) {
      recentTotal += slo.log.total[i];
      recentFailed += slo.log.failed[i];
    }
  }
  const allowedFrac = Math.max(1e-9, 1 - slo.target / 100); // e.g. 0.005
  const allowed = total * allowedFrac;
  const availability = total > 0 ? 100 * (1 - failed / total) : 100;
  const budgetRemainingPct = allowed > 0 ? Math.max(0, Math.min(100, (1 - failed / allowed) * 100)) : 100;
  const burnRate = recentTotal > 0 ? recentFailed / recentTotal / allowedFrac : 0;
  const failuresPerTick = recentFailed / (RECENT_BUCKETS * BUCKET_TICKS);
  const leftToSpend = Math.max(0, allowed - failed);
  const ticksToExhaust = burnRate > 1 && failuresPerTick > 0 ? Math.round(leftToSpend / failuresPerTick) : null;
  return {
    target: slo.target,
    availability,
    windowRequests: Math.round(total),
    failedRequests: Math.round(failed),
    allowedFailures: Math.round(allowed),
    budgetRemainingPct,
    burnRate,
    ticksToExhaust,
    met: availability >= slo.target,
  };
}

// ---- reading the numbers a rule can watch -----------------------------------------
export function readMetric(svc: Service, metric: AlertMetric, tick: number): number {
  const m = svc.metricsHistory.at(-1);
  switch (metric) {
    case "p95":
      return m?.p95 ?? 0;
    case "errRate":
      return m?.errRate ?? 0;
    case "utilisation":
      return m?.util ?? 0;
    case "queueDepth":
      return svc.queue.depth ?? 0;
    case "healthyInstances":
      return m?.instances ?? 0;
    case "crashLoops":
      return svc.instances.filter((i) => i.status === "crashloop").length;
    case "burnRate":
      return sloSummary(svc, tick).burnRate;
  }
}

const METRIC_LABEL: Record<AlertMetric, { label: string; unit: string }> = {
  p95: { label: "p95 latency", unit: " ms" },
  errRate: { label: "error rate", unit: "%" },
  utilisation: { label: "utilisation", unit: "%" },
  queueDepth: { label: "queue depth", unit: " requests" },
  healthyInstances: { label: "healthy instances", unit: "" },
  crashLoops: { label: "crash-looping instances", unit: "" },
  burnRate: { label: "error-budget burn rate", unit: "x" },
};
export const metricLabel = (m: AlertMetric) => METRIC_LABEL[m];

/** "error rate > 5% for 3 ticks": the rule in plain English. */
export function describeRule(r: AlertRule): string {
  const { label, unit } = METRIC_LABEL[r.metric];
  return `${label} ${r.op} ${r.threshold}${unit} for ${r.forTicks} tick${r.forTicks === 1 ? "" : "s"}`;
}

// ---- running the rules each tick --------------------------------------------------
/**
 * Evaluate every enabled rule against every service in scope and move alerts through
 * their life: pending -> firing -> resolved. Called once per tick after all services
 * have been simulated. Each change of state writes ONE event.
 */
export function evaluateAlerts(p: Platform, emit: Emit): void {
  normalizeAlerts(p);
  const rules = p.alertRules!;
  const alerts = p.alerts!;
  const live = new Set<string>(); // alert ids whose rule and service still exist

  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const svc of p.services) {
      if (rule.serviceId !== "*" && rule.serviceId !== svc.id) continue;
      const id = `${rule.id}:${svc.id}`;
      live.add(id);
      const value = readMetric(svc, rule.metric, p.tick);
      const holds = rule.op === ">" ? value > rule.threshold : value < rule.threshold;
      const existing = alerts.find((a) => a.id === id);

      if (holds) {
        if (!existing) {
          const a: AlertState = { id, ruleId: rule.id, serviceId: svc.id, state: "pending", since: p.tick, value };
          alerts.push(a);
          maybeFire(p, a, rule, svc, emit);
        } else {
          existing.value = value;
          if (existing.state === "pending") maybeFire(p, existing, rule, svc, emit);
          else existing.peak = pickWorse(rule, existing.peak, value);
        }
      } else if (existing) {
        if (existing.state === "firing") resolve(p, existing, rule, svc, emit, value);
        alerts.splice(alerts.indexOf(existing), 1); // pending (never fired) just disappears
      }
    }
  }
  // A rule that was deleted or disabled, or a service that was shut down, leaves no zombie alerts.
  p.alerts = alerts.filter((a) => live.has(a.id));
}

/** Pending long enough? Then it fires. */
function maybeFire(p: Platform, a: AlertState, rule: AlertRule, svc: Service, emit: Emit): void {
  if (p.tick - a.since + 1 < rule.forTicks) return; // not long enough yet
  a.state = "firing";
  a.firedAt = p.tick;
  a.peak = a.value;
  emit(
    svc.id,
    rule.severity === "critical" ? "error" : "warn",
    `ALERT (${rule.severity}) ${rule.name} on ${svc.name}: ${describeRule(rule)}. Now ${fmt(a.value)}${METRIC_LABEL[rule.metric].unit}.`,
  );
}

function resolve(p: Platform, a: AlertState, rule: AlertRule, svc: Service, emit: Emit, value: number): void {
  const rec: AlertRecord = {
    ruleName: rule.name,
    serviceId: svc.id,
    severity: rule.severity,
    firedAt: a.firedAt ?? a.since,
    resolvedAt: p.tick,
    peak: a.peak ?? a.value,
  };
  (p.alertHistory ??= []).unshift(rec);
  p.alertHistory.length = Math.min(p.alertHistory.length, MAX_HISTORY);
  emit(
    svc.id,
    "info",
    `RESOLVED ${rule.name} on ${svc.name} after ${p.tick - rec.firedAt} ticks (peak ${fmt(rec.peak)}${METRIC_LABEL[rule.metric].unit}; now ${fmt(value)}).`,
  );
}

// "Worse" means higher for a ">" rule and lower for a "<" rule.
const pickWorse = (rule: AlertRule, a: number | undefined, b: number) =>
  a === undefined ? b : rule.op === ">" ? Math.max(a, b) : Math.min(a, b);

const fmt = (n: number) => (Math.abs(n) >= 100 ? String(Math.round(n)) : n.toFixed(1));
