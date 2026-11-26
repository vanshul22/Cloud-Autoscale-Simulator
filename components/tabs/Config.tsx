"use client";

// =============================================================================
// Config.tsx  —  The "Config" tab: every policy setting of a service in ONE place.
//
// What it teaches: a platform is mostly configuration. Settings are scattered over
// several tabs (and some could not be edited at all), so here they are gathered, each
// compared against the BUILT-IN DEFAULTS. A section that differs says "N changed" and
// lists exactly what ("min 2 -> 4"); a Reset button puts just that section back. You
// can also apply a preset, edit the service's details, and export / import the whole
// configuration as a JSON file.
//
// The forms for autoscaling, the queue and reliability are the SAME components their
// own tabs use; this file only wraps them. All state lives on the server.
// =============================================================================

import { Lightbulb } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { GlobalCard } from "@/components/shared/config/GlobalCard";
import { ImportExport } from "@/components/shared/config/ImportExport";
import { PresetsCard } from "@/components/shared/config/PresetsCard";
import { ServiceDetails } from "@/components/shared/config/ServiceDetails";
import { SettingsSection } from "@/components/shared/config/SettingsSection";
import { ConfigPanel } from "@/components/shared/ConfigPanel";
import { QueueControls } from "@/components/shared/queue/QueueControls";
import { HealthSettings } from "@/components/shared/reliability/HealthSettings";
import { Stat } from "@/components/shared/Stat";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Command } from "@/lib/engine/commands";
import { AUTOSCALE_KEYS, HEALTH_KEYS, QUEUE_KEYS, serviceDefaults } from "@/lib/engine/config";
import { normalizeHealth } from "@/lib/engine/healing";
import { defaultQueue } from "@/lib/engine/queue";
import type { HealthConfig, Platform, QueueState, Service } from "@/lib/engine/types";

interface ConfigTabProps {
  platform: Platform;
  serviceId: string | null;
  /** Lets the service selector change the shared selection held by Dashboard. */
  onSelectService?: (serviceId: string) => void;
  send: (c: Command) => Promise<void>;
}

type Section = Extract<Command, { type: "resetServiceConfig" }>["section"];

// Mirrors the check in the `updateSlo` command (and SloPanel): 50 to 99.999 percent.
const SLO_MIN = 50;
const SLO_MAX = 99.999;

/**
 * Compare the current values with the defaults, key by key. Returns one short string
 * per difference, written "default -> current" (so "min 2 -> 4" reads: it used to be 2,
 * you made it 4). An empty list means the section is at its defaults.
 */
function diff(current: Record<string, unknown>, defaults: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (current[key] !== defaults[key]) out.push(`${key} ${String(defaults[key])} -> ${String(current[key])}`);
  }
  return out;
}

