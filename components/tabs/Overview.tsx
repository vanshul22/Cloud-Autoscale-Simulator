"use client";

import { ChevronRight } from "lucide-react";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { Stat, errTone, fmtPct, latencyTone, utilTone } from "@/components/shared/Stat";
import { costPerHour, errorRatePct, p95LatencyMs, servingInstances, utilisationPct } from "@/lib/engine/metrics";
import type { Platform } from "@/lib/engine/types";

interface OverviewProps {
  platform: Platform;
  onSelect: (serviceId: string) => void;
}

export function Overview({ platform, onSelect }: OverviewProps) {
  // Platform-wide totals: sum the per-service numbers the engine already derives.
  const totalRps = platform.services.reduce((n, s) => n + s.currentRps, 0);
  const totalInstances = platform.services.reduce((n, s) => n + s.instances.length, 0);
  const totalCost = platform.services.reduce((n, s) => n + costPerHour(s), 0);

  return (
    <div className="space-y-4">
      {/* Totals row: the "whole platform at a glance" strip. */}
      <section aria-label="Platform totals" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Total traffic" value={Math.round(totalRps)} unit="req/s" />
        <Stat label="Total instances" value={totalInstances} />
        <Stat label="Total spend" value={`$${totalCost.toFixed(2)}`} unit="/hr" />
      </section>

      <section aria-label="Services" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {platform.services.map((svc) => {
          const util = utilisationPct(svc);
          const p95 = p95LatencyMs(svc);
          const err = errorRatePct(svc);
          const healthy = servingInstances(svc.instances).length;
          return (
            // A real <button> so it is keyboard-focusable and announced as clickable.
            <button
              key={svc.id}
              type="button"
              onClick={() => onSelect(svc.id)}
              className="group min-w-0 rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              aria-label={`Open ${svc.name} autoscaling cluster`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">{svc.name}</h2>
                  <p className="truncate font-mono text-xs text-muted-foreground">{svc.domain}</p>
                </div>
                <StatusBadge status={svc.status} className="shrink-0" />
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Traffic" value={Math.round(svc.currentRps)} unit="req/s" />
                <Stat label="Healthy" value={`${healthy}/${svc.instances.length}`} />
                <Stat label="Util" value={fmtPct(util)} unit="%" tone={utilTone(util)} />
                <Stat label="p95" value={p95} unit="ms" tone={latencyTone(p95)} />
                <Stat label="Errors" value={err.toFixed(1)} unit="%" tone={errTone(err)} />
                <Stat label="Cost" value={`$${costPerHour(svc).toFixed(2)}`} unit="/hr" />
              </div>

              <div className="mt-3 flex items-center justify-end gap-1 text-xs text-muted-foreground group-hover:text-primary">
                Open cluster <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </div>
            </button>
          );
        })}
      </section>

      <p className="text-xs text-muted-foreground">Select a service to open its autoscaling cluster.</p>
    </div>
  );
}
