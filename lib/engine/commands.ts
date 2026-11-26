// =============================================================================
// commands.ts  —  Every way the UI is allowed to change the world.
//
// The browser never edits the Platform directly. It POSTs a `Command` to
// /api/control; the server calls `applyCommand`, which validates the input,
// mutates the world, and logs an event. One chokepoint = one place to validate,
// one place to log, and a clear list of "what can a user do" for the UI to bind.
//
// Add a new variant to `Command` + a case in `applyCommand` for every new
// control (chaos, deploy, schedule ...). TypeScript's exhaustiveness check at the
// bottom of the switch will tell you if you forget one.
// =============================================================================

import { makeInstance, makeService } from "../defaults";
import { MAX_ALERT_RULES, defaultAlertRules, defaultSlo, describeRule, normalizeAlerts } from "./alerts";
import { promote, rollbackNow, startDeploy } from "./deploy";
import { clearFault as clearInstanceFault, normalizeHealth } from "./healing";
import { clamp, shortId } from "./ids";
import { normalizeQueue } from "./queue";
import { formatMinute } from "./scheduler";
import { log } from "./tick";
import type {
  AlertMetric,
  AlertRule,
  AutoscaleConfig,
  BadRelease,
  DeployStrategy,
  HealthConfig,
  Instance,
  LbAlgo,
  Pattern,
  Platform,
  QueueState,
  Schedule,
  Service,
} from "./types";

export type Command =
  | { type: "setTraffic"; serviceId: string; rps: number } // move the base-load slider
  | { type: "adjustTraffic"; serviceId: string; delta: number } // +/- buttons
  | { type: "stopTraffic"; serviceId: string } // base load -> 0, pattern -> flat
  | { type: "setPattern"; serviceId: string; pattern: Pattern }
  | { type: "setSpeed"; speed: 1 | 5 | 60 }
  | {
      type: "updateAutoscale";
      serviceId: string;
      patch: Partial<Omit<AutoscaleConfig, "lb">> & { lb?: LbAlgo };
    }
  | {
      type: "updateQueue";
      serviceId: string;
      patch: Partial<Pick<QueueState, "capacity" | "maxWaitTicks" | "maxRetries" | "retryBackoffTicks">>;
    }
  | { type: "addInstance"; serviceId: string; size: number } // size 1 = standard, 2 = large...
  | { type: "removeInstance"; serviceId: string; instanceId: string } // graceful drain
  | {
      type: "injectFault"; // chaos: break one running instance
      serviceId: string;
      instanceId: string;
      fault: "crash" | "oom" | "latency" | "errors";
      severity?: number; // latency: how many times slower (2-20); errors: share failing (0.1-1)
    }
  | { type: "clearFault"; serviceId: string; instanceId: string } // undo latency/error faults
  | { type: "chaos"; serviceId: string; action: "killRandom" | "killHalf" }
  | {
      type: "updateHealth";
      serviceId: string;
      patch: Partial<
        Pick<
          HealthConfig,
          | "restartBackoffTicks"
          | "maxRestarts"
          | "errorRateToTrip"
          | "checkFailuresToEject"
          | "readinessLatencyFactor"
          | "faultDurationTicks"
          | "circuitEnabled"
          | "circuitOpenTicks"
        >
      >;
    }
  | {
      type: "addSchedule";
      serviceId: string;
      schedule: Pick<Schedule, "fromMin" | "toMin" | "min" | "max" | "note" | "prewarmMin">;
    }
  | {
      type: "updateSchedule";
      serviceId: string;
      scheduleId: string;
      patch: Partial<Pick<Schedule, "fromMin" | "toMin" | "min" | "max" | "note" | "prewarmMin" | "enabled">>;
    }
  | { type: "removeSchedule"; serviceId: string; scheduleId: string }
  | { type: "moveSchedule"; serviceId: string; scheduleId: string; direction: "up" | "down" } // list order = priority
  | { type: "setClock"; minutes: number } // jump the simulated clock (0..1439) to watch a window open
  | {
      type: "startDeploy"; // ship the next version with a strategy
      serviceId: string;
      strategy: DeployStrategy;
      toVersion?: string; // omit for the next version; set e.g. "v1" to revert to an earlier one
      bad?: BadRelease; // simulate a faulty release to see how the strategy copes
      stepPct?: number; // rolling: batch size as % of the fleet
      holdTicks?: number; // canary: how long to watch each step
      autoPromote?: boolean; // false = pause for approval at each gate
      autoRollback?: boolean; // true = a failed health gate rolls back by itself
    }
  | { type: "promoteDeploy"; serviceId: string } // pass the current gate (cutover / widen the canary)
  | { type: "rollbackDeploy"; serviceId: string }
  | { type: "createService"; name: string; domain: string; instances: number } // go live with a new service
  | { type: "deleteService"; serviceId: string }
  | { type: "addAlertRule"; rule: Omit<AlertRule, "id" | "enabled"> }
  | {
      type: "updateAlertRule";
      ruleId: string;
      patch: Partial<Pick<AlertRule, "name" | "threshold" | "forTicks" | "severity" | "enabled" | "op" | "metric" | "serviceId">>;
    }
  | { type: "removeAlertRule"; ruleId: string }
  | { type: "resetAlertRules" } // restore the built-in rules
  | { type: "ackAlert"; alertId: string } // "I'm on it": marks a firing alert acknowledged
  | { type: "updateSlo"; serviceId: string; target: number } // availability promise, in %
  | { type: "replayDlq"; serviceId: string } // put dead-lettered requests back in line
  | { type: "purgeDlq"; serviceId: string } // discard dead-lettered requests
  | { type: "reset" };

