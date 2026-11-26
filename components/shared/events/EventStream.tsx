"use client";

// =============================================================================
// EventStream.tsx  —  Every event the platform keeps, filterable and exportable.
//
// The engine keeps the newest 120 events. This card adds four filters (service,
// level, kind, text search) that live in the URL query string (?esvc=&elevel=&ekind=
// &eq=) so a refresh or a shared link keeps the same view. Filtering is pure:
// `visible` is derived from the events and the filters, nothing is stored twice.
//
// Level is shown by icon + a printed word (never colour alone), like EventLog.
// =============================================================================

import { CircleX, Download, Info, Search, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQueryState } from "@/hooks/useQueryState";
import type { Service, SimEvent } from "@/lib/engine/types";

type Level = SimEvent["level"];
type LevelFilter = "all" | Level;
// "log" is our own word for "an event with no kind" (routine activity, not a story step).
type KindTag = "status" | "health" | "deploy" | "alert" | "log";
type KindFilter = "all" | KindTag;

const LEVEL_IDS: readonly LevelFilter[] = ["all", "info", "warn", "error"];
const KIND_IDS: readonly KindFilter[] = ["all", "status", "health", "deploy", "alert", "log"];

const LEVELS: Record<Level, { icon: LucideIcon; label: string; className: string }> = {
  info: { icon: Info, label: "info", className: "text-sky-600 dark:text-sky-400" },
  warn: { icon: TriangleAlert, label: "warn", className: "text-amber-600 dark:text-amber-400" },
  error: { icon: CircleX, label: "error", className: "text-red-600 dark:text-red-400" },
};

const kindOf = (e: SimEvent): KindTag => e.kind ?? "log";

interface Filters {
  svc: string; // service id, "platform", or "all"
  level: LevelFilter;
  kind: KindFilter;
  q: string; // lower-cased search text
}

/**
 * Does one event pass the filters? Taking the filters as an argument (instead of
 * reading state) lets us reuse it for the chip counts: to count "how many errors" we
 * apply every filter EXCEPT level.
 */
