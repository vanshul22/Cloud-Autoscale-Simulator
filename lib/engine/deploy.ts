// =============================================================================
// deploy.ts  —  Shipping a new version without (much) pain.
//
// Replacing running code is the riskiest routine thing a platform does. Every
// strategy is a different answer to one question: HOW MUCH of your traffic do you
// expose to the new version before you know it works?
//
//   recreate    Stop everything, start the new version. Simplest and cheapest, but
//               there is DOWNTIME while the new instances boot, and a bad release
//               takes you completely down.
//   rolling     Replace a batch at a time: start new, wait until they are READY,
//               then stop the same number of old. Capacity never drops, and a bad
//               release is caught on the first batch. (The default in Kubernetes.)
//   blue-green  Start a full second fleet ("green") idle next to the live one
//               ("blue"), check it, then switch ALL traffic at once. Instant cutover
//               and instant rollback (blue is still there), but you pay for two
//               fleets while you do it.
//   canary      Send a small share of real traffic (10%) to the new version, watch
//               its error rate, then widen (50%, 100%). The smallest blast radius:
//               a bad release only ever hurts the share you gave it.
//
// Two ideas are shared by all of them:
//   HEALTH GATE  A new instance only counts once it is READY: running, passing its
//                health checks, and stable for a few ticks. If new instances do not
//                get ready within the deadline (or a canary's error rate is too
//                high) the gate FAILS.
//   ROLLBACK     A failed gate undoes the deployment: remove the new instances and
//                make sure the old version is running at full strength again. It is
//                automatic when `autoRollback` is on, or you can press the button.
//
// The autoscaler pauses during a deployment (tick.ts), as many platforms do, so it
// does not fight the rollout by adding or removing instances.
// =============================================================================

import { makeInstance } from "../defaults";
import { isDead } from "./healing";
import type { BadRelease, DeployRecord, DeployStrategy, Instance, Rollout, Service } from "./types";

type Emit = (level: "info" | "warn" | "error", msg: string) => void;

/** A new instance must be healthy this many ticks in a row before it counts as READY. */
export const READY_TICKS = 3;
const MAX_CANARY_ERR_PCT = 5; // a canary above this error rate fails the gate
const CANARY_STEPS = [10, 50, 100]; // % of traffic (and fleet) the canary grows through
const MAX_HISTORY = 10;

// ---- small helpers ------------------------------------------------------------
const alive = (i: Instance) => i.status !== "draining";
const ofVersion = (svc: Service, v: string) => svc.instances.filter((i) => i.version === v && alive(i));

/**
 * READY = passed the health gate: in rotation and PASSING its health checks for a few
 * ticks in a row. Note what this does and does not prove: it proves the instance
 * starts, stays up and answers its probes. It does NOT prove real requests succeed,
 * which is why a build that passes its probes but fails real traffic sails through
 * a rolling or blue-green deployment and only a canary (watching real error rates)
 * catches it.
 */
export const isReady = (i: Instance) =>
  i.status === "healthy" && !isDead(i) && (i.passingTicks ?? 0) >= READY_TICKS;

function launch(svc: Service, version: string, n: number, bad: BadRelease, standby: boolean): void {
  for (let k = 0; k < n; k++) {
    const inst = makeInstance(version, true);
    inst.weight = 1;
    if (bad !== "none") inst.buggy = bad;
    if (standby) inst.standby = true;
    svc.instances.push(inst);
  }
}
const drain = (i: Instance) => {
  i.status = "draining";
};

/** The next version label: v1 -> v2. */
export function nextVersion(v: string): string {
  const n = Number(v.replace(/^v/i, ""));
  return `v${Number.isFinite(n) && n > 0 ? n + 1 : 2}`;
}

// ---- starting a deployment ----------------------------------------------------
export interface DeployOptions {
  strategy: DeployStrategy;
  toVersion?: string; // default: the next version (v1 -> v2). Set it to go BACK, e.g. "v1".
  bad?: BadRelease;
  stepPct?: number; // rolling: batch size as % of the fleet
  holdTicks?: number; // canary: watch time per step
  autoPromote?: boolean;
  autoRollback?: boolean;
}

