// =============================================================================
// config.ts  —  The simulator's SETTINGS as one portable document, plus presets.
//
// Everything you can tune (autoscaling, queue, health checks, SLO, schedules, alert
// rules, cost) lives in different tabs. This file gathers it so you can:
//   - EXPORT it as a JSON file (a "scenario" you can keep, share or version),
//   - IMPORT it back (validated field by field and applied all-or-nothing; see
//     commands.ts `importConfig`),
//   - apply a PRESET: a named bundle of sensible settings.
//
// Only SETTINGS are exported, never live state: not the instances, the queue
// contents, the events or the metrics. Importing a config changes how the platform
// is configured, not what is currently running.
// =============================================================================

import { DEFAULT_COST_PER_HR, defaultAutoscale } from "../defaults";
import { defaultAlertRules } from "./alerts";
import type { Command } from "./commands";
import { normalizeHealth } from "./healing";
import { defaultQueue } from "./queue";
import type { AlertRule, AutoscaleConfig, Platform, Schedule, Service } from "./types";

export const CONFIG_FORMAT = "cloud-autoscale-simulator-config";
export const CONFIG_VERSION = 1;
export const MAX_CONFIG_BYTES = 60_000; // an import bigger than this is refused outright

// ---- the settings of ONE service (the editable fields only) --------------------------
export const AUTOSCALE_KEYS = ["min", "max", "rpsPerInstance", "scaleUpAt", "scaleDownAt", "cooldownTicks", "lb", "enabled"] as const;
export const QUEUE_KEYS = ["capacity", "maxWaitTicks", "maxRetries", "retryBackoffTicks"] as const;
export const HEALTH_KEYS = [
  "restartBackoffTicks",
  "maxRestarts",
  "errorRateToTrip",
  "checkFailuresToEject",
  "readinessLatencyFactor",
  "faultDurationTicks",
  "circuitEnabled",
  "circuitOpenTicks",
] as const;

export interface ServiceConfig {
  id: string;
  name: string;
  domain: string;
  costPerInstanceHr: number;
  autoscale: Partial<AutoscaleConfig>;
  queue: Record<(typeof QUEUE_KEYS)[number], number>;
  health: Record<string, number | boolean>;
  sloTarget: number;
  schedules: Schedule[];
}

export interface ConfigFile {
  format: typeof CONFIG_FORMAT;
  version: typeof CONFIG_VERSION;
  speed: 1 | 5 | 60;
  services: ServiceConfig[];
  alertRules: AlertRule[];
}

const pick = <T extends object>(src: T, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if ((src as Record<string, unknown>)[k] !== undefined) out[k] = (src as Record<string, unknown>)[k];
  return out;
};

export function exportServiceConfig(svc: Service): ServiceConfig {
  const q = svc.queue as unknown as Record<string, number>;
  const h = normalizeHealth(svc.health) as unknown as Record<string, number | boolean>;
  return {
    id: svc.id,
    name: svc.name,
    domain: svc.domain,
    costPerInstanceHr: svc.costPerInstanceHr,
    autoscale: pick(svc.autoscale, AUTOSCALE_KEYS) as Partial<AutoscaleConfig>,
    queue: pick(q, QUEUE_KEYS) as ServiceConfig["queue"],
    health: pick(h, HEALTH_KEYS) as Record<string, number | boolean>,
    sloTarget: svc.slo?.target ?? 99.5,
    schedules: svc.schedules.map((s) => ({ ...s })),
  };
}

/** The whole platform's settings as a plain object, ready for JSON.stringify. */
export function exportConfig(p: Platform): ConfigFile {
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    speed: p.speed,
    services: p.services.map(exportServiceConfig),
    alertRules: (p.alertRules ?? defaultAlertRules()).map((r) => ({ ...r })),
  };
}

// ---- defaults, as the Config tab compares against them ---------------------------------
export interface ServiceDefaults {
  costPerInstanceHr: number;
  autoscale: AutoscaleConfig;
  queue: Record<(typeof QUEUE_KEYS)[number], number>;
  health: Record<string, number | boolean>;
  sloTarget: number;
}

export function serviceDefaults(): ServiceDefaults {
  return {
    costPerInstanceHr: DEFAULT_COST_PER_HR,
    autoscale: defaultAutoscale(),
    queue: pick(defaultQueue() as unknown as Record<string, number>, QUEUE_KEYS) as ServiceDefaults["queue"],
    health: pick(normalizeHealth({}) as unknown as Record<string, number | boolean>, HEALTH_KEYS) as Record<string, number | boolean>,
    sloTarget: 99.5,
  };
}

// -----------------------------------------------------------------------------
// PRESETS: named bundles of settings. Each is a list of ordinary commands, so a
// preset can only ever do what the individual controls can do, with the same
// validation. The trade-off each one makes is the lesson.
// -----------------------------------------------------------------------------
export interface Preset {
  id: "defaults" | "cost-saver" | "high-availability";
  title: string;
  description: string;
  tradeoff: string;
}

export const PRESETS: Preset[] = [
  {
    id: "defaults",
    title: "Back to defaults",
    description: "Every setting of this service returns to its built-in value.",
    tradeoff: "A balanced starting point.",
  },
  {
    id: "cost-saver",
    title: "Cost saver",
    description: "Few instances, slow to scale up, quick to scale down, a small queue and a looser promise (99%).",
    tradeoff: "Cheapest to run, but slower to absorb a spike and more likely to drop requests.",
  },
  {
    id: "high-availability",
    title: "High availability",
    description: "A larger always-on fleet that scales early, health checks that react fast, a deep queue and a strict promise (99.9%).",
    tradeoff: "Rides out spikes and failures best, at a much higher bill.",
  },
];

export function presetCommands(id: Preset["id"], serviceId: string): Command[] {
  switch (id) {
    case "defaults":
      return [{ type: "resetServiceConfig", serviceId, section: "all" }];
    case "cost-saver":
      return [
        { type: "updateAutoscale", serviceId, patch: { min: 1, max: 6, scaleUpAt: 80, scaleDownAt: 40, cooldownTicks: 8 } },
        { type: "updateQueue", serviceId, patch: { capacity: 300 } },
        { type: "updateSlo", serviceId, target: 99 },
      ];
    case "high-availability":
      return [
        { type: "updateAutoscale", serviceId, patch: { min: 4, max: 20, scaleUpAt: 50, scaleDownAt: 20, cooldownTicks: 3 } },
        { type: "updateHealth", serviceId, patch: { checkFailuresToEject: 1, maxRestarts: 8, circuitEnabled: true } },
        { type: "updateQueue", serviceId, patch: { capacity: 1500, maxWaitTicks: 12 } },
        { type: "updateSlo", serviceId, target: 99.9 },
      ];
  }
}
