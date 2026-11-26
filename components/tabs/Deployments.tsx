"use client";

// =============================================================================
// Deployments.tsx  —  The "Deployments" tab: shipping a new version safely.
//
// What it teaches: replacing running code is the riskiest routine thing a platform
// does. Recreate, rolling, blue-green and canary are four answers to "how much of my
// traffic do I expose to the new version before I know it works?". You pick one, ship
// a good or a deliberately broken build, and watch the fleet change, the cost move and
// the health gate decide whether the rollout survives.
// =============================================================================

import { Lightbulb } from "lucide-react";

import { DeployHistory } from "@/components/shared/deployments/DeployHistory";
import { DeployTimeline } from "@/components/shared/deployments/DeployTimeline";
import { RolloutPanel } from "@/components/shared/deployments/RolloutPanel";
import { ServiceManager } from "@/components/shared/deployments/ServiceManager";
import { StrategyPicker } from "@/components/shared/deployments/StrategyPicker";
import { Stat } from "@/components/shared/Stat";
import type { StatTone } from "@/components/shared/Stat";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Command } from "@/lib/engine/commands";
import { costPerHour } from "@/lib/engine/metrics";
import type { Platform, ServiceStatus } from "@/lib/engine/types";

interface DeploymentsTabProps {
  platform: Platform;
  serviceId: string | null;
  /** Lets the service selector change the shared selection held by Dashboard. */
  onSelectService?: (serviceId: string) => void;
  send: (c: Command) => Promise<void>;
}

// A tone is only a hint; the status word is always printed too.
const STATUS_TONE: Record<ServiceStatus, StatTone> = {
  live: "good",
  deploying: "default",
  degraded: "warn",
  down: "bad",
};

export function DeploymentsTab({ platform, serviceId, onSelectService, send }: DeploymentsTabProps) {
  // Fall back to the first service if the selected one vanished (e.g. after a reset
  // or after you shut it down).
  const service = platform.services.find((s) => s.id === serviceId) ?? platform.services[0];
  if (!service) {
    return <p className="text-sm text-muted-foreground">No services to show.</p>;
  }

  const d = service.deployment;
  const history = service.deployHistory ?? [];
  const last = history[0];

  // Instances that count: anything not on its way out. Standby (blue-green green fleet)
  // counts too, because it is running, and billed, even while it takes no traffic.
  const live = service.instances.filter((i) => i.status !== "draining");
  const byVersion = new Map<string, number>();
  for (const i of live) byVersion.set(i.version, (byVersion.get(i.version) ?? 0) + 1);
  // "4 x v1 + 2 x v2", with versions in numeric order (v2 before v10).
  const breakdown = [...byVersion]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([v, n]) => `${n} x ${v}`)
    .join(" + ");

  const cost = costPerHour(service);

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

      {/* KPI row: 2 cols on phones, 3 on tablets, 6 on desktop. */}
      <section aria-label="Deployment metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Running version" value={service.version} />
        <Stat label="Instances" value={live.length} unit={breakdown || undefined} />
        <Stat
          label="Deployment"
          value={d ? `${d.progressPct}%` : "idle"}
          unit={d ? d.strategy : undefined}
          tone={d?.rollingBack ? "bad" : "default"}
        />
        {/* Blue-green's idle green fleet is billed too, so this visibly doubles. */}
        <Stat label="Cost" value={`$${cost.toFixed(2)}`} unit="/hr" />
        <Stat
          label="Last deploy"
          value={last ? (last.outcome === "succeeded" ? "succeeded" : "rolled back") : "none"}
          tone={last ? (last.outcome === "succeeded" ? "good" : "warn") : "default"}
        />
        <Stat label="Status" value={service.status} tone={STATUS_TONE[service.status]} />
      </section>

      {/* Same layout trick as Scheduled and Reliability: two columns on desktop (left:
          ship, rollout, timeline; right: services, history, try it). On phones the
          column wrappers vanish (`max-lg:contents`) so `order-N` sets one linear order.
          While a rollout runs, the Rollout card jumps to the top on phones; otherwise
          the picker leads. (Full class names, so Tailwind can see them.) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className={`${d ? "order-2" : "order-1"} min-w-0 lg:order-none`}>
            <StrategyPicker service={service} send={send} />
          </div>
          <div className={`${d ? "order-1" : "order-2"} min-w-0 lg:order-none`}>
            <RolloutPanel service={service} tick={platform.tick} send={send} />
          </div>
          <div className="order-3 min-w-0 lg:order-none">
            <DeployTimeline events={platform.events} serviceId={service.id} />
          </div>
        </div>
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-5 min-w-0 lg:order-none">
            <ServiceManager platform={platform} send={send} />
          </div>
          <div className="order-4 min-w-0 lg:order-none">
            <DeployHistory history={history} />
          </div>
          <div className="order-6 min-w-0 lg:order-none">
            <TryIt />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Four experiments: the fastest way to learn this is to ship a bad build. */
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
          <li>Deploy a Healthy build with Rolling, then with Blue-green: watch the fleet strip and the cost.</li>
          <li>
            Deploy a Sneaky bug with Rolling: it passes every check and ships to everyone. Revert, then try Canary and
            watch it get caught at 10%.
          </li>
          <li>Pick Recreate and note the downtime.</li>
          <li>Switch on &quot;Pause for my approval&quot; with Blue-green and press Promote.</li>
        </ul>
      </CardContent>
    </Card>
  );
}