export const MAX_RPS = 5000; // hard ceiling so a slider typo can't produce 1e9 RPS
export const MAX_INSTANCES = 30; // hard ceiling on instances per service
export const MAX_SCHEDULES = 8; // hard ceiling on schedule windows per service
export const MAX_SERVICES = 4; // hard ceiling on services in the whole platform
const STRATEGIES: DeployStrategy[] = ["recreate", "rolling", "blue-green", "canary"];
const BAD_RELEASES: BadRelease[] = ["none", "errors", "slow", "crash"];
const PATTERNS: Pattern[] = ["flat", "spike", "ramp", "sine", "noise", "daily"];

const METRICS: AlertMetric[] = ["p95", "errRate", "utilisation", "queueDepth", "healthyInstances", "crashLoops", "burnRate"];

/** Validate and clamp an alert rule so the engine never sees nonsense. */
function cleanRule(p: Platform, r: AlertRule): AlertRule {
  if (!METRICS.includes(r.metric)) throw new Error(`Unknown metric: ${String(r.metric)}`);
  if (r.op !== ">" && r.op !== "<") throw new Error("The comparison must be > or <.");
  if (r.severity !== "warning" && r.severity !== "critical") throw new Error("Severity is warning or critical.");
  const threshold = Number(r.threshold);
  if (!Number.isFinite(threshold)) throw new Error("The threshold must be a number.");
  if (r.serviceId !== "*" && !p.services.some((s) => s.id === r.serviceId)) throw new Error(`Unknown service: ${r.serviceId}`);
  return {
    id: r.id,
    name: String(r.name ?? "").trim().slice(0, 40) || "Alert",
    metric: r.metric,
    op: r.op,
    threshold: Math.max(-1e6, Math.min(1e6, threshold)),
    forTicks: clamp(Math.round(Number(r.forTicks) || 1), 1, 120),
    severity: r.severity,
    serviceId: r.serviceId,
    enabled: r.enabled !== false,
  };
}