export function startDeploy(svc: Service, tick: number, o: DeployOptions, emit: Emit): void {
  if (svc.deployment) throw new Error("A deployment is already in progress for this service.");
  if (svc.provisioning) throw new Error("This service is still going live. Wait until it is running.");
  const target = Math.max(1, svc.instances.filter((i) => alive(i) && !i.standby && i.version === svc.version).length);
  const to = o.toVersion ?? nextVersion(svc.version);
  const bad: BadRelease = o.bad ?? "none";

  const d: Rollout = {
    strategy: o.strategy,
    fromVersion: svc.version,
    toVersion: to,
    stepPct: clampInt(o.stepPct ?? 25, 5, 100),
    progressPct: 0,
    phase: "progressing",
    newHealthyPct: 0,
    startedTick: tick,
    targetCount: target,
    bad,
    holdTicks: clampInt(o.holdTicks ?? 10, 3, 60),
    autoPromote: o.autoPromote ?? true,
    autoRollback: o.autoRollback ?? true,
    deadlineTicks: 20,
    stepStartedTick: tick,
    trafficPctToNew: 0,
    newErrPct: 0,
    rollingBack: false,
    note: "",
  };
  svc.deployment = d;
  svc.status = "deploying";
  const quality = bad === "none" ? "" : ` (a deliberately ${bad === "errors" ? "error-prone" : bad === "slow" ? "slow" : "crash-prone"} build)`;
  emit("info", `Deploying ${to} over ${svc.version} with ${o.strategy}${quality}: ${target} instance(s) to replace.`);

  switch (o.strategy) {
    case "recreate":
      svc.instances.filter(alive).forEach(drain);
      launch(svc, to, target, bad, false);
      d.note = `Stopped every ${d.fromVersion} instance. The service is DOWN until ${to} is up.`;
      emit("warn", d.note);
      break;
    case "rolling": {
      const batch = batchSize(d);
      launch(svc, to, batch, bad, false);
      d.note = `Batch 1: starting ${batch} ${to} instance(s) alongside ${d.fromVersion}.`;
      emit("info", d.note);
      break;
    }
    case "blue-green":
      launch(svc, to, target, bad, true); // green: warm but idle (standby)
      d.note = `Green fleet: starting ${target} ${to} instance(s), idle, while ${d.fromVersion} (blue) keeps serving.`;
      emit("info", d.note);
      break;
    case "canary": {
      d.stepPct = CANARY_STEPS[0]; // the share we are working toward...
      d.trafficPctToNew = 0; // ...but it only gets traffic once its instances are ready
      const n = canaryCount(d);
      launch(svc, to, n, bad, false);
      d.note = `Canary: ${n} ${to} instance(s) will get ${d.stepPct}% of traffic once healthy.`;
      emit("info", d.note);
      break;
    }
  }
}

const batchSize = (d: Rollout) => Math.max(1, Math.ceil((d.targetCount * d.stepPct) / 100));
const canaryCount = (d: Rollout) => Math.max(1, Math.ceil((d.targetCount * d.stepPct) / 100));
const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

// ---- one tick of a running deployment -----------------------------------------
export function stepDeployment(svc: Service, tick: number, emit: Emit): void {
  const d = svc.deployment;
  if (!d) return;

  const news = ofVersion(svc, d.toVersion);
  const olds = ofVersion(svc, d.fromVersion);
  const readyNew = news.filter(isReady);
  d.newHealthyPct = news.length ? Math.round((readyNew.length / news.length) * 100) : 0;
  d.progressPct = Math.min(100, Math.round((readyNew.length / Math.max(1, d.targetCount)) * 100));

  // Undoing: wait until the old version is back at full strength, then finish.
  if (d.rollingBack) {
    if (olds.filter(isReady).length >= d.targetCount) finish(svc, tick, "rolled-back", d.note, emit);
    return;
  }

  // Waiting for the operator at a gate.
  if (d.phase === "awaiting-approval") return;

  switch (d.strategy) {
    case "recreate":
      return stepRecreate(svc, d, news, readyNew, tick, emit);
    case "rolling":
      return stepRolling(svc, d, news, olds, readyNew, tick, emit);
    case "blue-green":
      return stepBlueGreen(svc, d, news, readyNew, tick, emit);
    case "canary":
      return stepCanary(svc, d, news, olds, readyNew, tick, emit);
  }
}

/** RECREATE: done when the new fleet is up. No gate except "did it ever start?". */
function stepRecreate(svc: Service, d: Rollout, news: Instance[], ready: Instance[], tick: number, emit: Emit): void {
  if (ready.length >= d.targetCount) {
    finish(svc, tick, "succeeded", `All ${d.targetCount} ${d.toVersion} instances are ready.`, emit);
  } else if (tick - d.startedTick > d.deadlineTicks && ready.length === 0 && news.length > 0) {
    gateFailed(svc, d, `${d.toVersion} never became ready, and there is nothing else running`, tick, emit);
  }
}

