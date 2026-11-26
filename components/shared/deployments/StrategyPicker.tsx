"use client";

// =============================================================================
// StrategyPicker.tsx  —  "Ship a new version": choose HOW to replace the running code.
//
// Every strategy is a different answer to one question: how much of your traffic do
// you expose to the new version before you know it works? The four cards show the two
// trade-offs that matter (is there downtime? how much damage can a bad release do?).
// Below them are the knobs: how good the new build is (so you can watch each strategy
// cope with a bad one), the batch size / watch time, and the approval + rollback rules.
//
// Like the other forms, every number box keeps a DRAFT STRING so you can type freely;
// we validate on each render and only enable the button when the values make sense.
// The server validates again: this is a friendly first line of defence.
// =============================================================================

import { Check, Rocket, Undo2 } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Command } from "@/lib/engine/commands";
import { nextVersion } from "@/lib/engine/deploy";
import type { BadRelease, DeployStrategy, Service } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

// The wording follows the header of lib/engine/deploy.ts.
export const STRATEGIES: {
  id: DeployStrategy;
  label: string;
  blurb: string;
  downtime: boolean; // does the service go down while we ship?
  risk: string; // how much of your traffic a bad release can hurt
}[] = [
  {
    id: "recreate",
    label: "Recreate",
    blurb: "Stop everything, then start the new version. Simplest and cheapest, but the service is DOWN while it boots.",
    downtime: true,
    risk: "all",
  },
  {
    id: "rolling",
    label: "Rolling",
    blurb:
      "Replace a batch at a time and only retire old instances once the new ones pass the health gate. No downtime; a broken build is caught on the first batch.",
    downtime: false,
    risk: "batch",
  },
  {
    id: "blue-green",
    label: "Blue-green",
    blurb:
      "Start a full second fleet idle, then switch all traffic at once. Instant cutover and instant rollback, but you pay for two fleets meanwhile.",
    downtime: false,
    risk: "none until cutover",
  },
  {
    id: "canary",
    label: "Canary",
    blurb:
      "Send 10%, then 50%, then 100% of REAL traffic to the new version while watching its error rate. Smallest blast radius, slowest.",
    downtime: false,
    risk: "small share",
  },
];

// Release quality: short names for the dropdown (the trigger shows one line), and the
// full explanation underneath once chosen. Also used by the history table.
export const RELEASE_QUALITY: Record<BadRelease, { label: string; hint: string }> = {
  none: { label: "Healthy build", hint: "A normal release: nothing is wrong with the new version." },
  errors: {
    label: "Sneaky bug",
    hint: "Passes health checks but fails 30% of real requests. Only watching real traffic (canary) catches this; health checks pass.",
  },
  slow: {
    label: "Slow build",
    hint: "Fails readiness: it answers about 8x slower, so it never passes the health gate.",
  },
  crash: {
    label: "Crashes on start",
    hint: "Crashes again every time it starts, so it fails its liveness check.",
  },
};

const BATCH_SIZES = [25, 50, 100] as const;

