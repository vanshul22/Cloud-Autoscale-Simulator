// =============================================================================
// healing.ts  —  What the platform does when an instance breaks.
//
// Real platforms (Kubernetes, ECS, an nginx health-check setup) follow the same
// story, and every step here is visible in the Reliability tab's timeline:
//
//   1. SOMETHING BREAKS      A process crashes or is OOM-killed, or an instance gets
//                            slow, or starts returning errors.
//   2. THE PLATFORM DOESN'T KNOW YET   For a few ticks the load balancer keeps
//                            sending it traffic. A dead instance fails every request
//                            it receives. This detection delay is why real outages
//                            show a burst of errors even when healing works.
//   3. HEALTH CHECKS NOTICE  After N failed checks in a row the instance is pulled
//                            out of the nginx upstream, so traffic stops going to it.
//         liveness  failure (dead)        -> RESTART it
//         readiness failure (slow/errors) -> just take it OUT of rotation and keep
//                                            checking; no restart, it may recover
//   4. RESTART WITH BACKOFF  Wait, then boot again. The wait DOUBLES each time (see
//                            restartPolicy) so a broken instance doesn't hammer the
//                            system by restarting in a tight loop.
//   5. CRASH LOOP            After too many restarts we give up on it. The autoscaler
//                            sees the missing capacity and adds a replacement.
//   6. CIRCUIT BREAKER       If lots of requests are failing, stop sending any for a
//                            while (fail fast), then cautiously test with a little
//                            traffic. This protects a struggling system from being
//                            hammered while it recovers.
//
// stepHealth() runs once per tick from tick.ts, before traffic is distributed.
// =============================================================================

import { instanceCapacityRps } from "./metrics";
import type { HealthConfig, Instance, Service, SimEvent } from "./types";

type Emit = (level: SimEvent["level"], msg: string) => void;

const BOOT_TICKS = 3; // same warm-up as any new instance
const STABLE_TICKS_TO_FORGIVE = 30; // this long without trouble resets the restart counter
const CRASHLOOP_CLEANUP_TICKS = 40; // a crash-looping instance is removed after this long
const READINESS_ERROR_FRACTION = 0.5; // an instance failing >=50% of requests fails readiness
const CIRCUIT_BAD_TICKS = 3; // ticks above the trip level before the breaker opens
const HALF_OPEN_TICKS = 3; // how long the breaker tests with a trickle of traffic
const HALF_OPEN_ADMIT = 0.2; // the trickle: 20% of requests

/**
 * Fill in any setting a saved world is missing. The live site keeps its world in
 * Redis, and worlds saved before the Reliability tab existed have a smaller health
 * object. Every consumer passes it through here first.
 */
export function normalizeHealth(h: Partial<HealthConfig> | undefined): HealthConfig {
  const base: HealthConfig = {
    restartBackoffTicks: 2,
    maxRestarts: 5,
    errorRateToTrip: 50,
    circuitOpen: false,
    checkFailuresToEject: 2,
    readinessLatencyFactor: 6,
    faultDurationTicks: 40,
    circuitEnabled: true,
    circuitOpenTicks: 8,
    circuit: "closed",
    circuitTicksLeft: 0,
    circuitBadTicks: 0,
    lastErrRate: 0,
    faultFailedNow: 0,
    shedNow: 0,
  };
  const out = { ...base, ...(h ?? {}) };
  out.circuitOpen = out.circuit === "open";
  return out;
}

// -----------------------------------------------------------------------------
// ⭐ THE RESTART POLICY: the part of this file worth reading closely and tuning.
//
// An instance just failed. Do we restart it, and how long do we wait first?
//
//   delay = base * 2^restarts      0 -> 2 ticks, 1 -> 4, 2 -> 8, 3 -> 16, 4 -> 32
//
// Why exponential? If the cause is persistent (a bad deploy, a poisoned input),
// restarting instantly just crashes again, forever, burning capacity and filling
// logs. Waiting longer each time gives transient problems room to clear while
// capping the damage from permanent ones. `maxRestarts` is the "give up" line: past
// it we declare a crash loop. Things to try: no backoff (set it to 1 and watch
// the churn), or never giving up (maxRestarts 10).
// -----------------------------------------------------------------------------
export function restartPolicy(
  restartsSoFar: number,
  h: Pick<HealthConfig, "maxRestarts" | "restartBackoffTicks">,
): { restart: false } | { restart: true; delayTicks: number } {
  if (restartsSoFar >= h.maxRestarts) return { restart: false };
  return { restart: true, delayTicks: Math.min(60, h.restartBackoffTicks * 2 ** restartsSoFar) };
}

/** Fraction of incoming traffic the circuit breaker lets through right now. */
export function admitFraction(h: HealthConfig): number {
  if (!h.circuitEnabled) return 1;
  if (h.circuit === "open") return 0; // fail fast: refuse everything
  if (h.circuit === "half-open") return HALF_OPEN_ADMIT; // test with a trickle
  return 1;
}

