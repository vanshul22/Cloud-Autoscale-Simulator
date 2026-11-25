"use client";

// =============================================================================
// Scheduled.tsx  —  The "Scheduled Scaling" tab: capacity limits that follow the clock.
//
// What it teaches: a reactive autoscaler only reacts AFTER load arrives, and new
// instances take a few ticks to boot. If traffic is predictable (busy 09:00-18:00,
// quiet at night) you can change the autoscaler's min/max limits ahead of time, and
// even start early (pre-warm) so capacity is already warm when the rush starts.
// This tab lets you build those windows, jump the simulated clock, and compare the
// plan with what really happened over the 24-hour day.
// =============================================================================

import { AlertTriangle, Clock, Lightbulb, TrendingUp } from "lucide-react";
import { useState } from "react";

import { DayTimeline } from "@/components/shared/scheduled/DayTimeline";
import { ScheduleForm } from "@/components/shared/scheduled/ScheduleForm";
import { ScheduleList } from "@/components/shared/scheduled/ScheduleList";
import { Stat } from "@/components/shared/Stat";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Command } from "@/lib/engine/commands";
import { effectiveBounds, formatMinute, nextChange } from "@/lib/engine/scheduler";
import type { Platform } from "@/lib/engine/types";

interface ScheduledTabProps {
  platform: Platform;
  serviceId: string | null;
  /** Lets the service selector change the shared selection held by Dashboard. */
  onSelectService?: (serviceId: string) => void;
  send: (c: Command) => Promise<void>;
}

