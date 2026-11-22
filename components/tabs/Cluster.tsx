"use client";

import { Charts } from "@/components/shared/Charts";
import { ConfigPanel } from "@/components/shared/ConfigPanel";
import { EventLog } from "@/components/shared/EventLog";
import { InstanceTable } from "@/components/shared/InstanceTable";
import { NginxView } from "@/components/shared/NginxView";
import { Stat, errTone, fmtPct, latencyTone, utilTone } from "@/components/shared/Stat";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TrafficControls } from "@/components/shared/TrafficControls";
import { Button } from "@/components/ui/button";
import type { Command } from "@/lib/engine/commands";
import { costPerHour, errorRatePct, p95LatencyMs, servingInstances, utilisationPct } from "@/lib/engine/metrics";
import type { Platform } from "@/lib/engine/types";

interface ClusterProps {
  platform: Platform;
  serviceId: string | null;
  /** Lets the service selector change the shared selection held by Dashboard. */
  onSelectService?: (serviceId: string) => void;
  send: (c: Command) => Promise<void>;
}

export function Cluster({ platform, serviceId, onSelectService, send }: ClusterProps) {
  // Fall back to the first service if the selected one vanished (e.g. after a reset).
  const service = platform.services.find((s) => s.id === serviceId) ?? platform.services[0];
  if (!service) {
    return <p className="text-sm text-muted-foreground">No services to show.</p>;
  }

  const util = utilisationPct(service);
  const p95 = p95LatencyMs(service);
  const err = errorRatePct(service);
  const healthy = servingInstances(service.instances).length;

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
      <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Traffic" value={Math.round(service.currentRps)} unit="req/s" />
        <Stat label="Utilisation" value={fmtPct(util)} unit="%" tone={utilTone(util)} />
        <Stat label="Healthy" value={healthy} unit={`/ ${service.autoscale.max} max`} />
        <Stat label="p95 latency" value={p95} unit="ms" tone={latencyTone(p95)} />
        <Stat label="Error rate" value={err.toFixed(1)} unit="%" tone={errTone(err)} />
        <Stat label="Cost" value={`$${costPerHour(service).toFixed(2)}`} unit="/hr" />
      </section>

      {/* Desktop: two columns.
            left  : traffic controls, charts, event log
            right : instances (beside the traffic controls), nginx.conf, config
          The nginx panel sits right under the instance list because it is generated
          from exactly those instances: each one appears as a `server` line.

          Phones: one column. The two column wrappers use `max-lg:contents`, which
          makes them vanish from the layout so every panel becomes a direct child of
          the grid and can be re-ordered with `order-N`. That gives the phone order
          traffic -> instances -> charts -> nginx -> events -> config, instead of
          burying the instance list under the charts.

          `min-w-0` lets tables and charts shrink instead of forcing the page to
          scroll sideways. Spacing: `gap-4` on the grid covers phones, and
          `lg:space-y-4` covers the stacked panels inside each desktop column. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-1 min-w-0 lg:order-none">
            <TrafficControls service={service} send={send} />
          </div>
          <div className="order-3 min-w-0 lg:order-none">
            <Charts service={service} />
          </div>
          <div className="order-5 min-w-0 lg:order-none">
            <EventLog events={platform.events} serviceId={service.id} />
          </div>
        </div>
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-2 min-w-0 lg:order-none">
            <InstanceTable service={service} />
          </div>
          <div className="order-4 min-w-0 lg:order-none">
            <NginxView service={service} />
          </div>
          <div className="order-6 min-w-0 lg:order-none">
            <ConfigPanel service={service} send={send} />
          </div>
        </div>
      </div>
    </div>
  );
}
