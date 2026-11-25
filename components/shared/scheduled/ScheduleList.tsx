"use client";

// =============================================================================
// ScheduleList.tsx  —  The schedule windows, in priority order, plus quick presets.
//
// The list ORDER matters: when two windows cover the same minute, the engine uses
// the FIRST one (see effectiveBounds in scheduler.ts). So the up/down buttons are
// not cosmetic: they change which window wins an overlap.
//
// This component only renders and sends commands; the server owns the schedules and
// the next snapshot flows back down as new props.
// =============================================================================

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { Command } from "@/lib/engine/commands";
// A plain constant, safe to import as a value (same pattern as MAX_RPS).
import { MAX_SCHEDULES } from "@/lib/engine/commands";
import { formatMinute, windowPhase } from "@/lib/engine/scheduler";
import type { Schedule, Service } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

// One-click windows. Kept as data so the JSX is just a .map(). Times are minutes
// since midnight (07:00 = 420), the same unit the engine uses.
const PRESETS: { label: string; blurb: string; schedule: Pick<Schedule, "fromMin" | "toMin" | "min" | "max" | "note" | "prewarmMin"> }[] = [
  {
    label: "Business day",
    blurb: "07:00-22:00, min 5, max 12, pre-warm 10",
    schedule: { note: "Business day", fromMin: 7 * 60, toMin: 22 * 60, min: 5, max: 12, prewarmMin: 10 },
  },
  {
    // 23:00 > 07:00, so this one crosses midnight.
    label: "Night",
    blurb: "23:00-07:00, min 1, max 4",
    schedule: { note: "Night", fromMin: 23 * 60, toMin: 7 * 60, min: 1, max: 4, prewarmMin: 0 },
  },
  {
    label: "Lunch rush",
    blurb: "12:00-14:00, min 8, max 12, pre-warm 10",
    schedule: { note: "Lunch rush", fromMin: 12 * 60, toMin: 14 * 60, min: 8, max: 12, prewarmMin: 10 },
  },
  {
    label: "Flash sale",
    blurb: "12:00-12:40, min 8, max 12, pre-warm 10",
    schedule: { note: "Flash sale", fromMin: 12 * 60, toMin: 12 * 60 + 40, min: 8, max: 12, prewarmMin: 10 },
  },
];

// Status pills. The label is always TEXT; the tint is only a hint (never colour alone).
const PILL = {
  active: { label: "active now", cls: "text-[hsl(var(--success))] bg-[hsl(var(--success)/0.12)] border-[hsl(var(--success)/0.3)]" },
  prewarm: { label: "pre-warming", cls: "text-[hsl(var(--info))] bg-[hsl(var(--info)/0.12)] border-[hsl(var(--info)/0.3)]" },
  idle: { label: "idle", cls: "text-muted-foreground bg-muted/40 border-border" },
  disabled: { label: "disabled", cls: "text-muted-foreground bg-muted/40 border-border" },
} as const;

export function ScheduleList({
  service,
  clockMinutes,
  send,
}: {
  service: Service;
  clockMinutes: number;
  send: (c: Command) => Promise<void>;
}) {
  const { schedules } = service;
  const atLimit = schedules.length >= MAX_SCHEDULES;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Schedule windows, in priority order</CardTitle>
        <CardDescription>If windows overlap, the first one in this list wins.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {schedules.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            No windows yet, so the autoscaler always uses its normal limits ({service.autoscale.min}-
            {service.autoscale.max}). Add one with a quick preset below, or build your own in the form.
          </p>
        ) : (
          <ul className="space-y-2">
            {schedules.map((s, i) => {
              // Where is the clock relative to THIS window? A disabled window is
              // reported as "disabled" (windowPhase says "off" for it too).
              const phase = windowPhase(s, clockMinutes);
              const status = s.enabled === false ? "disabled" : phase === "active" ? "active" : phase === "prewarm" ? "prewarm" : "idle";
              const pill = PILL[status];
              const crossesMidnight = s.fromMin > s.toMin;
              return (
                <li
                  key={s.id}
                  className={cn(
                    "flex flex-col gap-2 rounded-lg border bg-card/60 p-3 sm:flex-row sm:items-center sm:justify-between",
                    s.enabled === false && "opacity-70",
                  )}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="break-words text-sm font-medium">{s.note}</span>
                      <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", pill.cls)}>
                        {pill.label}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="font-mono tabular-nums text-foreground">
                        {formatMinute(s.fromMin)} - {formatMinute(s.toMin)}
                      </span>
                      {crossesMidnight && <span className="rounded bg-muted px-1.5 py-0.5">crosses midnight</span>}
                      <span className="tabular-nums">
                        {s.min}-{s.max} instances
                      </span>
                      {(s.prewarmMin ?? 0) > 0 && <span className="tabular-nums">pre-warm {s.prewarmMin} min</span>}
                    </div>
                  </div>

                  {/* Controls. aria-labels name the window so a screen reader user
                      hears WHICH row a button acts on. */}
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={s.enabled !== false}
                      aria-label={`Enable ${s.note}`}
                      onCheckedChange={(on) =>
                        void send({ type: "updateSchedule", serviceId: service.id, scheduleId: s.id, patch: { enabled: on } })
                      }
                      className="mr-2"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      aria-label={`Move ${s.note} up (higher priority)`}
                      disabled={i === 0}
                      onClick={() => void send({ type: "moveSchedule", serviceId: service.id, scheduleId: s.id, direction: "up" })}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      aria-label={`Move ${s.note} down (lower priority)`}
                      disabled={i === schedules.length - 1}
                      onClick={() => void send({ type: "moveSchedule", serviceId: service.id, scheduleId: s.id, direction: "down" })}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      aria-label={`Remove ${s.note}`}
                      onClick={() => void send({ type: "removeSchedule", serviceId: service.id, scheduleId: s.id })}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Quick add: presets so you can see a schedule working without typing. */}
        <section aria-labelledby={`${service.id}-quickadd`} className="space-y-2 border-t pt-4">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id={`${service.id}-quickadd`} className="text-sm font-medium">
              Quick add
            </h3>
            <span className="text-xs tabular-nums text-muted-foreground">
              {schedules.length} / {MAX_SCHEDULES} windows
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                variant="outline"
                size="sm"
                disabled={atLimit}
                // The default button is nowrap and one line tall; presets have a
                // second line of detail, so let them wrap and grow.
                className="h-auto flex-col items-start gap-0.5 whitespace-normal py-2 text-left"
                onClick={() => void send({ type: "addSchedule", serviceId: service.id, schedule: p.schedule })}
              >
                <span className="text-sm">{p.label}</span>
                <span className="text-xs font-normal text-muted-foreground tabular-nums">{p.blurb}</span>
              </Button>
            ))}
          </div>
          {atLimit && (
            <p className="text-xs text-muted-foreground">
              A service can have at most {MAX_SCHEDULES} windows. Remove one to add another.
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
