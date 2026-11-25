"use client";

// =============================================================================
// TrafficControls.tsx  —  The "load generator" panel.
//
// This component never changes the simulation itself. It only renders the
// service it is given and calls `send(command)`; the server applies the command
// and the next snapshot flows back down as a new `service` prop.
// =============================================================================

import { useEffect, useState } from "react";
import { Minus, OctagonX, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
// Type-only import: erased at compile time, so no server code reaches the browser.
import type { Command } from "@/lib/engine/commands";
// A plain constant, safe to import as a value.
import { MAX_RPS } from "@/lib/engine/commands";
import type { Pattern, Service } from "@/lib/engine/types";

// Preset buttons + the one-line explanation shown for each. Kept as data so the
// JSX below is just a .map() and adding a pattern is a one-line change.
const PATTERNS: { id: Pattern; label: string; blurb: string }[] = [
  { id: "flat", label: "Flat", blurb: "Steady traffic that stays exactly at the base load." },
  { id: "spike", label: "Spike", blurb: "Sudden short bursts well above the base load, then back down." },
  { id: "ramp", label: "Ramp", blurb: "Traffic climbs gradually from the base load, like a launch or sale starting." },
  { id: "sine", label: "Day/night", blurb: "Smooth wave that rises and falls like daytime and night-time usage." },
  { id: "noise", label: "Noise", blurb: "Random jitter around the base load, like real unpredictable users." },
  {
    id: "daily",
    label: "Daily curve",
    blurb: "Follows the simulated clock: quiet at night, a daytime peak near 13:00 and an evening peak near 20:30. Pairs with Scheduled Scaling.",
  },
];

const DELTAS = [-100, -10, 10, 100] as const;

export function TrafficControls({
  service,
  send,
}: {
  service: Service;
  send: (c: Command) => Promise<void>;
}) {
  // `local` is what the slider shows. While dragging we update it on every
  // pixel for smoothness, but only tell the server once the user lets go
  // (onValueCommit) so we don't fire hundreds of requests per drag.
  const [local, setLocal] = useState(service.targetRps);
  const [dragging, setDragging] = useState(false);
  // True while a request is in flight; used to disable the buttons.
  const [busy, setBusy] = useState(false);

  // Resync from the server value, but never mid-drag (it would yank the thumb
  // out from under the user's finger).
  useEffect(() => {
    if (!dragging) setLocal(service.targetRps);
  }, [service.targetRps, dragging]);

  // Wrap every send so we get a consistent busy flag; `finally` guarantees the
  // buttons re-enable even if the request throws.
  async function run(cmd: Command) {
    setBusy(true);
    try {
      await send(cmd);
    } finally {
      setBusy(false);
    }
  }

  const activeBlurb = PATTERNS.find((p) => p.id === service.pattern)?.blurb;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Traffic</CardTitle>
        <CardDescription>Base load is what you ask for; actual RPS eases toward it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Two headline numbers: the target and what is really flowing now. */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-muted-foreground">Base load</div>
            <div className="text-2xl font-semibold tabular-nums">
              {Math.round(local)} <span className="text-sm font-normal text-muted-foreground">req/s</span>
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Actual now</div>
            <div className="text-2xl font-semibold tabular-nums">
              {Math.round(service.currentRps)}{" "}
              <span className="text-sm font-normal text-muted-foreground">req/s</span>
            </div>
          </div>
        </div>

        {/* Slider: value is an array because Radix supports multi-thumb sliders. */}
        <Slider
          min={0}
          max={MAX_RPS}
          step={10}
          value={[local]}
          aria-label="Base load in requests per second"
          onValueChange={(v) => {
            setDragging(true);
            setLocal(v[0]);
          }}
          onValueCommit={(v) => {
            setLocal(v[0]);
            setDragging(false);
            void run({ type: "setTraffic", serviceId: service.id, rps: v[0] });
          }}
        />

        {/* Nudge buttons + the big red stop button. */}
        <div className="flex flex-wrap items-center gap-2">
          {DELTAS.map((delta) => (
            <Button
              key={delta}
              variant="outline"
              size="sm"
              className="tabular-nums"
              disabled={busy}
              onClick={() => void run({ type: "adjustTraffic", serviceId: service.id, delta })}
            >
              {delta < 0 ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
              {Math.abs(delta)}
            </Button>
          ))}
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto"
            disabled={busy}
            onClick={() => void run({ type: "stopTraffic", serviceId: service.id })}
          >
            <OctagonX className="h-4 w-4" />
            Stop traffic
          </Button>
        </div>

        {/* Pattern presets: the active one uses the filled "default" variant. */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Traffic pattern</div>
          <div className="flex flex-wrap gap-2">
            {PATTERNS.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={service.pattern === p.id ? "default" : "outline"}
                aria-pressed={service.pattern === p.id}
                disabled={busy}
                onClick={() => void run({ type: "setPattern", serviceId: service.id, pattern: p.id })}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{activeBlurb}</p>
        </div>
      </CardContent>
    </Card>
  );
}
