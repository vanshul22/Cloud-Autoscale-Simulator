"use client";

// =============================================================================
// Reliability.tsx  —  The "Reliability" tab: chaos engineering + self-healing.
//
// What it teaches: things break, and the platform does not know instantly. You
// break an instance, then watch the whole recovery story play out: undetected
// failures, health checks, removal from the load balancer, restarts with backoff,
// crash loops and the circuit breaker. Each card shows one part of that story.
// =============================================================================

import { Flame, Lightbulb, Skull } from "lucide-react";

import { CircuitBreakerCard } from "@/components/shared/reliability/CircuitBreakerCard";
import { FleetHealth } from "@/components/shared/reliability/FleetHealth";
import { HealthSettings } from "@/components/shared/reliability/HealthSettings";
import { HealthTimeline } from "@/components/shared/reliability/HealthTimeline";
import { Stat, errTone } from "@/components/shared/Stat";
import type { StatTone } from "@/components/shared/Stat";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Command } from "@/lib/engine/commands";
import { errorRatePct } from "@/lib/engine/metrics";
import type { HealthConfig, Platform } from "@/lib/engine/types";

interface ReliabilityTabProps {
  platform: Platform;
  serviceId: string | null;
  /** Lets the service selector change the shared selection held by Dashboard. */
  onSelectService?: (serviceId: string) => void;
  send: (c: Command) => Promise<void>;
}

// Defaults for any setting a saved world is missing. The live site keeps its world in
// Redis, so right after a deploy it can still hold the OLD, smaller health object
// until the next tick upgrades it. Filling the gaps here (`?? default`) means no
// component below ever has to handle `undefined`. The numbers match the engine's.
function resolveHealth(h: HealthConfig): Required<HealthConfig> {
  return {
    restartBackoffTicks: h.restartBackoffTicks ?? 2,
    maxRestarts: h.maxRestarts ?? 5,
    errorRateToTrip: h.errorRateToTrip ?? 50,
    circuit: h.circuit ?? "closed",
    circuitOpen: (h.circuit ?? "closed") === "open",
    checkFailuresToEject: h.checkFailuresToEject ?? 2,
    readinessLatencyFactor: h.readinessLatencyFactor ?? 6,
    faultDurationTicks: h.faultDurationTicks ?? 40,
    circuitEnabled: h.circuitEnabled ?? true,
    circuitOpenTicks: h.circuitOpenTicks ?? 8,
    circuitTicksLeft: h.circuitTicksLeft ?? 0,
    circuitBadTicks: h.circuitBadTicks ?? 0,
    lastErrRate: h.lastErrRate ?? 0,
    faultFailedNow: h.faultFailedNow ?? 0,
    shedNow: h.shedNow ?? 0,
  };
}