/** 0..1439 minutes -> "HH:MM" (for the schedule list). */
function hhmm(mins: number): string {
  const m = ((Math.floor(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function ConfigTab({ platform, serviceId, onSelectService, send }: ConfigTabProps) {
  // Fall back to the first service if the selected one vanished (after a reset or shutdown).
  const service = platform.services.find((s) => s.id === serviceId) ?? platform.services[0];
  if (!service) {
    return <p className="text-sm text-muted-foreground">No services to show.</p>;
  }

  const defaults = serviceDefaults();

  // ---- what differs from the defaults, section by section -------------------------
  // `enabled` is optional on old saved worlds; undefined has always meant ON, so
  // both sides are resolved to a real boolean before comparing.
  const cfg = service.autoscale;
  const autoscaleChanged = diff(
    { ...cfg, enabled: cfg.enabled !== false },
    { ...defaults.autoscale, enabled: defaults.autoscale.enabled !== false },
    AUTOSCALE_KEYS,
  );

  // Same gap-filling as the Queue tab: a world saved before the queue existed may lack
  // fields, so start from the defaults and lay what is saved on top.
  const queue: QueueState = { ...defaultQueue(), ...service.queue, cohorts: service.queue?.cohorts ?? [] };
  const queueChanged = diff(queue as unknown as Record<string, unknown>, defaults.queue, QUEUE_KEYS);

  // normalizeHealth fills every missing field, so the cast to Required is true.
  const health = normalizeHealth(service.health) as Required<HealthConfig>;
  const healthChanged = diff(health as unknown as Record<string, unknown>, defaults.health, HEALTH_KEYS);

  const sloTarget = service.slo?.target ?? defaults.sloTarget;
  const sloChanged = sloTarget !== defaults.sloTarget ? [`target ${defaults.sloTarget} -> ${sloTarget}`] : [];

  // Money: compared with a tiny tolerance because it is a decimal.
  const costChanged = Math.abs(service.costPerInstanceHr - defaults.costPerInstanceHr) > 1e-9;

  // Schedules are not part of the "changed settings" total (there is no built-in list
  // to differ from, only "none"); they get their own count below.
  const changedTotal =
    autoscaleChanged.length + queueChanged.length + healthChanged.length + sloChanged.length + (costChanged ? 1 : 0);

  const reset = (section: Section) => void send({ type: "resetServiceConfig", serviceId: service.id, section });

  return (
    <div className="space-y-4">
      {/* Title row (or a service switcher when there are several). Everything below
          describes the service picked here. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {platform.services.length > 1 ? (
          <div role="group" aria-label="Select service" className="flex flex-wrap gap-1.5">
            {platform.services.map((s) => (
              <Button
                key={s.id}
                size="sm"
                variant={s.id === service.id ? "default" : "outline"}
                aria-pressed={s.id === service.id}
                onClick={() => onSelectService?.(s.id)}
              >
                {s.name}
              </Button>
            ))}
          </div>
        ) : (
          <h2 className="text-lg font-semibold">{service.name}</h2>
        )}
        <span className="font-mono text-sm text-muted-foreground">{service.domain}</span>
        <StatusBadge status={service.status} />
      </div>

      {/* KPI row: 2 cols on phones, 3 on tablets, 6 on desktop. Each tile prints its number. */}
      <section aria-label="Configuration summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Changed settings" value={changedTotal} unit="vs defaults" tone={changedTotal > 0 ? "warn" : "default"} />
        <Stat label="Instances allowed" value={`${cfg.min}-${cfg.max}`} />
        <Stat label="Cost per instance" value={`$${service.costPerInstanceHr.toFixed(2)}`} unit="/hr" />
        <Stat label="SLO target" value={sloTarget} unit="%" />
        <Stat label="Schedules" value={service.schedules.length} />
        {/* alertRules is optional on a world saved before alerting existed. */}
        <Stat label="Alert rules" value={platform.alertRules?.length ?? 0} />
      </section>

      {/* Same layout trick as Events and Deployments: two columns on desktop (left:
          presets, details, the settings sections; right: whole platform, export and
          import, try it). On phones the column wrappers vanish (`max-lg:contents`) so
          `order-N` sets one linear order: presets, details, sections, platform,
          import/export, try it. (Full class names, so Tailwind can see them.) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-1 min-w-0 lg:order-none">
            <PresetsCard service={service} send={send} />
          </div>
          <div className="order-2 min-w-0 lg:order-none">
            {/* key: switching service starts the form fresh instead of carrying drafts over. */}
            <ServiceDetails key={service.id} service={service} defaultCost={defaults.costPerInstanceHr} send={send} />
          </div>
          <div className="order-3 min-w-0 space-y-6 lg:order-none">
            <SettingsSection
              title="Autoscaling and load balancer"
              description="When to add or remove instances, how big the fleet may be, and how traffic is shared between them."
              changed={autoscaleChanged}
              onReset={() => reset("autoscale")}
            >
              <ConfigPanel service={service} send={send} />
            </SettingsSection>

            <SettingsSection
              title="Queue"
              description="How many requests may wait when servers are full, how long they wait, and how they are retried."
              changed={queueChanged}
              onReset={() => reset("queue")}
            >
              <QueueControls service={service} queue={queue} send={send} />
            </SettingsSection>

            <SettingsSection
              title="Reliability"
              description="How fast broken instances are noticed and restarted, and when the circuit breaker refuses traffic."
              changed={healthChanged}
              onReset={() => reset("health")}
            >
              <HealthSettings service={service} health={health} send={send} />
            </SettingsSection>

            <SettingsSection
              title="Service level objective"
              description="The reliability promise for this service. A stricter promise leaves a smaller error budget."
              changed={sloChanged}
              onReset={() => reset("slo")}
            >
              <Card>
                <CardContent className="pt-6">
                  <SloTarget key={service.id} service={service} target={sloTarget} send={send} />
                </CardContent>
              </Card>
            </SettingsSection>

            {/* Schedules have no list of "fields that differ": the default is simply
                "no windows", so the badge and the Reset button follow the count. */}
            <SettingsSection
              title="Schedules"
              description="Daily windows that raise or lower the instance limits at set times."
              changed={[]}
              atDefaults={service.schedules.length === 0}
              badgeText={`${service.schedules.length} ${service.schedules.length === 1 ? "window" : "windows"}`}
              onReset={() => reset("schedules")}
            >
              <Card>
                <CardContent className="space-y-3 pt-6">
                  <p className="text-sm tabular-nums">
                    <span className="font-mono font-semibold">{service.schedules.length}</span>{" "}
                    {service.schedules.length === 1 ? "window" : "windows"} set.
                  </p>
                  {service.schedules.length > 0 && (
                    <ul className="space-y-1.5 text-sm">
                      {service.schedules.map((w) => (
                        <li key={w.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="min-w-0 break-words font-medium">{w.note || "Untitled window"}</span>
                          <span className="font-mono text-xs tabular-nums text-muted-foreground">
                            {hhmm(w.fromMin)}-{hhmm(w.toMin)}, {w.min}-{w.max} instances
                            {w.enabled === false && " (off)"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">Manage windows in the Scheduled Scaling tab.</p>
                </CardContent>
              </Card>
            </SettingsSection>
          </div>
        </div>

        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-4 min-w-0 lg:order-none">
            <GlobalCard platform={platform} send={send} />
          </div>
          <div className="order-5 min-w-0 lg:order-none">
            <ImportExport platform={platform} send={send} />
          </div>
          <div className="order-6 min-w-0 lg:order-none">
            <TryIt />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The SLO target box. Same pattern as SloPanel: a DRAFT string you can type freely,
 * committed on blur or Enter, and resynced from the server only while NOT focused so
 * an incoming tick never eats half-typed input.
 */
function SloTarget({
  service,
  target,
  send,
}: {
  service: Service;
  target: number;
  send: (c: Command) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(target));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(target));
  }, [target]);

  function commit() {
    const num = Number(draft);
    // Empty or not a number: throw the draft away and show the real value again.
    if (draft.trim() === "" || !Number.isFinite(num)) {
      setDraft(String(target));
      return;
    }
    const clamped = Math.min(SLO_MAX, Math.max(SLO_MIN, num));
    setDraft(String(clamped));
    if (clamped !== target) void send({ type: "updateSlo", serviceId: service.id, target: clamped });
  }

  const id = `${service.id}-config-slo`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Target availability (%) for {service.name}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step="any"
        min={SLO_MIN}
        max={SLO_MAX}
        className="w-32 tabular-nums"
        value={draft}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          // Enter commits by blurring, which funnels through onBlur above.
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        50 to 99.999. e.g. 99.5 means 1 request in 200 may fail.
      </p>
    </div>
  );
}

/** Three experiments: a configuration only makes sense once you have changed and restored one. */
function TryIt() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="h-4 w-4" aria-hidden="true" /> Try it
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>Apply High availability, watch the changed count, then Reset all sections.</li>
          <li>Export the configuration, change a few settings, then import the file to restore them.</li>
          <li>Edit the cost per instance and watch the cost KPI in the Cluster tab change.</li>
        </ul>
      </CardContent>
    </Card>
  );
}
