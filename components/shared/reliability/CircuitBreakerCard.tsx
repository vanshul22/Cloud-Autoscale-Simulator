"use client";

// =============================================================================
// CircuitBreakerCard.tsx  —  The circuit breaker's state, in plain words.
//
// A circuit breaker is an electrical fuse for traffic. When too many requests fail,
// it "opens" and refuses everything instantly (fail fast) instead of piling more
// work onto a system that is already struggling. After a pause it "half-opens" and
// lets a trickle through as a test; if that goes well it closes again.
// =============================================================================

import { ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { Command } from "@/lib/engine/commands";
import type { HealthConfig, Service } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

type Circuit = NonNullable<HealthConfig["circuit"]>;

// The engine's half-open test lasts this many ticks (HALF_OPEN_TICKS in healing.ts).
// Only used to size the progress bar; the real countdown comes from the server.
const HALF_OPEN_TICKS = 3;

// State -> badge colours. The badge always shows the state word as well.
const CIRCUIT_STYLE: Record<Circuit, string> = {
  closed: "border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-400",
  open: "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-400",
  "half-open": "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400",
};

const EXPLAIN: Record<Circuit, string> = {
  closed: "Normal. All requests are allowed through.",
  open: "Tripped. Every request is refused instantly so the struggling system gets a rest.",
  "half-open": "Testing. A small share (20%) of requests is let through to see whether things have recovered.",
};

export function CircuitBreakerCard({
  service,
  health,
  send,
}: {
  service: Service;
  health: Required<HealthConfig>;
  send: (c: Command) => Promise<void>;
}) {
  const { circuit, circuitEnabled, circuitTicksLeft, circuitOpenTicks, errorRateToTrip } = health;
  const timed = circuit === "open" || circuit === "half-open";
  // How long the current phase lasts in total, so the bar can show "time left".
  const total = circuit === "open" ? circuitOpenTicks : HALF_OPEN_TICKS;
  const pct = timed && total > 0 ? Math.min(100, Math.max(0, (circuitTicksLeft / total) * 100)) : 0;
  const switchId = `${service.id}-circuit-enabled`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4" aria-hidden="true" /> Circuit breaker
        </CardTitle>
        <CardDescription>Stops sending requests when too many are failing, then tests carefully.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={cn("capitalize", CIRCUIT_STYLE[circuit])}>
              {circuitEnabled ? circuit : "off"}
            </Badge>
            <span className="text-sm text-muted-foreground">{circuitEnabled ? EXPLAIN[circuit] : "Disabled: nothing is ever refused."}</span>
          </div>
        </div>

        {/* Reserve the bar's space even when closed so the card never changes height. */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{circuit === "open" ? "Open for" : circuit === "half-open" ? "Testing for" : "Timer"}</span>
            <span className="font-mono tabular-nums">{timed ? `${circuitTicksLeft} ticks left` : "idle"}</span>
          </div>
          <div
            role="progressbar"
            aria-label="Circuit breaker timer"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={timed ? circuitTicksLeft : 0}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn("h-full rounded-full", circuit === "open" ? "bg-red-500" : "bg-amber-500")}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="min-w-0 rounded-lg border bg-card/60 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Failure rate among admitted requests</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">{health.lastErrRate.toFixed(0)}%</dd>
          </div>
          <div className="min-w-0 rounded-lg border bg-card/60 px-3 py-2">
            <dt className="text-xs text-muted-foreground">Refused instantly this tick</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">
              {Math.round(health.shedNow).toLocaleString()}
            </dd>
          </div>
        </dl>

        <p className="text-sm">
          Trips when more than <span className="font-mono font-medium tabular-nums">{errorRateToTrip}%</span> of admitted
          requests fail for <span className="font-medium">3 bad ticks in a row</span>. One blip never trips it.
        </p>

        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <Label htmlFor={switchId} className="text-sm">
            Circuit breaker enabled
          </Label>
          <Switch
            id={switchId}
            checked={circuitEnabled}
            onCheckedChange={(on) =>
              void send({ type: "updateHealth", serviceId: service.id, patch: { circuitEnabled: on } })
            }
          />
        </div>

        <p className="text-xs text-muted-foreground">
          A breaker cannot fix a capacity shortage: if overload persists it will keep tripping.
        </p>
      </CardContent>
    </Card>
  );
}