/** Validate and clamp a schedule so the engine never sees nonsense. */
function cleanSchedule(s: Schedule): Schedule {
  const min = clamp(Math.round(Number(s.min) || 0), 0, 100);
  const from = clamp(Math.round(Number(s.fromMin) || 0), 0, 1439);
  const to = clamp(Math.round(Number(s.toMin) || 0), 0, 1439);
  if (from === to) throw new Error("A schedule window needs different start and end times.");
  return {
    id: s.id,
    fromMin: from,
    toMin: to,
    min,
    max: clamp(Math.round(Number(s.max) || 0), Math.max(min, 1), 100), // a ceiling can't sit below its floor
    note: String(s.note ?? "").trim().slice(0, 40) || "schedule",
    prewarmMin: clamp(Math.round(Number(s.prewarmMin) || 0), 0, 180),
    enabled: s.enabled === false ? false : true,
  };
}

function find(p: Platform, id: string): Service {
  const svc = p.services.find((s) => s.id === id);
  if (!svc) throw new Error(`Unknown service: ${id}`);
  return svc;
}

/** Apply a chaos fault to one running instance and log it for the Reliability timeline. */
function breakInstance(
  p: Platform,
  svc: Service,
  inst: Instance,
  fault: "crash" | "oom" | "latency" | "errors",
  severity: number | undefined,
  durationTicks: number,
): void {
  inst.fault = fault;
  inst.failedChecks = 0;
  if (fault === "latency") {
    inst.latencyFactor = clamp(severity ?? 5, 2, 20);
    inst.faultTicksLeft = durationTicks;
    log(p, svc.id, "warn", `Chaos: ${inst.id} is now ${inst.latencyFactor}x slower (for ${durationTicks} ticks).`, "health");
  } else if (fault === "errors") {
    inst.errorFraction = clamp(severity ?? 0.6, 0.1, 1);
    inst.faultTicksLeft = durationTicks;
    log(p, svc.id, "warn", `Chaos: ${inst.id} now fails ${Math.round(inst.errorFraction * 100)}% of its requests (for ${durationTicks} ticks).`, "health");
  } else {
    log(p, svc.id, "warn", `Chaos: ${inst.id} ${fault === "oom" ? "was OOM-killed" : "crashed"}.`, "health");
  }
}