/** True when the process is dead but health checks have not caught it yet. */
export const isDead = (i: Instance) => i.fault === "crash" || i.fault === "oom";

/** Remove an injected fault and return the instance to normal behaviour. */
export function clearFault(inst: Instance): void {
  inst.fault = undefined;
  inst.faultTicksLeft = undefined;
  inst.errorFraction = 0;
  inst.latencyFactor = 1;
}

/**
 * Requests that went to an instance that could not answer them properly this tick:
 * ALL of a dead instance's traffic, and the failing share of an erroring one's.
 * This is the error burst you see before health checks react.
 */
export function faultFailures(serving: Instance[], rpsPerInstance: number): number {
  let failed = 0;
  for (const inst of serving) {
    const handled = Math.min(inst.rps, instanceCapacityRps(inst, rpsPerInstance));
    const share = isDead(inst) ? 1 : inst.fault === "errors" ? (inst.errorFraction ?? 0) : 0;
    failed += handled * share;
  }
  return failed;
}

/** Advance the circuit breaker, then every instance's health state, by one tick. */
export function stepHealth(svc: Service, emit: Emit): void {
  const h = svc.health;
  updateCircuit(h, emit);
  for (const inst of svc.instances) stepInstance(inst, h, emit);
}

// ---- the circuit breaker -----------------------------------------------------
function updateCircuit(h: HealthConfig, emit: Emit): void {
  if (!h.circuitEnabled) {
    h.circuit = "closed";
    h.circuitBadTicks = 0;
    h.circuitOpen = false;
    return;
  }
  const err = h.lastErrRate ?? 0;

  if (h.circuit === "closed") {
    // Normal operation. Trip only on a SUSTAINED problem, not a single bad tick.
    h.circuitBadTicks = err > h.errorRateToTrip ? (h.circuitBadTicks ?? 0) + 1 : 0;
    if ((h.circuitBadTicks ?? 0) >= CIRCUIT_BAD_TICKS) {
      h.circuit = "open";
      h.circuitTicksLeft = h.circuitOpenTicks ?? 8;
      h.circuitBadTicks = 0;
      emit(
        "error",
        `Circuit breaker OPEN: ${err.toFixed(0)}% of requests failed for ${CIRCUIT_BAD_TICKS} ticks. Refusing requests instantly for ${h.circuitTicksLeft} ticks so the instances can recover.`,
      );
    }
  } else if (h.circuit === "open") {
    h.circuitTicksLeft = (h.circuitTicksLeft ?? 0) - 1;
    if (h.circuitTicksLeft <= 0) {
      h.circuit = "half-open";
      h.circuitTicksLeft = HALF_OPEN_TICKS;
      emit("info", `Circuit breaker HALF-OPEN: letting ${HALF_OPEN_ADMIT * 100}% of requests through to test whether it has recovered.`);
    }
  } else {
    // half-open: a short trial. Healthy again -> close; still failing -> reopen.
    h.circuitTicksLeft = (h.circuitTicksLeft ?? 0) - 1;
    if (h.circuitTicksLeft <= 0) {
      if (err <= h.errorRateToTrip) {
        h.circuit = "closed";
        emit("info", "Circuit breaker CLOSED: the test traffic succeeded, back to normal.");
      } else {
        h.circuit = "open";
        h.circuitTicksLeft = h.circuitOpenTicks ?? 8;
        emit("warn", `Circuit breaker re-OPENED: still ${err.toFixed(0)}% failing during the test. Waiting ${h.circuitTicksLeft} more ticks.`);
      }
    }
  }
  h.circuitOpen = h.circuit === "open";
}

// ---- one instance's health state machine ------------------------------------
function stepInstance(inst: Instance, h: HealthConfig, emit: Emit): void {
  switch (inst.status) {
    case "healthy":
      return checkRunning(inst, h, emit);
    case "unhealthy":
      return checkRejoin(inst, h, emit);
    case "restarting":
      return checkRestart(inst, h, emit);
    case "crashloop":
      inst.stableTicks = (inst.stableTicks ?? 0) + 1;
      if (inst.stableTicks >= CRASHLOOP_CLEANUP_TICKS) {
        inst.status = "draining"; // tick.ts removes it on the next tick
        emit("info", `${inst.id} removed after crash-looping (the autoscaler already replaced its capacity).`);
      }
      return;
    default:
      return; // booting and draining are handled in tick.ts
  }
}

