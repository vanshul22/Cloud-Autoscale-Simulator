"use client";

// =============================================================================
// Events.tsx  —  The "Events & Alerts" tab: how a platform tells people something is wrong.
//
// What it teaches: raw numbers are not enough, someone has to be TOLD. But telling
// people too eagerly teaches them to ignore you. So an alert rule must hold for a "for"
// time before it fires (pending -> firing -> resolved), and an SLO turns "how reliable
// are we?" into an error budget you can spend, with a burn rate that says how fast.
// This tab shows the live alerts, the rules behind them, the SLO and the full event stream.
//
// All state lives on the server; this file only arranges cards and passes props down.
// =============================================================================

import { Lightbulb } from "lucide-react";

import { ActiveAlerts } from "@/components/shared/events/ActiveAlerts";
import { AlertHistory } from "@/components/shared/events/AlertHistory";
import { AlertRules } from "@/components/shared/events/AlertRules";
import { EventStream } from "@/components/shared/events/EventStream";
import { SloPanel } from "@/components/shared/events/SloPanel";
import { Stat } from "@/components/shared/Stat";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { defaultAlertRules, sloSummary } from "@/lib/engine/alerts";
import type { Command } from "@/lib/engine/commands";
import type { Platform } from "@/lib/engine/types";

interface EventsTabProps {
  platform: Platform;
  serviceId: string | null;
  /** Lets the service selector change the shared selection held by Dashboard. */
  onSelectService?: (serviceId: string) => void;
  send: (c: Command) => Promise<void>;
}

export function EventsTab({ platform, serviceId, onSelectService, send }: EventsTabProps) {
  // Fall back to the first service if the selected one vanished (after a reset or shutdown).
  const service = platform.services.find((s) => s.id === serviceId) ?? platform.services[0];
  if (!service) {
    return <p className="text-sm text-muted-foreground">No services to show.</p>;
  }

  // These three are optional: a world saved before alerting existed has none until its
  // first tick. `?? []` keeps the tab working; the rules fall back to the built-in
  // defaults (the same ones the engine installs) purely for display.
  const alerts = platform.alerts ?? [];
  const rules = platform.alertRules ?? defaultAlertRules();
  const history = platform.alertHistory ?? [];

  const firing = alerts.filter((a) => a.state === "firing");
  const pending = alerts.length - firing.length;
  // Severity comes from the rule, not the alert, so look each firing alert's rule up.
  const critical = firing.filter((a) => rules.find((r) => r.id === a.ruleId)?.severity === "critical").length;

  const slo = sloSummary(service, platform.tick);

  return (
    <div className="space-y-4">
      {/* Title row (or a service switcher when there are several). It picks which
          service the SLO card and the SLO tiles below describe. */}
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

      {/* KPI row: 2 cols on phones, 3 on tablets, 6 on desktop. Tone is only a hint:
          every tile also prints its number. */}
      <section aria-label="Alert and SLO metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Firing"
          value={firing.length}
          unit={`${critical} critical, ${firing.length - critical} warning`}
          tone={firing.length > 0 ? "bad" : "default"}
        />
        <Stat label="Pending" value={pending} />
        {/* The unit is kept short ("/ 99.5%") so the tile never overflows on a phone. */}
        <Stat
          label="SLO availability"
          value={`${slo.availability.toFixed(2)}%`}
          unit={`/ ${slo.target}%`}
          tone={slo.met ? "default" : "bad"}
        />
        <Stat
          label="Error budget left"
          value={slo.budgetRemainingPct.toFixed(0)}
          unit="%"
          tone={slo.budgetRemainingPct <= 0 ? "bad" : slo.budgetRemainingPct < 25 ? "warn" : "default"}
        />
        <Stat
          label="Burn rate"
          value={slo.burnRate.toFixed(1)}
          unit="x"
          tone={slo.burnRate > 2 ? "bad" : slo.burnRate > 1 ? "warn" : "default"}
        />
        {/* The engine keeps only the newest 120 events (older ones fall off the end). */}
        <Stat label="Events in log" value={platform.events.length} unit="of 120" />
      </section>

      {/* Same layout trick as Reliability and Deployments: two columns on desktop (left:
          alerts, stream, history; right: SLO, rules, try it). On phones the column
          wrappers vanish (`max-lg:contents`) so `order-N` sets one linear order:
          alerts, SLO, stream, rules, history, try it. (Full class names, so Tailwind
          can see them.) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-1 min-w-0 lg:order-none">
            <ActiveAlerts alerts={alerts} rules={rules} services={platform.services} tick={platform.tick} send={send} />
          </div>
          <div className="order-3 min-w-0 lg:order-none">
            <EventStream events={platform.events} services={platform.services} />
          </div>
          <div className="order-5 min-w-0 lg:order-none">
            <AlertHistory history={history} rules={rules} services={platform.services} />
          </div>
        </div>
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-2 min-w-0 lg:order-none">
            <SloPanel service={service} tick={platform.tick} send={send} />
          </div>
          <div className="order-4 min-w-0 lg:order-none">
            <AlertRules rules={rules} services={platform.services} send={send} />
          </div>
          <div className="order-6 min-w-0 lg:order-none">
            <TryIt />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Three experiments: alerting only makes sense once you have watched one fire. */
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
          <li>
            In the Cluster config set Max instances to 2, then push traffic to 160 req/s: watch Slow responses and
            Capacity nearly full go pending, then firing; then High error rate. Acknowledge one.
          </li>
          <li>
            Set Capacity nearly full to &apos;for 1 tick&apos; and see it fire immediately; set it back to 5 and note it
            takes longer: that is the &apos;for&apos; clause.
          </li>
          <li>Raise the SLO target to 99.9 and watch the error budget shrink.</li>
        </ul>
      </CardContent>
    </Card>
  );
}
