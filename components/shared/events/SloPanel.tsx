"use client";

// =============================================================================
// SloPanel.tsx  —  The service level objective (SLO) and its error budget.
//
// An SLO is a promise about reliability, e.g. "99.5% of requests succeed". The ERROR
// BUDGET is the other side of that promise: the 0.5% of requests that are allowed to
// fail. The BURN RATE says how fast you are spending it.
//
// Everything is computed by sloSummary() from the engine (a pure function), so the
// numbers here are exactly the ones the burn-rate alert rule sees.
// =============================================================================

import { Target } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sloSummary } from "@/lib/engine/alerts";
import type { Command } from "@/lib/engine/commands";
import type { Service } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

// Mirrors the check in the `updateSlo` command: a percentage from 50 to 99.999.
const TARGET_MIN = 50;
const TARGET_MAX = 99.999;

export function SloPanel({
  service,
  tick,
  send,
}: {
  service: Service;
  tick: number;
  send: (c: Command) => Promise<void>;
}) {
  const s = sloSummary(service, tick);

  // The target box keeps a draft string (commit on blur/Enter) and resyncs from the
  // server only while it is NOT focused, so an incoming tick never eats half-typed input.
  const [draft, setDraft] = useState(String(s.target));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(s.target));
  }, [s.target, service.id]); // service.id: switching service must show THAT service's target

  function commit() {
    const num = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(num)) {
      setDraft(String(s.target)); // junk: show the real value again
      return;
    }
    const clamped = Math.min(TARGET_MAX, Math.max(TARGET_MIN, num));
    setDraft(String(clamped));
    if (clamped !== s.target) void send({ type: "updateSlo", serviceId: service.id, target: clamped });
  }

  // Colour is only a hint: the bar's number and the "meeting/missing" word say the same.
  const barColour =
    s.budgetRemainingPct > 50
      ? "bg-[hsl(var(--success))]"
      : s.budgetRemainingPct > 20
        ? "bg-[hsl(var(--warning))]"
        : "bg-destructive";

  const idBase = `${service.id}-slo`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="h-4 w-4" aria-hidden="true" /> Service level objective
        </CardTitle>
        <CardDescription>
          An SLO is a promise about reliability, like &quot;99.5% of requests succeed&quot;. The error budget is the
          small share of requests that are allowed to fail while still keeping that promise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Target. min/max on the input give the browser's own hints; commit() enforces them. */}
        <div className="space-y-1.5">
          <Label htmlFor={`${idBase}-target`}>Target availability (%) for {service.name}</Label>
          <Input
            id={`${idBase}-target`}
            type="number"
            inputMode="decimal"
            step="any"
            min={TARGET_MIN}
            max={TARGET_MAX}
            className="w-32 tabular-nums"
            value={draft}
            aria-describedby={`${idBase}-target-hint`}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => (focused.current = true)}
            onBlur={() => {
              focused.current = false;
              commit();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <p id={`${idBase}-target-hint`} className="text-xs text-muted-foreground">
            50 to 99.999. e.g. 99.5 means 1 request in 200 may fail.
          </p>
        </div>

        {/* The big number: what we actually delivered over the window. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-3xl font-semibold tabular-nums">{s.availability.toFixed(2)}%</span>
          <Badge
            variant="outline"
            className={cn(
              s.met
                ? "border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-400"
                : "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-400",
            )}
          >
            {s.met ? "meeting target" : "missing target"}
          </Badge>
          <span className="text-xs text-muted-foreground">availability over the last 600 ticks</span>
        </div>

        {/* Error budget bar. role=progressbar + a value lets assistive tech read it. */}
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span id={`${idBase}-budget`} className="font-medium">
              Error budget remaining
            </span>
            <span className="font-mono tabular-nums">{s.budgetRemainingPct.toFixed(0)}%</span>
          </div>
          <div
            role="progressbar"
            aria-labelledby={`${idBase}-budget`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(s.budgetRemainingPct)}
            className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
          >
            {/* Width is the only thing that moves; the transition is off for reduced-motion users. */}
            <div
              className={cn("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", barColour)}
              style={{ width: `${s.budgetRemainingPct}%` }}
            />
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Requests in window</dt>
            <dd className="font-mono tabular-nums">{s.windowRequests.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Failed</dt>
            <dd className="font-mono tabular-nums">{s.failedRequests.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Allowed failures (the budget)</dt>
            <dd className="font-mono tabular-nums">{s.allowedFailures.toLocaleString("en-US")}</dd>
          </div>
        </dl>

        <div className="space-y-1 rounded-lg border bg-card/60 p-3 text-sm">
          <div>
            Burn rate: <span className="font-mono font-semibold tabular-nums">{s.burnRate.toFixed(1)}x</span>
          </div>
          <p className="text-xs text-muted-foreground">
            1.0x = spending the budget exactly as fast as allowed; above 1x it runs out early.
          </p>
          {s.ticksToExhaust !== null && (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              At this rate the budget is gone in about {s.ticksToExhaust} ticks.
            </p>
          )}
          {s.windowRequests === 0 && (
            <p className="text-xs text-muted-foreground">No requests recorded yet, so there is nothing to measure.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