/** An in-rotation instance: run its health checks and let temporary faults expire. */
function checkRunning(inst: Instance, h: HealthConfig, emit: Emit): void {
  const need = h.checkFailuresToEject ?? 2;

  // ---- LIVENESS: is the process alive at all? -------------------------------
  if (isDead(inst)) {
    inst.stableTicks = 0;
    inst.failedChecks = (inst.failedChecks ?? 0) + 1;
    const cause = inst.fault === "oom" ? "was OOM-killed" : "crashed";
    if (inst.failedChecks === 1) {
      emit("warn", `${inst.id} ${cause}. Health check 1/${need} failed, but nginx is still sending it traffic, so those requests fail.`);
    }
    if (inst.failedChecks >= need) {
      inst.failedChecks = 0;
      const policy = restartPolicy(inst.restartCount ?? 0, h);
      if (policy.restart) {
        inst.status = "restarting";
        inst.backoffLeft = policy.delayTicks;
        inst.downReason = inst.fault === "oom" ? "OOM killed" : "crashed";
        emit(
          "warn",
          `Liveness check failed ${need}x: ${inst.id} removed from the nginx upstream. Restarting in ${policy.delayTicks} tick(s) (restart ${(inst.restartCount ?? 0) + 1} of ${h.maxRestarts}).`,
        );
      } else {
        enterCrashLoop(inst, h, emit);
      }
    }
    return;
  }

  // ---- READINESS: alive, but fit to serve traffic? --------------------------
  const tooSlow = (inst.latencyFactor ?? 1) >= (h.readinessLatencyFactor ?? 6);
  const tooManyErrors = (inst.errorFraction ?? 0) >= READINESS_ERROR_FRACTION;
  if (tooSlow || tooManyErrors) {
    inst.stableTicks = 0;
    inst.failedChecks = (inst.failedChecks ?? 0) + 1;
    if (inst.failedChecks >= need) {
      inst.failedChecks = 0;
      inst.status = "unhealthy";
      inst.downReason = tooSlow ? "failing readiness: too slow" : "failing readiness: too many errors";
      emit(
        "warn",
        `Readiness check failed ${need}x: ${inst.id} taken out of the nginx upstream (${tooSlow ? "too slow" : "too many errors"}). It keeps running and is re-checked every tick; no restart.`,
      );
    }
  } else {
    inst.failedChecks = 0;
    // Long enough without trouble earns the instance a clean slate.
    if (!inst.fault) {
      inst.stableTicks = (inst.stableTicks ?? 0) + 1;
      if (inst.stableTicks >= STABLE_TICKS_TO_FORGIVE && (inst.restartCount ?? 0) > 0) {
        inst.restartCount = 0;
        inst.restartsLeft = h.maxRestarts;
      }
    }
  }
  expireFault(inst, emit);
}

/** Out of rotation for readiness: rejoin as soon as it passes again. */
function checkRejoin(inst: Instance, h: HealthConfig, emit: Emit): void {
  expireFault(inst, emit);
  const stillSlow = (inst.latencyFactor ?? 1) >= (h.readinessLatencyFactor ?? 6);
  const stillErroring = (inst.errorFraction ?? 0) >= READINESS_ERROR_FRACTION;
  if (!stillSlow && !stillErroring && !isDead(inst)) {
    inst.status = "healthy";
    inst.downReason = undefined;
    inst.failedChecks = 0;
    emit("info", `${inst.id} passes its readiness check again and rejoined the nginx upstream.`);
  }
}

/** Waiting out the restart backoff, then booting again. */
function checkRestart(inst: Instance, h: HealthConfig, emit: Emit): void {
  inst.backoffLeft = (inst.backoffLeft ?? 0) - 1;
  if (inst.backoffLeft > 0) return;
  inst.restartCount = (inst.restartCount ?? 0) + 1;
  inst.restartsLeft = Math.max(0, h.maxRestarts - inst.restartCount);
  clearFault(inst);
  inst.status = "booting"; // tick.ts turns it healthy after the warm-up
  inst.bootTicksLeft = BOOT_TICKS;
  inst.downReason = undefined;
  inst.stableTicks = 0;
  emit("info", `${inst.id} restarted (restart ${inst.restartCount} of ${h.maxRestarts}); warming up.`);
}

function enterCrashLoop(inst: Instance, h: HealthConfig, emit: Emit): void {
  inst.status = "crashloop";
  inst.downReason = "crash loop: gave up restarting";
  inst.restartsLeft = 0;
  inst.stableTicks = 0;
  emit(
    "error",
    `${inst.id} is crash-looping: gave up after ${h.maxRestarts} restarts. It stays out of nginx; the autoscaler will add a replacement if capacity is short.`,
  );
}

/** Latency and error faults are temporary; count them down and clear them. */
function expireFault(inst: Instance, emit: Emit): void {
  if (inst.fault !== "latency" && inst.fault !== "errors") return;
  if (inst.faultTicksLeft === undefined) return;
  inst.faultTicksLeft -= 1;
  if (inst.faultTicksLeft <= 0) {
    emit("info", `The ${inst.fault} fault on ${inst.id} has ended.`);
    clearFault(inst);
  }
}
