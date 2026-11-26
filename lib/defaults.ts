// =============================================================================
// defaults.ts  —  How a brand-new world looks.
//
// When Redis has no saved Platform yet (first visitor, or after a reset) we seed
// it from here. Factories like `makeInstance` are reused by the engine whenever
// it needs to spin up a new instance (autoscaler, healing, deployments), so the
// shape of an instance is defined in exactly one place.
// =============================================================================

import { shortId } from "./engine/ids";
import { defaultQueue } from "./engine/queue";
import type { AutoscaleConfig, HealthConfig, Instance, Platform, Service } from "./engine/types";

/** A fresh, healthy-after-boot instance of a given version. */
export function makeInstance(version: string, booting = true): Instance {
  return {
    id: shortId("i"),
    status: booting ? "booting" : "healthy",
    version,
    bootTicksLeft: booting ? 3 : 0, // ~3 ticks (~3s) to warm up
    restartsLeft: 5,
    backoffLeft: 0,
    rps: 0,
    conns: 0,
    weight: 1,
  };
}

/** What a service costs per instance-hour unless you change it (12 cents, like a small VM). */
export const DEFAULT_COST_PER_HR = 0.12;

export const defaultAutoscale = (): AutoscaleConfig => ({
  min: 2,
  max: 12,
  rpsPerInstance: 50, // one instance comfortably serves ~50 req/s
  scaleUpAt: 70, // add capacity above 70% utilisation
  scaleDownAt: 30, // shed capacity below 30% utilisation
  cooldownTicks: 4, // wait 4 ticks between scaling actions (anti-flapping)
  lb: "round-robin",
});

const defaultHealth = (): HealthConfig => ({
  restartBackoffTicks: 2, // first restart waits 2 ticks, then 4, then 8 ...
  maxRestarts: 5,
  errorRateToTrip: 50, // open the circuit if >50% of requests error
  circuitOpen: false,
});

/** Build a service with a starting pool of `startInstances` healthy instances. */
export function makeService(
  id: string,
  name: string,
  domain: string,
  startInstances = 2,
): Service {
  const autoscale = defaultAutoscale();
  const instances: Instance[] = Array.from({ length: startInstances }, () =>
    makeInstance("v1", false),
  );
  return {
    id,
    name,
    domain,
    status: "live",
    version: "v1",
    targetRps: 40,
    currentRps: 40,
    pattern: "flat",
    patternTick: 0,
    instances,
    rrCursor: 0,
    autoscale,
    cooldownLeft: 0,
    schedules: [],
    queue: defaultQueue(),
    health: defaultHealth(),
    metricsHistory: [],
    costPerInstanceHr: DEFAULT_COST_PER_HR,
  };
}

/** The initial platform: one demo service, clock at 09:00. */
export function seedPlatform(): Platform {
  return {
    tick: 0,
    speed: 1,
    lastTickAt: Date.now(),
    clockMinutes: 9 * 60, // 09:00
    services: [makeService("web", "Web Storefront", "shop.demo.app", 2)],
    events: [
      { t: 0, service: "platform", level: "info", msg: "Platform initialised." },
    ],
  };
}