function matches(e: SimEvent, f: Filters, names: Map<string, string>): boolean {
  if (f.svc !== "all" && e.service !== f.svc) return false;
  if (f.level !== "all" && e.level !== f.level) return false;
  if (f.kind !== "all" && kindOf(e) !== f.kind) return false;
  if (f.q) {
    // Search the message, the service (id and display name) and the kind word.
    const hay = `${e.msg} ${e.service} ${names.get(e.service) ?? ""} ${kindOf(e)}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

export function EventStream({ events, services }: { events: SimEvent[]; services: Service[] }) {
  // The four filters, kept in the URL. Defaults are not written to it.
  const [svcParam, setSvc] = useQueryState<string>("esvc", "all");
  const [level, setLevel] = useQueryState<LevelFilter>("elevel", "all", LEVEL_IDS);
  const [kind, setKind] = useQueryState<KindFilter>("ekind", "all", KIND_IDS);
  const [qParam, setQ] = useQueryState<string>("eq", "");
  // The text box has its own draft so typing never waits on the URL round-trip
  // (a controlled input fed by async state can make the caret jump).
  const [draft, setDraft] = useState(qParam);

  // id -> display name, rebuilt only when the services change. A Map (not a function)
  // keeps the useMemo dependency lists below honest.
  const names = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);
  const svcName = (id: string) => names.get(id) ?? id;
  // A stale link (?esvc=gone) falls back to "all" instead of showing an empty list.
  const svc = svcParam === "all" || svcParam === "platform" || services.some((s) => s.id === svcParam) ? svcParam : "all";
  const q = qParam.trim().toLowerCase();
  const active = svc !== "all" || level !== "all" || kind !== "all" || q !== "";

  // Chip counts: each group counts with every OTHER filter applied, so the numbers
  // answer "if I click this chip, how many rows will I see?".
  const levelCounts = useMemo(() => {
    const c: Record<LevelFilter, number> = { all: 0, info: 0, warn: 0, error: 0 };
    for (const e of events) {
      if (!matches(e, { svc, level: "all", kind, q }, names)) continue;
      c.all++;
      c[e.level]++;
    }
    return c;
  }, [events, names, svc, kind, q]);

  const kindCounts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: 0, status: 0, health: 0, deploy: 0, alert: 0, log: 0 };
    for (const e of events) {
      if (!matches(e, { svc, level, kind: "all", q }, names)) continue;
      c.all++;
      c[kindOf(e)]++;
    }
    return c;
  }, [events, names, svc, level, q]);

  // The rows to show, newest first (the engine's order), each with a stable React key.
  const visible = useMemo(() => {
    const list = events.filter((e) => matches(e, { svc, level, kind, q }, names));
    // Events have no id, so key = content + "nth duplicate". Counting from the OLDEST
    // end means a row keeps its key as newer events are added on top.
    const seen = new Map<string, number>();
    const keyed: { e: SimEvent; key: string }[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      const base = `${e.t}|${e.service}|${e.level}|${e.msg}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      keyed.push({ e, key: `${base}#${n}` });
    }
    return keyed.reverse();
  }, [events, names, svc, level, kind, q]);

  // New events are inserted at the TOP. If you scrolled down to read an old line, the
  // content would slide away, so we add the growth to scrollTop (before paint, so there
  // is no visible jump). scrollTop 0 means "following the newest": leave it alone.
  const rootRef = useRef<HTMLDivElement>(null);
  const prevHeight = useRef(0);
  useLayoutEffect(() => {
    const vp = rootRef.current?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (!vp) return;
    vp.style.overflowAnchor = "none"; // stop the browser also adjusting (it would double-correct)
    const grew = vp.scrollHeight - prevHeight.current;
    if (vp.scrollTop > 0 && prevHeight.current > 0 && grew !== 0) vp.scrollTop += grew;
    prevHeight.current = vp.scrollHeight;
  }, [visible]);

  function clearFilters() {
    setSvc("all");
    setLevel("all");
    setKind("all");
    setQ("");
    setDraft("");
  }

  /** Download exactly what is on screen (the filtered events) as events.json. */
  function exportJson() {
    const json = JSON.stringify(
      visible.map((v) => v.e),
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    // A temporary link with a `download` name is how a page saves a file it built in memory.
    const a = document.createElement("a");
    a.href = url;
    a.download = "events.json";
    document.body.appendChild(a); // some browsers only honour click() on an attached element
    a.click();
    a.remove();
    URL.revokeObjectURL(url); // free the in-memory file now that the download has started
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 space-y-0 pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Event stream</CardTitle>
          <CardDescription>
            Newest first. Showing {visible.length} of {events.length} events.
          </CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={visible.length === 0}
          onClick={exportJson}
        >
          <Download aria-hidden="true" /> Export JSON
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Filters */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={svc} onValueChange={setSvc}>
            <SelectTrigger aria-label="Filter by service" className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All services</SelectItem>
              <SelectItem value="platform">Platform-wide</SelectItem>
              {services.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="text"
              aria-label="Search events"
              placeholder="Search events"
              className="pl-8 pr-9"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setQ(e.target.value);
              }}
            />
            {draft && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-0.5 top-1/2 h-8 w-8 -translate-y-1/2"
                aria-label="Clear search"
                onClick={() => {
                  setDraft("");
                  setQ("");
                }}
              >
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>

        {/* Chips. aria-pressed tells screen readers which one is active. */}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by level">
          {LEVEL_IDS.map((id) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={level === id ? "default" : "outline"}
              className="h-7 rounded-full px-3 text-xs"
              aria-pressed={level === id}
              onClick={() => setLevel(id)}
            >
              {id === "all" ? "All levels" : id}
              <span className="ml-1.5 tabular-nums opacity-70">{levelCounts[id]}</span>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
          {KIND_IDS.map((id) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={kind === id ? "default" : "outline"}
              className="h-7 rounded-full px-3 text-xs"
              aria-pressed={kind === id}
              onClick={() => setKind(id)}
            >
              {id === "all" ? "All kinds" : id}
              <span className="ml-1.5 tabular-nums opacity-70">{kindCounts[id]}</span>
            </Button>
          ))}
        </div>

        {/* Fixed height so the card never grows as events stream in (no layout shift). */}
        <ScrollArea ref={rootRef} className="h-[420px] rounded-md border">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <p className="text-sm text-muted-foreground">No events match these filters.</p>
              {active && (
                <Button type="button" size="sm" variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            // role="log" is the ARIA role for append-only message streams.
            <ol role="log" aria-label="Platform events" className="divide-y text-sm">
              {visible.map(({ e, key }) => {
                const lv = LEVELS[e.level];
                const Icon = lv.icon;
                return (
                  // select-text: log lines are things people want to copy.
                  <li key={key} className="flex select-text flex-col gap-1 px-3 py-1.5 sm:flex-row sm:items-start sm:gap-2">
                    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">
                        t={String(e.t).padStart(4, "0")}
                      </span>
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${lv.className}`}>
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        {lv.label}
                      </span>
                      <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px] font-normal">
                        {kindOf(e)}
                      </Badge>
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                        {svcName(e.service)}
                      </Badge>
                    </div>
                    {/* break-words so a long message wraps instead of widening the page */}
                    <span className="min-w-0 break-words">{e.msg}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </ScrollArea>

        {active && visible.length > 0 && (
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