/** 50 -> "50 min", 135 -> "2h 15m". Keeps the "Next change" tile short. */
function fmtAhead(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}m`;
}

export function ScheduledTab({ platform, serviceId, onSelectService, send }: ScheduledTabProps) {
  // Fall back to the first service if the selected one vanished (e.g. after a reset).
  const service = platform.services.find((s) => s.id === serviceId) ?? platform.services[0];
  if (!service) {
    return <p className="text-sm text-muted-foreground">No services to show.</p>;
  }

  // Whole minutes only: the engine's helpers compare against integer minutes.
  const clock = Math.floor(platform.clockMinutes);
  const base = { min: service.autoscale.min, max: service.autoscale.max };
  // The limits in force RIGHT NOW (a window's, or the normal ones), and when they
  // next change. Both come from the engine's own helpers so the UI can never
  // disagree with what the autoscaler actually does.
  const now = effectiveBounds(service.schedules, clock, base);
  const next = nextChange(service.schedules, clock, base);
  const healthy = service.instances.filter((i) => i.status === "healthy").length;

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
      <section aria-label="Scheduled scaling metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Sim clock" value={formatMinute(clock)} />
        <Stat
          label="Window now"
          value={<span title={now.source?.note}>{now.source ? now.source.note : "none"}</span>}
          unit={now.phase === "prewarm" ? "pre-warm" : undefined}
          tone={now.phase === "active" ? "good" : "default"}
        />
        <Stat
          label="Instance limits"
          value={`${now.min}-${now.max}`}
          // When a window overrides the limits, remind the reader what "normal" is.
          unit={now.source ? `normally ${base.min}-${base.max}` : "normal limits"}
        />
        <Stat
          label="Next change"
          value={next ? `in ${fmtAhead(next.inMinutes)}` : "none"}
          unit={next ? `to ${next.to.min}-${next.to.max}` : undefined}
        />
        <Stat label="Healthy now" value={healthy} unit={`/ ${service.instances.length}`} />
        <Stat label="Traffic" value={Math.round(service.currentRps)} unit="req/s" />
      </section>

      {/* The timeline spans the full width. */}
      <DayTimeline service={service} clockMinutes={clock} />

      {/* Same layout trick as Queue and Reliability: two columns on desktop (left:
          list + form; right: clock + about). On phones the column wrappers vanish
          (`max-lg:contents`) so `order-N` sets one linear order: clock, list, form, about. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-2 min-w-0 lg:order-none">
            <ScheduleList service={service} clockMinutes={clock} send={send} />
          </div>
          <div className="order-3 min-w-0 lg:order-none">
            <ScheduleForm service={service} send={send} />
          </div>
        </div>
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-1 min-w-0 lg:order-none">
            <ClockCard
              serviceId={service.id}
              clock={clock}
              autoscaleOff={service.autoscale.enabled === false}
              send={send}
            />
          </div>
          <div className="order-4 min-w-0 lg:order-none">
            <AboutCard />
          </div>
        </div>
      </div>
    </div>
  );
}

// Jump targets, each chosen to sit just BEFORE something interesting in the presets:
// 08:45 is before the 09:00 morning rise, 11:55 before the 12:00 lunch rush / flash
// sale, 17:55 before the evening, 22:45 before the Night window opens at 23:00, and
// 03:00 is a quiet night hour to watch the low limits.
const JUMPS = [
  { label: "08:45", minutes: 8 * 60 + 45 },
  { label: "11:55", minutes: 11 * 60 + 55 },
  { label: "17:55", minutes: 17 * 60 + 55 },
  { label: "22:45", minutes: 22 * 60 + 45 },
  { label: "03:00", minutes: 3 * 60 },
] as const;

/** Time travel: the clock is the star of this tab, so it gets its own controls. */
function ClockCard({
  serviceId,
  clock,
  autoscaleOff,
  send,
}: {
  serviceId: string;
  clock: number;
  autoscaleOff: boolean;
  send: (c: Command) => Promise<void>;
}) {
  // Disables the buttons while a request is in flight, so a double click can't fire twice.
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false); // `finally` re-enables the buttons even if the request throws
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4" aria-hidden="true" /> Time travel
        </CardTitle>
        <CardDescription>Jump the simulated clock to just before a window opens.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Big mono time: fixed-width digits so it never shifts the layout. */}
        <div className="font-mono text-4xl font-semibold tabular-nums" aria-label={`Simulated time ${formatMinute(clock)}`}>
          {formatMinute(clock)}
        </div>

        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Jump to</div>
          <div className="flex flex-wrap gap-2">
            {JUMPS.map((j) => (
              <Button
                key={j.label}
                size="sm"
                variant="outline"
                className="font-mono tabular-nums"
                disabled={busy}
                aria-pressed={clock === j.minutes}
                onClick={() => void run(() => send({ type: "setClock", minutes: j.minutes }))}
              >
                {j.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Two commands in a row: the "daily" pattern multiplies the base load by the
            time-of-day curve, so it needs a sensible base (250 req/s) to look good.
            Awaiting the first makes sure they are applied in order. */}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await send({ type: "setTraffic", serviceId, rps: 250 });
              await send({ type: "setPattern", serviceId, pattern: "daily" });
            })
          }
        >
          <TrendingUp aria-hidden="true" /> Use the daily traffic curve
        </Button>

        <p className="text-xs text-muted-foreground">
          Use the 1x / 5x / 60x buttons in the header. At 60x a whole day takes about 24 seconds.
        </p>

        {/* Schedules only move the autoscaler's limits. With the autoscaler off,
            nothing reads those limits, so say so in words (not just colour). */}
        {autoscaleOff && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 px-3 py-2 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--warning))]" aria-hidden="true" />
            <span>
              Autoscaling is switched off: schedules only change the limits the autoscaler works inside, so they do
              nothing until you switch it on (Cluster tab &gt; config).
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Why schedules exist, the one rule to remember, a warning, and three experiments. */
function AboutCard() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="h-4 w-4" aria-hidden="true" /> About this tab
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Why schedules?</span> A reactive autoscaler only adds capacity
          after the load has arrived, so it is always a little late. A schedule has the capacity ready first: no lag.
          Pre-warm goes one step further and starts the window early, because new instances take about 3 ticks to boot.
        </p>
        <p>
          <span className="font-medium text-foreground">Overlaps.</span> A window changes the autoscaler&apos;s min and
          max limits; the autoscaler still reacts to traffic inside them. If two windows cover the same minute, the
          first one in the list wins, so list order is priority.
        </p>
        <div
          role="note"
          className="flex items-start gap-2 rounded-lg border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 px-3 py-2 text-foreground"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--warning))]" aria-hidden="true" />
          <span>
            <span className="font-medium">Caution:</span> A limit that is too tight hurts: a night window that starts
            while evening traffic is still high can leave too few instances and slow everything down.
          </span>
        </div>
        <div>
          <h3 className="mb-1.5 font-medium text-foreground">Try it</h3>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              Click &quot;Use the daily traffic curve&quot;, add the Business day and Night presets, set the speed to
              60x and watch the instances follow the schedule.
            </li>
            <li>
              Jump the clock to 11:55 with the Flash sale preset added, and set Spike in the Cluster tab at 12:00.
            </li>
            <li>Use the arrow buttons to move the Lunch rush above Business day and see the priority change.</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
