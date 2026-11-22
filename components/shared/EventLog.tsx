"use client";

// =============================================================================
// EventLog.tsx  —  The scrolling "what just happened" stream.
//
// Events arrive newest-first from the engine. Two UX details matter here:
//  1. Level is shown by ICON + TEXT COLOUR + a screen-reader label, never colour
//     alone (colour-blind users, and light/dark themes shift hues).
//  2. New events are inserted at the TOP. If you've scrolled down to read an old
//     line, the browser would normally leave scrollTop alone and the content you
//     were reading would slide down out of view. We compensate so it stays put.
// =============================================================================

import { useLayoutEffect, useMemo, useRef } from "react";
import { CircleX, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQueryState } from "@/hooks/useQueryState";
import type { SimEvent } from "@/lib/engine/types";

type Level = SimEvent["level"];
type Filter = "all" | Level;

const MAX_ROWS = 100; // rendering thousands of rows would slow every tick

// Icon + colour + spoken label per level. Colours are Tailwind's mid-tones with
// a lighter dark-mode variant so contrast holds in both themes.
const LEVELS: Record<Level, { icon: LucideIcon; label: string; className: string }> = {
  info: { icon: Info, label: "Info", className: "text-sky-600 dark:text-sky-400" },
  warn: { icon: TriangleAlert, label: "Warning", className: "text-amber-600 dark:text-amber-400" },
  error: { icon: CircleX, label: "Error", className: "text-red-600 dark:text-red-400" },
};

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "info", label: "Info" },
  { id: "warn", label: "Warn" },
  { id: "error", label: "Error" },
];

export function EventLog({ events, serviceId }: { events: SimEvent[]; serviceId?: string }) {
  // The level chips live in the URL (?level=error) so a refresh keeps the filter.
  const [filter, setFilter] = useQueryState<Filter>(
    "level",
    "all",
    FILTERS.map((f) => f.id),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const prevHeight = useRef(0); // viewport scrollHeight before the last update

  // 1) Scope to this service (plus platform-wide events), if one is selected.
  const scoped = useMemo(
    () => (serviceId ? events.filter((e) => e.service === serviceId || e.service === "platform") : events),
    [events, serviceId],
  );

  // Per-level counts for the chips (computed on the scoped list, before the
  // level filter, so the numbers don't change when you click a chip).
  const counts = useMemo(() => {
    const c = { all: scoped.length, info: 0, warn: 0, error: 0 };
    for (const e of scoped) c[e.level]++;
    return c;
  }, [scoped]);

  // 2) Apply the level filter, then cap how many rows we render.
  const rows = useMemo(() => {
    const filtered = filter === "all" ? scoped : scoped.filter((e) => e.level === filter);
    // Stable React keys: events have no id, so key = content + "nth duplicate".
    // Counting from the OLDEST end means an event keeps its key as newer ones
    // are added on top (index-based keys would shift and re-render every row).
    const seen = new Map<string, number>();
    const keyed: { e: SimEvent; key: string }[] = [];
    for (let i = filtered.length - 1; i >= 0; i--) {
      const e = filtered[i];
      const base = `${e.t}|${e.service}|${e.level}|${e.msg}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      keyed.push({ e, key: `${base}#${n}` });
    }
    keyed.reverse(); // back to newest-first
    return { list: keyed.slice(0, MAX_ROWS), total: filtered.length };
  }, [scoped, filter]);

  // Keep the reader's place when rows are added above them. useLayoutEffect runs
  // after the DOM updates but BEFORE paint, so there's no visible jump.
  useLayoutEffect(() => {
    const vp = rootRef.current?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (!vp) return;
    vp.style.overflowAnchor = "none"; // stop the browser also adjusting (would double-correct)
    const grew = vp.scrollHeight - prevHeight.current;
    // scrollTop === 0 means "following the newest": leave it pinned to the top.
    if (vp.scrollTop > 0 && prevHeight.current > 0 && grew !== 0) vp.scrollTop += grew;
    prevHeight.current = vp.scrollHeight;
  }, [rows.list]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>Event log</CardTitle>
        {/* Level filter chips. aria-pressed tells screen readers which is active. */}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by level">
          {FILTERS.map((f) => (
            <Button
              key={f.id}
              type="button"
              size="sm"
              variant={filter === f.id ? "default" : "outline"}
              className="h-7 rounded-full px-3 text-xs"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span className="ml-1.5 tabular-nums opacity-70">{counts[f.id]}</span>
            </Button>
          ))}
        </div>
      </CardHeader>

      <CardContent>
        {/* Fixed height so the card never grows as events stream in. */}
        <ScrollArea ref={rootRef} className="h-[360px] rounded-md border">
          {rows.list.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {scoped.length === 0 ? "No events yet." : "No events match this filter."}
            </p>
          ) : (
            // role="log" is the ARIA role for append-only message streams.
            <ol role="log" aria-label="Simulation events" className="divide-y text-sm">
              {rows.list.map(({ e, key }) => {
                const lv = LEVELS[e.level];
                const Icon = lv.icon;
                return (
                  // select-text: the shell/UI may disable selection elsewhere;
                  // log lines are things people want to copy.
                  <li key={key} className="flex select-text items-start gap-2 px-3 py-1.5">
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${lv.className}`} aria-hidden />
                    <span className="sr-only">{lv.label}:</span>
                    {/* Tick label in mono + tabular figures so the column lines up. */}
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      t={String(e.t).padStart(4, "0")}
                    </span>
                    <Badge
                      variant="outline"
                      className="shrink-0 px-1.5 py-0 font-mono text-[10px] font-normal"
                    >
                      {e.service}
                    </Badge>
                    {/* break-words so a long message wraps instead of widening the page */}
                    <span className="min-w-0 break-words">{e.msg}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </ScrollArea>
        {rows.total > MAX_ROWS && (
          <p className="mt-2 text-xs text-muted-foreground">
            Showing the newest {MAX_ROWS} of {rows.total} events.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