export function ReliabilityTab({ platform, serviceId, onSelectService, send }: ReliabilityTabProps) {
  // Fall back to the first service if the selected one vanished (e.g. after a reset).
  const service = platform.services.find((s) => s.id === serviceId) ?? platform.services[0];
  if (!service) {
    return <p className="text-sm text-muted-foreground">No services to show.</p>;
  }

  const health = resolveHealth(service.health);
  const instances = service.instances;
  const inRotation = instances.filter((i) => i.status === "healthy").length;
  const recovering = instances.filter((i) => i.status === "restarting" || i.status === "booting").length;
  const crashLooping = instances.filter((i) => i.status === "crashloop").length;
  const restartsTotal = instances.reduce((sum, i) => sum + (i.restartCount ?? 0), 0);
  const err = errorRatePct(service);
  const circuitTone: StatTone = !health.circuitEnabled
    ? "default"
    : health.circuit === "open"
      ? "bad"
      : health.circuit === "half-open"
        ? "warn"
        : "good";

  return (
    <div className="space-y-4">
      {/* Title row (or a service switcher when there are several). */}
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

      {/* KPI row: 2 cols on phones, 3 on tablets, 6 on desktop. Tones are hints; the
          number or word is always shown too. */}
      <section aria-label="Reliability metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="In rotation" value={inRotation} unit={`/ ${instances.length}`} />
        <Stat label="Restarting" value={recovering} tone={recovering > 0 ? "warn" : "default"} />
        <Stat label="Crash-looping" value={crashLooping} tone={crashLooping > 0 ? "bad" : "default"} />
        <Stat label="Restarts so far" value={restartsTotal} />
        <Stat label="Circuit breaker" value={health.circuitEnabled ? health.circuit : "off"} tone={circuitTone} />
        <Stat label="Error rate" value={err.toFixed(1)} unit="%" tone={errTone(err)} />
      </section>

      {/* Same layout trick as Queue: two columns on desktop (left: break it, fleet,
          timeline; right: breaker, settings, explainer). On phones the column wrappers
          vanish (`max-lg:contents`) so `order-N` sets one linear order. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-1 min-w-0 lg:order-none">
            <ChaosCard
              serviceId={service.id}
              canHit={instances.some((i) => i.status === "healthy" && !i.fault)}
              send={send}
            />
          </div>
          <div className="order-2 min-w-0 lg:order-none">
            <FleetHealth service={service} health={health} send={send} />
          </div>
          <div className="order-3 min-w-0 lg:order-none">
            <HealthTimeline events={platform.events} serviceId={service.id} />
          </div>
        </div>
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-4 min-w-0 lg:order-none">
            <CircuitBreakerCard service={service} health={health} send={send} />
          </div>
          <div className="order-5 min-w-0 lg:order-none">
            <HealthSettings service={service} health={health} send={send} />
          </div>
          <div className="order-6 min-w-0 lg:order-none">
            <HowItHeals />
          </div>
          <div className="order-7 min-w-0 lg:order-none">
            <TryIt />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Chaos engineering: deliberately break things to see whether the platform copes. */
function ChaosCard({
  serviceId,
  canHit,
  send,
}: {
  serviceId: string;
  canHit: boolean; // chaos only picks healthy instances without a fault
  send: (c: Command) => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Flame className="h-4 w-4" aria-hidden="true" /> Break something
        </CardTitle>
        <CardDescription>Chaos engineering: break things on purpose to test the recovery.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={!canHit}
            onClick={() => void send({ type: "chaos", serviceId, action: "killRandom" })}
          >
            <Skull aria-hidden="true" /> Kill a random instance
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={!canHit}
            onClick={() => void send({ type: "chaos", serviceId, action: "killHalf" })}
          >
            <Skull aria-hidden="true" /> Kill half the fleet
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Nothing is detected instantly. For a couple of ticks nginx still sends traffic to the dead instance, and those
          requests fail. That burst of errors is the detection delay every real platform has, even when healing works
          perfectly.
        </p>
      </CardContent>
    </Card>
  );
}

// The recovery story, in the order it happens. Wording follows healing.ts.
const STEPS = [
  "Something breaks: a crash, an out-of-memory kill, slowness or errors.",
  "Not detected yet: nginx keeps sending it traffic, and a dead instance fails every request (an error burst).",
  "Health checks fail: after enough failed checks in a row, the platform decides it is unhealthy.",
  "Pulled from nginx: traffic stops going to it, so the errors stop.",
  "Liveness failure (dead) means restart, waiting longer each time (the wait doubles). Readiness failure (slow or erroring) means just wait out of rotation and recheck, with no restart.",
  "Too many restarts means a crash loop: the platform gives up, and the autoscaler adds a replacement.",
];

/** The numbered recovery story, as plain text. */
function HowItHeals() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">How it heals</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          {STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/** A short list of experiments, because the fastest way to learn this is to break it. */
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
          <li>Press Kill a random instance and watch the timeline.</li>
          <li>Inject Slow x3 vs Slow x10: x3 stays in rotation, x10 fails readiness.</li>
          <li>Set Max restarts to 1 and keep crashing the same instance to see a crash loop.</li>
        </ul>
      </CardContent>
    </Card>
  );
}