/** ROLLING: replace a batch at a time, but only retire old instances once the batch is READY. */
function stepRolling(svc: Service, d: Rollout, news: Instance[], olds: Instance[], ready: Instance[], tick: number, emit: Emit): void {
  const notReady = news.filter((i) => !isReady(i));
  if (notReady.length > 0) {
    // The health gate for this batch: give it a deadline.
    if (tick - d.stepStartedTick > d.deadlineTicks) {
      gateFailed(svc, d, `a batch of ${d.toVersion} never became ready`, tick, emit);
    }
    return;
  }
  // Every new instance so far is ready: retire the same number of old ones.
  const wantOld = Math.max(0, d.targetCount - ready.length);
  olds.slice(0, Math.max(0, olds.length - wantOld)).forEach(drain);

  if (ready.length >= d.targetCount) {
    finish(svc, tick, "succeeded", `Every instance now runs ${d.toVersion}.`, emit);
    return;
  }
  const batch = Math.min(batchSize(d), d.targetCount - ready.length);
  launch(svc, d.toVersion, batch, d.bad, false);
  d.stepStartedTick = tick;
  d.note = `${ready.length} of ${d.targetCount} on ${d.toVersion}. Starting the next batch of ${batch}.`;
  emit("info", d.note);
}

/** BLUE-GREEN: build the whole green fleet idle, then switch all traffic at once. */
function stepBlueGreen(svc: Service, d: Rollout, news: Instance[], ready: Instance[], tick: number, emit: Emit): void {
  if (ready.length >= d.targetCount) {
    if (d.autoPromote) {
      cutover(svc, d, tick, emit);
    } else {
      d.phase = "awaiting-approval";
      d.note = `Green (${d.toVersion}) is fully ready and idle. Promote to switch all traffic, or roll back.`;
      emit("info", d.note);
    }
  } else if (tick - d.startedTick > d.deadlineTicks && news.length > 0) {
    gateFailed(svc, d, `the green ${d.toVersion} fleet never became fully ready (traffic never moved)`, tick, emit);
  }
}

function cutover(svc: Service, d: Rollout, tick: number, emit: Emit): void {
  ofVersion(svc, d.toVersion).forEach((i) => (i.standby = undefined)); // green joins the nginx upstream
  ofVersion(svc, d.fromVersion).forEach(drain); // blue is retired
  emit("info", `Cutover: all traffic now goes to ${d.toVersion}; ${d.fromVersion} is retired.`);
  finish(svc, tick, "succeeded", `Switched all traffic to ${d.toVersion} in one step.`, emit);
}

/** CANARY: grow the share of traffic step by step, watching the new version's error rate. */
function stepCanary(svc: Service, d: Rollout, news: Instance[], olds: Instance[], ready: Instance[], tick: number, emit: Emit): void {
  const wanted = canaryCount(d);

  // The gate, part 1: the canary must be seen failing quickly.
  if (d.newErrPct > MAX_CANARY_ERR_PCT) {
    gateFailed(svc, d, `the ${d.toVersion} canary fails ${d.newErrPct.toFixed(0)}% of its requests (limit ${MAX_CANARY_ERR_PCT}%)`, tick, emit);
    return;
  }
  // Part 2: the canary instances must become ready at all.
  if (ready.length < wanted) {
    d.readySinceTick = undefined;
    if (tick - d.stepStartedTick > d.deadlineTicks) {
      gateFailed(svc, d, `the ${d.toVersion} canary never became ready`, tick, emit);
    }
    return;
  }
  // This step's instances are ready, so NOW (and not before) they start taking their
  // share of traffic. Shifting traffic first would overload the few ready instances
  // while the rest are still booting.
  if (d.trafficPctToNew !== d.stepPct) {
    d.trafficPctToNew = d.stepPct;
    d.readySinceTick = tick;
    d.note = `${d.toVersion} is ready and now receives ${d.trafficPctToNew}% of real traffic. Watching its error rate for ${d.holdTicks} ticks.`;
    emit("info", d.note);
    return;
  }
  // Watch it for `holdTicks` under real traffic before widening.
  d.readySinceTick ??= tick;
  if (tick - d.readySinceTick < d.holdTicks) return;

  if (d.trafficPctToNew >= 100) {
    olds.forEach(drain);
    finish(svc, tick, "succeeded", `Canary reached 100% with no gate failures.`, emit);
    return;
  }
  if (!d.autoPromote) {
    d.phase = "awaiting-approval";
    d.note = `Canary at ${d.trafficPctToNew}% looks healthy. Promote to widen it, or roll back.`;
    emit("info", d.note);
    return;
  }
  widenCanary(svc, d, tick, emit);
}

