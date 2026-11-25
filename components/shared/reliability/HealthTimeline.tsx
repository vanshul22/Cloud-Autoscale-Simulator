"use client";

// =============================================================================
// HealthTimeline.tsx  —  The failure-and-recovery story, one line per step.
//
// Reads the same event stream as the Event log tab but keeps ONLY events the engine
// tagged `kind: "health"` (a check failed, an instance was pulled from nginx, a
// restart, the breaker opening...). The Event log already has level filter chips, so
// this card deliberately has none: it is a focused "what just broke and healed" view.
// =============================================================================

import { Activity, CircleX, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { useMemo } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { SimEvent } from "@/lib/engine/types";

const MAX_ROWS = 60; // plenty to follow one incident; keeps each render cheap

// Icon + colour + spoken label per level: never colour alone.
const LEVELS: Record<SimEvent["level"], { icon: LucideIcon; label: string; className: string }> = {
  info: { icon: Info, label: "Info", className: "text-sky-600 dark:text-sky-400" },
  warn: { icon: TriangleAlert, label: "Warning", className: "text-amber-600 dark:text-amber-400" },
  error: { icon: CircleX, label: "Error", className: "text-red-600 dark:text-red-400" },
};

export function HealthTimeline({ events, serviceId }: { events: SimEvent[]; serviceId: string }) {
  const rows = useMemo(() => {
    // Events arrive newest first, so filtering then slicing keeps the newest 60.
    const mine = events.filter(
      (e) => e.kind === "health" && (e.service === serviceId || e.service === "platform"),
    );
    // Stable React keys: events have no id, so key = content + "nth duplicate",
    // counted from the OLDEST end so an event keeps its key as newer ones arrive.
    const seen = new Map<string, number>();
    const keyed: { e: SimEvent; key: string }[] = [];
    for (let i = mine.length - 1; i >= 0; i--) {
      const e = mine[i];
      const base = `${e.t}|${e.service}|${e.level}|${e.msg}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      keyed.push({ e, key: `${base}#${n}` });
    }
    keyed.reverse(); // back to newest first
    return keyed.slice(0, MAX_ROWS);
  }, [events, serviceId]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" aria-hidden="true" /> Health timeline
        </CardTitle>
        <CardDescription>Newest first. Each line is one step of detecting, removing or restarting.</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Fixed height so the card never grows as events stream in. */}
        <ScrollArea className="h-[360px] rounded-md border">
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No failures yet. Break something!</p>
          ) : (
            <ol role="log" aria-label="Health events" className="divide-y text-sm">
              {rows.map(({ e, key }) => {
                const lv = LEVELS[e.level];
                const Icon = lv.icon;
                return (
                  <li key={key} className="flex select-text items-start gap-2 px-3 py-1.5">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${lv.className}`} aria-hidden />
                    <span className="sr-only">{lv.label}:</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      t={String(e.t).padStart(4, "0")}
                    </span>
                    {/* break-words so a long message wraps instead of widening the page */}
                    <span className="min-w-0 break-words">{e.msg}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