/** Mutates `p` in place. Throws Error(message) on invalid input (API maps to 400). */
export function applyCommand(p: Platform, cmd: Command): void {
  switch (cmd.type) {
    case "setTraffic": {
      const svc = find(p, cmd.serviceId);
      svc.targetRps = clamp(Math.round(cmd.rps), 0, MAX_RPS);
      log(p, svc.id, "info", `Traffic set to ${svc.targetRps} req/s.`);
      return;
    }
    case "adjustTraffic": {
      const svc = find(p, cmd.serviceId);
      svc.targetRps = clamp(Math.round(svc.targetRps + cmd.delta), 0, MAX_RPS);
      log(
        p,
        svc.id,
        "info",
        `Traffic ${cmd.delta >= 0 ? "increased" : "decreased"} to ${svc.targetRps} req/s.`,
      );
      return;
    }
    case "stopTraffic": {
      const svc = find(p, cmd.serviceId);
      svc.targetRps = 0;
      svc.pattern = "flat";
      svc.patternTick = 0;
      // "info", not "warn": this is the user's own action, and warnings become
      // pop-ups. Nobody needs a notification for a button they just pressed.
      log(p, svc.id, "info", "Traffic stopped.");
      return;
    }
    case "setPattern": {
      const svc = find(p, cmd.serviceId);
      if (!PATTERNS.includes(cmd.pattern)) throw new Error(`Unknown traffic pattern: ${String(cmd.pattern)}`);
      svc.pattern = cmd.pattern;
      svc.patternTick = 0; // restart the pattern's local clock
      log(p, svc.id, "info", `Traffic pattern: ${cmd.pattern}.`);
      return;
    }
    case "setSpeed": {
      if (![1, 5, 60].includes(cmd.speed)) throw new Error("speed must be 1, 5 or 60");
      p.speed = cmd.speed;
      log(p, "platform", "info", `Simulation speed set to ${cmd.speed}x.`);
      return;
    }
    case "updateAutoscale": {
      const svc = find(p, cmd.serviceId);
      const a = svc.autoscale;
      const { patch } = cmd;
      if (patch.min !== undefined) a.min = clamp(Math.round(patch.min), 0, 100);
      if (patch.max !== undefined) a.max = clamp(Math.round(patch.max), 1, 100);
      if (patch.rpsPerInstance !== undefined)
        a.rpsPerInstance = clamp(Math.round(patch.rpsPerInstance), 1, 10000);
      if (patch.scaleUpAt !== undefined) a.scaleUpAt = clamp(patch.scaleUpAt, 1, 100);
      if (patch.scaleDownAt !== undefined) a.scaleDownAt = clamp(patch.scaleDownAt, 0, 99);
      if (patch.cooldownTicks !== undefined)
        a.cooldownTicks = clamp(Math.round(patch.cooldownTicks), 0, 120);
      if (patch.lb !== undefined) a.lb = patch.lb;
      if (patch.enabled !== undefined) a.enabled = Boolean(patch.enabled);
      // Keep the config self-consistent so the autoscaler never sees nonsense.
      if (a.min > a.max) a.min = a.max;
      if (a.scaleDownAt >= a.scaleUpAt) a.scaleDownAt = Math.max(0, a.scaleUpAt - 1);
      log(p, svc.id, "info", "Autoscaling configuration updated.");
      return;
    }
    case "addInstance": {
      const svc = find(p, cmd.serviceId);
      // A hard ceiling so nobody (or a public visitor) can grow the world forever.
      if (svc.instances.length >= MAX_INSTANCES) {
        throw new Error(`A service can have at most ${MAX_INSTANCES} instances.`);
      }
      const size = clamp(Math.round(cmd.size), 1, 4);
      const inst = makeInstance(svc.version, true); // boots for a few ticks, like any new instance
      inst.weight = size;
      svc.instances.push(inst);
      log(p, svc.id, "info", `Instance ${inst.id} added by hand (${size === 1 ? "standard" : `${size}x`} size, booting).`);
      return;
    }
    case "removeInstance": {
      const svc = find(p, cmd.serviceId);
      const inst = svc.instances.find((i) => i.id === cmd.instanceId);
      if (!inst) throw new Error(`Unknown instance: ${cmd.instanceId}`);
      if (inst.status === "draining") throw new Error("That instance is already draining.");
      inst.status = "draining"; // finishes its goodbye tick, then tick.ts removes it
      log(p, svc.id, "info", `Instance ${inst.id} draining (removed by hand).`);
      return;
    }
    case "injectFault": {
      const svc = find(p, cmd.serviceId);
      const h = (svc.health = normalizeHealth(svc.health));
      const inst = svc.instances.find((i) => i.id === cmd.instanceId);
      if (!inst) throw new Error(`Unknown instance: ${cmd.instanceId}`);
      if (inst.status !== "healthy") throw new Error("Only a running instance can be hit by chaos.");
      if (inst.fault) throw new Error(`${inst.id} already has a ${inst.fault} fault. Clear it first.`);
      breakInstance(p, svc, inst, cmd.fault, cmd.severity, h.faultDurationTicks ?? 40);
      return;
    }
    case "clearFault": {
      const svc = find(p, cmd.serviceId);
      const inst = svc.instances.find((i) => i.id === cmd.instanceId);
      if (!inst) throw new Error(`Unknown instance: ${cmd.instanceId}`);
      if (inst.fault !== "latency" && inst.fault !== "errors") {
        throw new Error("Only slowness or error faults can be cleared. A crashed instance has to be restarted by the platform.");
      }
      clearInstanceFault(inst);
      log(p, svc.id, "info", `Fault on ${inst.id} cleared by hand.`, "health");
      return;
    }
    case "chaos": {
      const svc = find(p, cmd.serviceId);
      const h = (svc.health = normalizeHealth(svc.health));
      const targets = svc.instances.filter((i) => i.status === "healthy" && !i.fault);
      if (targets.length === 0) throw new Error("No healthy instance to hit.");
      // Fisher-Yates-ish shuffle, then take one or half (rounded up).
      const shuffled = [...targets].sort(() => Math.random() - 0.5);
      const hit = cmd.action === "killHalf" ? shuffled.slice(0, Math.ceil(targets.length / 2)) : shuffled.slice(0, 1);
      for (const inst of hit) breakInstance(p, svc, inst, "crash", undefined, h.faultDurationTicks ?? 40);
      return;
    }
    case "updateHealth": {
      const svc = find(p, cmd.serviceId);
      const h = (svc.health = normalizeHealth(svc.health));
      const { patch } = cmd;
      if (patch.restartBackoffTicks !== undefined) h.restartBackoffTicks = clamp(Math.round(patch.restartBackoffTicks), 1, 30);
      if (patch.maxRestarts !== undefined) h.maxRestarts = clamp(Math.round(patch.maxRestarts), 0, 10);
      if (patch.errorRateToTrip !== undefined) h.errorRateToTrip = clamp(Math.round(patch.errorRateToTrip), 1, 100);
      if (patch.checkFailuresToEject !== undefined) h.checkFailuresToEject = clamp(Math.round(patch.checkFailuresToEject), 1, 10);
      if (patch.readinessLatencyFactor !== undefined) h.readinessLatencyFactor = clamp(patch.readinessLatencyFactor, 2, 50);
      if (patch.faultDurationTicks !== undefined) h.faultDurationTicks = clamp(Math.round(patch.faultDurationTicks), 5, 300);
      if (patch.circuitEnabled !== undefined) h.circuitEnabled = Boolean(patch.circuitEnabled);
      if (patch.circuitOpenTicks !== undefined) h.circuitOpenTicks = clamp(Math.round(patch.circuitOpenTicks), 2, 60);
      log(p, svc.id, "info", "Reliability settings updated.", "health");
      return;
    }
    case "addAlertRule": {
      normalizeAlerts(p);
      if (p.alertRules!.length >= MAX_ALERT_RULES) throw new Error(`At most ${MAX_ALERT_RULES} alert rules.`);
      const rule = cleanRule(p, { id: shortId("rule"), enabled: true, ...cmd.rule });
      p.alertRules!.push(rule);
      log(p, "platform", "info", `Alert rule added: ${rule.name} (${describeRule(rule)}).`, "alert");
      return;
    }
    case "updateAlertRule": {
      normalizeAlerts(p);
      const i = p.alertRules!.findIndex((r) => r.id === cmd.ruleId);
      if (i < 0) throw new Error(`Unknown alert rule: ${cmd.ruleId}`);
      p.alertRules![i] = cleanRule(p, { ...p.alertRules![i], ...cmd.patch });
      log(p, "platform", "info", `Alert rule updated: ${p.alertRules![i].name} (${describeRule(p.alertRules![i])}).`, "alert");
      return;
    }
    case "removeAlertRule": {
      normalizeAlerts(p);
      const r = p.alertRules!.find((x) => x.id === cmd.ruleId);
      if (!r) throw new Error(`Unknown alert rule: ${cmd.ruleId}`);
      p.alertRules = p.alertRules!.filter((x) => x.id !== cmd.ruleId);
      log(p, "platform", "info", `Alert rule removed: ${r.name}.`, "alert");
      return;
    }
    case "resetAlertRules": {
      p.alertRules = defaultAlertRules();
      p.alerts = [];
      log(p, "platform", "info", "Alert rules restored to the defaults.", "alert");
      return;
    }
    case "ackAlert": {
      normalizeAlerts(p);
      const a = p.alerts!.find((x) => x.id === cmd.alertId);
      if (!a) throw new Error("That alert is no longer active.");
      if (a.state !== "firing") throw new Error("Only a firing alert can be acknowledged.");
      a.acked = true;
      log(p, a.serviceId, "info", `Alert acknowledged: ${p.alertRules!.find((r) => r.id === a.ruleId)?.name ?? a.ruleId}.`, "alert");
      return;
    }
    case "updateSlo": {
      const svc = find(p, cmd.serviceId);
      const target = Number(cmd.target);
      if (!Number.isFinite(target) || target < 50 || target > 99.999) throw new Error("An SLO target is a percentage between 50 and 99.999.");
      (svc.slo ??= defaultSlo()).target = target;
      log(p, svc.id, "info", `SLO for ${svc.name} set to ${target}% availability.`, "alert");
      return;
    }
    case "startDeploy": {
      const svc = find(p, cmd.serviceId);
      if (!STRATEGIES.includes(cmd.strategy)) throw new Error(`Unknown deployment strategy: ${String(cmd.strategy)}`);
      if (cmd.bad !== undefined && !BAD_RELEASES.includes(cmd.bad)) throw new Error(`Unknown release quality: ${String(cmd.bad)}`);
      if (cmd.toVersion !== undefined) {
        if (!/^v\d{1,3}$/.test(cmd.toVersion)) throw new Error("A version looks like v1, v2, v3...");
        if (cmd.toVersion === svc.version) throw new Error(`The service is already running ${svc.version}.`);
      }
      startDeploy(svc, p.tick, cmd, (level, msg) => log(p, svc.id, level, msg, "deploy"));
      return;
    }
    case "promoteDeploy": {
      const svc = find(p, cmd.serviceId);
      promote(svc, p.tick, (level, msg) => log(p, svc.id, level, msg, "deploy"));
      return;
    }
    case "rollbackDeploy": {
      const svc = find(p, cmd.serviceId);
      rollbackNow(svc, p.tick, (level, msg) => log(p, svc.id, level, msg, "deploy"));
      return;
    }
    case "createService": {
      if (p.services.length >= MAX_SERVICES) throw new Error(`The platform can run at most ${MAX_SERVICES} services.`);
      const name = String(cmd.name ?? "").trim().slice(0, 30);
      if (!name) throw new Error("Give the service a name.");
      const domain = String(cmd.domain ?? "").trim().toLowerCase();
      if (!/^[a-z0-9]([a-z0-9.-]{0,58}[a-z0-9])?$/.test(domain) || !domain.includes(".")) {
        throw new Error("Enter a domain like shop.demo.app (letters, digits, dots and hyphens).");
      }
      if (p.services.some((s) => s.domain === domain)) throw new Error(`${domain} is already used by another service.`);
      const count = clamp(Math.round(Number(cmd.instances) || 1), 1, 6);
      // A unique id from the name: "My API" -> "my-api", then "my-api-2" if taken.
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "service";
      let id = base;
      for (let n = 2; p.services.some((s) => s.id === id); n++) id = `${base}-${n}`;

      const svc = makeService(id, name, domain, 0);
      svc.instances = Array.from({ length: count }, () => makeInstance("v1", true)); // booting, not yet serving
      svc.autoscale.min = Math.min(svc.autoscale.min, count);
      svc.status = "deploying";
      svc.provisioning = true;
      svc.targetRps = 0; // nobody is sending traffic yet; you do that in the Cluster tab
      svc.currentRps = 0;
      p.services.push(svc);
      log(p, id, "info", `Going live: provisioning ${name} (${domain}) with ${count} instance(s).`, "deploy");
      return;
    }
    case "deleteService": {
      if (p.services.length <= 1) throw new Error("The platform needs at least one service.");
      const svc = find(p, cmd.serviceId);
      p.services = p.services.filter((s) => s.id !== svc.id);
      log(p, "platform", "info", `Service ${svc.name} (${svc.domain}) was shut down and removed.`, "deploy");
      return;
    }
    case "addSchedule": {
      const svc = find(p, cmd.serviceId);
      if (svc.schedules.length >= MAX_SCHEDULES) throw new Error(`A service can have at most ${MAX_SCHEDULES} schedule windows.`);
      const s = cleanSchedule({ id: shortId("sch"), ...cmd.schedule });
      svc.schedules.push(s);
      log(p, svc.id, "info", `Schedule "${s.note}" added: ${formatMinute(s.fromMin)}-${formatMinute(s.toMin)}, ${s.min}-${s.max} instances.`);
      return;
    }
    case "updateSchedule": {
      const svc = find(p, cmd.serviceId);
      const i = svc.schedules.findIndex((s) => s.id === cmd.scheduleId);
      if (i < 0) throw new Error(`Unknown schedule: ${cmd.scheduleId}`);
      svc.schedules[i] = cleanSchedule({ ...svc.schedules[i], ...cmd.patch });
      log(p, svc.id, "info", `Schedule "${svc.schedules[i].note}" updated.`);
      return;
    }
    case "removeSchedule": {
      const svc = find(p, cmd.serviceId);
      const s = svc.schedules.find((x) => x.id === cmd.scheduleId);
      if (!s) throw new Error(`Unknown schedule: ${cmd.scheduleId}`);
      svc.schedules = svc.schedules.filter((x) => x.id !== cmd.scheduleId);
      log(p, svc.id, "info", `Schedule "${s.note}" removed.`);
      return;
    }
    case "moveSchedule": {
      const svc = find(p, cmd.serviceId);
      const i = svc.schedules.findIndex((s) => s.id === cmd.scheduleId);
      if (i < 0) throw new Error(`Unknown schedule: ${cmd.scheduleId}`);
      const j = cmd.direction === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= svc.schedules.length) return; // already at the end of the list
      [svc.schedules[i], svc.schedules[j]] = [svc.schedules[j], svc.schedules[i]];
      log(p, svc.id, "info", "Schedule priority changed (the first matching window wins).");
      return;
    }
    case "setClock": {
      if (!Number.isFinite(cmd.minutes)) throw new Error("minutes must be a number");
      p.clockMinutes = clamp(Math.round(cmd.minutes), 0, 1439);
      log(p, "platform", "info", `Simulated clock set to ${formatMinute(p.clockMinutes)}.`);
      return;
    }
    case "updateQueue": {
      const svc = find(p, cmd.serviceId);
      const q = (svc.queue = normalizeQueue(svc.queue));
      const { patch } = cmd;
      if (patch.capacity !== undefined) q.capacity = clamp(Math.round(patch.capacity), 0, 100000);
      if (patch.maxWaitTicks !== undefined) q.maxWaitTicks = clamp(Math.round(patch.maxWaitTicks), 1, 120);
      if (patch.maxRetries !== undefined) q.maxRetries = clamp(Math.round(patch.maxRetries), 0, 10);
      if (patch.retryBackoffTicks !== undefined)
        q.retryBackoffTicks = clamp(Math.round(patch.retryBackoffTicks), 1, 60);
      log(p, svc.id, "info", "Queue configuration updated.");
      return;
    }
    case "replayDlq": {
      const svc = find(p, cmd.serviceId);
      const q = (svc.queue = normalizeQueue(svc.queue));
      if (q.dlq <= 0) throw new Error("The dead-letter queue is empty.");
      // Replay only what fits: the queue's capacity still applies.
      const room = Math.max(0, q.capacity - q.depth);
      const n = Math.min(q.dlq, room);
      if (n <= 0) throw new Error("The queue is full, so nothing can be replayed right now.");
      q.dlq -= n;
      q.depth += n;
      q.cohorts.push({ n, age: 0, attempts: 0, readyAt: p.tick }); // a fresh start: attempts reset
      log(p, svc.id, "info", `Replayed ${n} dead-lettered request(s) back into the queue.`);
      return;
    }
    case "purgeDlq": {
      const svc = find(p, cmd.serviceId);
      const q = (svc.queue = normalizeQueue(svc.queue));
      if (q.dlq <= 0) throw new Error("The dead-letter queue is empty.");
      log(p, svc.id, "info", `Purged ${q.dlq} dead-lettered request(s).`);
      q.dlq = 0;
      return;
    }
    case "reset":
      throw new Error("reset is handled by the route (it replaces the whole world)");
    default: {
      const _exhaustive: never = cmd;
      throw new Error(`Unhandled command: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