function widenCanary(svc: Service, d: Rollout, tick: number, emit: Emit): void {
  const next = CANARY_STEPS.find((s) => s > d.trafficPctToNew) ?? 100;
  d.stepPct = next; // the new target; traffic follows once the instances are ready
  const have = ofVersion(svc, d.toVersion).length;
  const need = canaryCount(d);
  if (need > have) launch(svc, d.toVersion, need - have, d.bad, false);
  d.readySinceTick = undefined;
  d.stepStartedTick = tick;
  d.phase = "progressing";
  d.note = `Growing the canary to ${next}%: starting ${Math.max(0, need - have)} more ${d.toVersion} instance(s) first.`;
  emit("info", d.note);
}

// ---- operator actions -----------------------------------------------------------
/** Promote: pass the current gate now (blue-green cutover / next canary step). */
export function promote(svc: Service, tick: number, emit: Emit): void {
  const d = svc.deployment;
  if (!d || d.rollingBack) throw new Error("There is no deployment to promote.");
  if (d.strategy === "blue-green") {
    const ready = ofVersion(svc, d.toVersion).filter(isReady);
    if (ready.length < d.targetCount) throw new Error("The green fleet is not fully ready yet.");
    d.phase = "progressing";
    cutover(svc, d, tick, emit);
  } else if (d.strategy === "canary") {
    if (d.trafficPctToNew >= 100) throw new Error("The canary is already at 100%.");
    const wanted = canaryCount(d);
    if (ofVersion(svc, d.toVersion).filter(isReady).length < wanted) throw new Error("The canary is not ready yet.");
    widenCanary(svc, d, tick, emit);
  } else {
    throw new Error(`${d.strategy} has no manual gate to promote.`);
  }
}

/** Roll back by hand. */
export function rollbackNow(svc: Service, tick: number, emit: Emit): void {
  const d = svc.deployment;
  if (!d) throw new Error("There is no deployment to roll back.");
  if (d.rollingBack) throw new Error("Already rolling back.");
  startRollback(svc, d, "rolled back by hand", tick, emit);
}

/** A gate failed: roll back automatically, or pause and ask. */
function gateFailed(svc: Service, d: Rollout, why: string, tick: number, emit: Emit): void {
  emit("error", `Health gate FAILED: ${why}.`);
  if (d.autoRollback) {
    startRollback(svc, d, why, tick, emit);
  } else {
    d.phase = "awaiting-approval";
    d.note = `Health gate failed (${why}). Roll back, or fix and promote.`;
  }
}

function startRollback(svc: Service, d: Rollout, why: string, tick: number, emit: Emit): void {
  d.rollingBack = true;
  d.phase = "progressing";
  d.trafficPctToNew = 0;
  // Remove every new-version instance...
  ofVersion(svc, d.toVersion).forEach(drain);
  // ...and make sure the old version is running at full strength again. Strategies
  // that never retired old instances (blue-green, canary, a rolling first batch) have
  // nothing to do here; recreate has to start them all over again.
  const oldAlive = ofVersion(svc, d.fromVersion).length;
  const missing = d.targetCount - oldAlive;
  if (missing > 0) launch(svc, d.fromVersion, missing, "none", false);
  ofVersion(svc, d.fromVersion).forEach((i) => (i.standby = undefined));
  d.note = `Rolling back to ${d.fromVersion}: ${why}.${missing > 0 ? ` Restarting ${missing} ${d.fromVersion} instance(s).` : ""}`;
  emit("warn", d.note);
}

/** Wrap up: record it, tidy up, return the service to normal. */
function finish(svc: Service, tick: number, outcome: DeployRecord["outcome"], reason: string, emit: Emit): void {
  const d = svc.deployment;
  if (!d) return;
  if (outcome === "succeeded") {
    svc.version = d.toVersion;
    ofVersion(svc, d.fromVersion).forEach(drain); // belt and braces: nothing old lingers
  }
  (svc.deployHistory ??= []).unshift({
    from: d.fromVersion,
    to: d.toVersion,
    strategy: d.strategy,
    bad: d.bad,
    outcome,
    startedTick: d.startedTick,
    endedTick: tick,
    reason,
  });
  svc.deployHistory.length = Math.min(svc.deployHistory.length, MAX_HISTORY);
  svc.deployment = undefined;
  emit(
    outcome === "succeeded" ? "info" : "warn",
    outcome === "succeeded"
      ? `Deployment finished: ${svc.name} now runs ${d.toVersion}. ${reason}`
      : `Deployment ROLLED BACK: ${svc.name} stays on ${d.fromVersion}. ${reason}`,
  );
}
