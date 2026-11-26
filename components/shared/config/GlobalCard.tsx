"use client";

// =============================================================================
// GlobalCard.tsx  —  Controls that belong to the WHOLE platform, not one service:
// the simulation speed, the simulated clock, how many services exist, and a full reset.
// =============================================================================

import { Globe, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_SERVICES, type Command } from "@/lib/engine/commands";
import type { Platform } from "@/lib/engine/types";

const SPEEDS = [1, 5, 60] as const;

/** 0..1439 minutes -> "HH:MM", the format an <input type="time"> expects. */
function toTime(mins: number): string {
  const m = Math.floor(mins) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function GlobalCard({ platform, send }: { platform: Platform; send: (c: Command) => Promise<void> }) {
  // The time box is a draft: the simulated clock moves every tick, so we must NOT
  // keep overwriting what you are choosing. `null` means "not editing: show the live clock".
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? toTime(platform.clockMinutes);

  function setClock() {
    // <input type="time"> gives "HH:MM" (or "" when cleared). Anything else is ignored.
    const match = /^(\d{1,2}):(\d{2})$/.exec(shown);
    if (!match) return;
    const minutes = Number(match[1]) * 60 + Number(match[2]); // a real number, as the server demands
    void send({ type: "setClock", minutes });
    setDraft(null); // go back to showing the live clock
  }

  function resetAll() {
    // Wipes every service and every setting, so confirm first.
    if (window.confirm("Reset the whole simulation? All services return to their defaults.")) {
      void send({ type: "reset" });
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="h-4 w-4" aria-hidden="true" /> Whole platform
        </CardTitle>
        <CardDescription>These apply to every service at once.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <span id="config-speed-label" className="text-sm font-medium leading-none">
            Simulation speed
          </span>
          <div role="group" aria-labelledby="config-speed-label" className="flex flex-wrap gap-1.5">
            {SPEEDS.map((sp) => (
              <Button
                key={sp}
                size="sm"
                variant={platform.speed === sp ? "default" : "outline"}
                aria-pressed={platform.speed === sp}
                className="min-w-12 font-mono"
                onClick={() => void send({ type: "setSpeed", speed: sp })}
              >
                {sp}x
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Faster speeds make schedules and deployments play out sooner.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="config-clock">Simulated clock</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="config-clock"
              type="time"
              className="w-32 tabular-nums"
              value={shown}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setClock();
              }}
            />
            <Button size="sm" variant="outline" disabled={draft === null || draft === ""} onClick={setClock}>
              Set clock
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Jump to a time of day to watch a scheduled window open (now{" "}
            <span className="font-mono tabular-nums">{toTime(platform.clockMinutes)}</span>).
          </p>
        </div>

        <p className="text-sm">
          Services: <span className="font-mono font-semibold tabular-nums">{platform.services.length}</span> of{" "}
          <span className="font-mono tabular-nums">{MAX_SERVICES}</span>
        </p>

        <div className="space-y-1.5 border-t pt-4">
          <Button size="sm" variant="destructive" onClick={resetAll}>
            <Trash2 aria-hidden="true" /> Reset the whole simulation
          </Button>
          <p className="text-xs text-muted-foreground">Removes extra services and sets every setting back to the defaults.</p>
        </div>
      </CardContent>
    </Card>
  );
}