export function StrategyPicker({ service, send }: { service: Service; send: (c: Command) => Promise<void> }) {
  const [strategy, setStrategy] = useState<DeployStrategy>("rolling");
  const [bad, setBad] = useState<BadRelease>("none");
  const [stepPct, setStepPct] = useState<string>("25");
  const [holdDraft, setHoldDraft] = useState("10"); // canary watch time, as typed
  const [pause, setPause] = useState(false); // "pause for my approval" -> autoPromote = !pause
  const [autoRollback, setAutoRollback] = useState(true);
  // Disables the buttons while a request is in flight so a double click cannot fire twice.
  const [busy, setBusy] = useState(false);

  // useId gives each input a unique id even if two tabs render this component.
  const uid = useId();
  const id = (f: string) => `${uid}-${f}`;

  const hold = holdDraft.trim() === "" ? NaN : Math.round(Number(holdDraft));
  const holdOk = Number.isFinite(hold) && hold >= 3 && hold <= 60;
  const holdProblem = strategy === "canary" && !holdOk;

  // Only one deployment per service, and a brand-new service must finish going live first.
  const locked = !!service.deployment || !!service.provisioning;
  const next = nextVersion(service.version);
  const label = STRATEGIES.find((s) => s.id === strategy)?.label ?? strategy;

  // If the version we are running was reached by a successful deploy, offer to go back.
  const lastGood = service.deployHistory?.find((r) => r.outcome === "succeeded" && r.to === service.version);

  async function run(c: Command) {
    setBusy(true);
    try {
      await send(c);
    } finally {
      setBusy(false); // `finally` re-enables the buttons even if the request throws
    }
  }

  function deploy() {
    if (locked || holdProblem) return;
    void run({
      type: "startDeploy",
      serviceId: service.id,
      strategy,
      bad,
      // Options a strategy does not use are left out (undefined is dropped by JSON).
      stepPct: strategy === "rolling" ? Number(stepPct) : undefined,
      holdTicks: strategy === "canary" ? hold : undefined,
      autoPromote: !pause,
      autoRollback,
    });
  }

  // Only blue-green and canary have a "promote" gate, so the approval switch means
  // nothing for recreate and rolling: we disable it and say why.
  const hasGate = strategy === "blue-green" || strategy === "canary";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Rocket className="h-4 w-4" aria-hidden="true" /> Ship a new version
        </CardTitle>
        <CardDescription>
          Running {service.version}. Pick how to replace it: each strategy trades speed, cost and risk differently.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Native radio inputs, visually hidden (sr-only) and drawn as cards. Because they
            share one `name`, the browser gives us arrow-key navigation and the screen
            reader announces "radio, 2 of 4" for free. `peer-focus-visible` shows the ring. */}
        <div className="space-y-2">
          <div id={id("strategy-label")} className="text-sm font-medium">
            Strategy
          </div>
          <div role="radiogroup" aria-labelledby={id("strategy-label")} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {STRATEGIES.map((s) => {
              const selected = s.id === strategy;
              return (
                <label key={s.id} className="relative block min-w-0 cursor-pointer">
                  <input
                    type="radio"
                    name={id("strategy")}
                    value={s.id}
                    checked={selected}
                    onChange={() => setStrategy(s.id)}
                    className="peer sr-only"
                  />
                  <div
                    className={cn(
                      "h-full space-y-2 rounded-lg border p-3 text-sm transition-colors hover:bg-accent/50 peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                      selected && "border-primary bg-primary/5",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{s.label}</span>
                      {/* A check mark (not just the border colour) says which is selected. */}
                      {selected && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                          <Check className="h-3.5 w-3.5" aria-hidden="true" /> Selected
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{s.blurb}</p>
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <span className="rounded border px-1.5 py-0.5">
                        Downtime:{" "}
                        <span className={cn("font-medium", s.downtime && "text-destructive")}>
                          {s.downtime ? "yes" : "none"}
                        </span>
                      </span>
                      <span className="rounded border px-1.5 py-0.5">
                        Risk exposure: <span className="font-medium">{s.risk}</span>
                      </span>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={id("quality")}>Release quality</Label>
            <Select value={bad} onValueChange={(v) => setBad(v as BadRelease)}>
              <SelectTrigger id={id("quality")} className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(RELEASE_QUALITY) as BadRelease[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {RELEASE_QUALITY[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="min-h-[2rem] text-xs text-muted-foreground">{RELEASE_QUALITY[bad].hint}</p>
          </div>

          {strategy === "rolling" && (
            <div className="space-y-1.5">
              <Label htmlFor={id("batch")}>Batch size</Label>
              <Select value={stepPct} onValueChange={setStepPct}>
                <SelectTrigger id={id("batch")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BATCH_SIZES.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}% of the fleet
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Smaller batches are safer but slower.</p>
            </div>
          )}

          {strategy === "canary" && (
            <div className="space-y-1.5">
              <Label htmlFor={id("hold")}>Watch time per canary step (ticks)</Label>
              <Input
                id={id("hold")}
                type="number"
                inputMode="numeric"
                min={3}
                max={60}
                className="tabular-nums"
                value={holdDraft}
                onChange={(e) => setHoldDraft(e.target.value)}
                aria-invalid={holdProblem}
                aria-describedby={id("hold-hint")}
              />
              <p id={id("hold-hint")} className={cn("text-xs", holdProblem ? "text-destructive" : "text-muted-foreground")}>
                {holdProblem
                  ? "Enter a whole number from 3 to 60."
                  : "How long to watch the error rate at each step before widening (3-60)."}
              </p>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <Switch id={id("pause")} checked={pause} onCheckedChange={setPause} disabled={!hasGate} className="mt-0.5" />
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor={id("pause")} className="leading-snug">
                Pause for my approval at each gate
              </Label>
              <p className="text-xs text-muted-foreground">
                {hasGate
                  ? "Off: the rollout promotes itself when the gate passes. On: you press Promote."
                  : "Only blue-green and canary have a gate to approve."}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Switch id={id("rollback")} checked={autoRollback} onCheckedChange={setAutoRollback} className="mt-0.5" />
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor={id("rollback")} className="leading-snug">
                Roll back automatically if the health gate fails
              </Label>
              <p className="text-xs text-muted-foreground">
                Off: a failed gate stops and waits for you to decide.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={deploy} disabled={busy || locked || holdProblem}>
            <Rocket aria-hidden="true" /> Deploy {next} with {label}
          </Button>
          {lastGood && (
            <Button
              variant="secondary"
              disabled={busy || locked}
              onClick={() =>
                void run({ type: "startDeploy", serviceId: service.id, strategy: "rolling", toVersion: lastGood.from })
              }
            >
              <Undo2 aria-hidden="true" /> Revert to {lastGood.from}
            </Button>
          )}
        </div>
        {locked && (
          <p className="text-xs text-muted-foreground">
            {service.provisioning
              ? "This service is still going live. You can deploy once it is running."
              : "A rollout is already running. Watch it in the Rollout card, or roll it back."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
