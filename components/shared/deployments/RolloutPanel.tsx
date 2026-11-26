"use client";

// =============================================================================
// RolloutPanel.tsx  —  Watch a deployment happen.
//
// Two parts:
//   1. The ROLLOUT: which versions, which strategy, how far along, what the engine
//      is doing right now (its `note`), and the HEALTH GATE readout. A new instance
//      only counts once it is READY (running, passing health checks, stable for a
//      few ticks); if they are not ready before the deadline the gate fails and the
//      rollout is rolled back.
//   2. The FLEET STRIP: one square per instance showing its version and state, so you
//      can literally watch v1 squares turn into v2 squares.
// The strip is shown even when nothing is deploying: it is just "the fleet right now".
// =============================================================================

import { CheckCircle2, Layers, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Command } from "@/lib/engine/commands";
import { isReady } from "@/lib/engine/deploy";
import type { Instance, Rollout, Service } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

const MAX_CANARY_ERR_PCT = 5; // mirrors the engine's limit; shown to the reader as "(limit 5%)"

// What a square can be. Each state has its own text word AND its own border pattern
// (solid / dashed / dotted) as well as colour, so colour is never the only signal.
type FleetState = "ready" | "checking" | "idle" | "booting" | "problem";

const STATE_STYLE: Record<FleetState, string> = {
  ready: "border-solid border-green-500/60 bg-green-500/15 text-green-700 dark:text-green-400",
  checking: "border-solid border-sky-500/60 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  idle: "border-dashed border-slate-500/70 bg-transparent text-muted-foreground",
  booting: "border-dotted border-amber-500/70 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  problem: "border-solid border-red-500/60 bg-red-500/15 text-red-700 dark:text-red-400",
};

/** The word printed in a square. For a problem we print the real status (crashloop...). */
function fleetState(i: Instance): { state: FleetState; word: string } {
  if (i.status === "booting") return { state: "booting", word: "booting" };
  if (i.status === "unhealthy" || i.status === "restarting" || i.status === "crashloop") {
    return { state: "problem", word: i.status };
  }
  // Standby = the blue-green green fleet: warm, but not in rotation yet.
  if (i.standby) return { state: "idle", word: "idle" };
  // Healthy but not yet stable for a few ticks: still passing the health gate.
  return isReady(i) ? { state: "ready", word: "ready" } : { state: "checking", word: "checking" };
}

export function RolloutPanel({
  service,
  tick,
  send,
}: {
  service: Service;
  tick: number;
  send: (c: Command) => Promise<void>;
}) {
  const d = service.deployment;
  const [busy, setBusy] = useState(false);

  async function run(c: Command) {
    setBusy(true);
    try {
      await send(c);
    } finally {
      setBusy(false);
    }
  }

  // Draining instances are on their way out, so the strip leaves them out. Old version
  // first, then the new one, each sorted by id so squares keep their place between ticks.
  const fleet = useMemo(() => {
    const order = (v: string) => (d && v === d.toVersion ? 1 : 0);
    return service.instances
      .filter((i) => i.status !== "draining")
      .sort((a, b) => order(a.version) - order(b.version) || a.version.localeCompare(b.version) || a.id.localeCompare(b.id));
  }, [service.instances, d]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="h-4 w-4" aria-hidden="true" /> Rollout
        </CardTitle>
        <CardDescription>The deployment in progress and the fleet it is changing.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {d ? (
          <ActiveRollout d={d} service={service} tick={tick} busy={busy} run={run} />
        ) : (
          <IdleSummary service={service} />
        )}
        <FleetStrip fleet={fleet} toVersion={d?.toVersion} />
      </CardContent>
    </Card>
  );
}

/** Nothing is deploying: say so, and say how the last one ended. */
function IdleSummary({ service }: { service: Service }) {
  const last = service.deployHistory?.[0];
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">No rollout running.</p>
      {last && (
        <p className="text-muted-foreground">
          Last deploy: {last.from} to {last.to} with {last.strategy}{" "}
          {last.outcome === "succeeded" ? "succeeded" : "was rolled back"}. {last.reason}
        </p>
      )}
    </div>
  );
}

function ActiveRollout({
  d,
  service,
  tick,
  busy,
  run,
}: {
  d: Rollout;
  service: Service;
  tick: number;
  busy: boolean;
  run: (c: Command) => Promise<void>;
}) {
  // The health gate only looks at the NEW version's instances.
  const news = service.instances.filter((i) => i.version === d.toVersion && i.status !== "draining");
  const ready = news.filter(isReady).length;
  // Still waiting for readiness: the deadline clock is running.
  const waiting = !d.rollingBack && d.phase === "progressing" && (news.length === 0 || ready < news.length);
  const gateLeft = Math.max(0, d.deadlineTicks - (tick - d.stepStartedTick));

  // The engine only has a manual gate for blue-green (cutover) and canary (widen).
  const canPromote = (d.strategy === "blue-green" || d.strategy === "canary") && !d.rollingBack;

  const phase = d.rollingBack
    ? { text: "rolling back", cls: "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-400" }
    : d.phase === "awaiting-approval"
      ? { text: "waiting for you", cls: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400" }
      : { text: "progressing", cls: "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-400" };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-sm font-medium tabular-nums">
          {d.fromVersion} -&gt; {d.toVersion} with {d.strategy}
        </span>
        <Badge variant="outline" className={phase.cls}>
          {phase.text}
        </Badge>
      </div>

      {/* Progress = how much of the target fleet is on the new version AND ready. */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>Progress</span>
          <span>{d.progressPct}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="Rollout progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={d.progressPct}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-500"
            style={{ width: `${d.progressPct}%` }}
          />
        </div>
      </div>

      {/* The engine's own one-line explanation. role="status" = polite live region:
          a screen reader announces it when it changes, without interrupting. */}
      <p role="status" className="min-h-[2.5rem] text-sm text-muted-foreground">
        {d.note}
      </p>

      <div className="rounded-lg border p-3">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Health gate</h3>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm tabular-nums">
          <dt className="text-muted-foreground">New instances ready:</dt>
          <dd className="font-medium">
            {ready} of {news.length}
          </dd>
          {d.strategy === "canary" && (
            <>
              <dt className="text-muted-foreground">Traffic to new version:</dt>
              <dd className="font-medium">{d.trafficPctToNew}%</dd>
              <dt className="text-muted-foreground">New version error rate:</dt>
              <dd className="font-medium">
                {d.newErrPct.toFixed(1)}% (limit {MAX_CANARY_ERR_PCT}%)
                {d.newErrPct > MAX_CANARY_ERR_PCT && <span className="text-destructive"> over the limit</span>}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Gate fails in:</dt>
          <dd className="font-medium">{waiting ? `${gateLeft} ticks` : "not waiting"}</dd>
        </dl>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !canPromote}
          onClick={() => void run({ type: "promoteDeploy", serviceId: service.id })}
        >
          <CheckCircle2 aria-hidden="true" /> Promote
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy || d.rollingBack}
          onClick={() => void run({ type: "rollbackDeploy", serviceId: service.id })}
        >
          <Undo2 aria-hidden="true" /> Roll back
        </Button>
      </div>
      {!canPromote && !d.rollingBack && (
        <p className="text-xs text-muted-foreground">
          {d.strategy === "rolling" ? "Rolling" : "Recreate"} has no manual gate to promote: it moves on by itself. Roll
          back to abort.
        </p>
      )}
    </div>
  );
}

/** One labelled square per instance, plus a legend that explains every look. */
function FleetStrip({ fleet, toVersion }: { fleet: Instance[]; toVersion?: string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Fleet</h3>
      {/* min-height keeps the card the same size whether it holds 1 square or 12. */}
      <div className="min-h-[3.25rem]">
        {fleet.length === 0 ? (
          <p className="text-sm text-muted-foreground">No instances running.</p>
        ) : (
          <ul aria-label="Instances and their versions" className="flex flex-wrap gap-1.5">
            {fleet.map((i) => {
              const { state, word } = fleetState(i);
              return (
                <li
                  key={i.id}
                  title={`${i.id}: ${i.version}, ${word}`}
                  className={cn(
                    "flex h-[3.25rem] w-16 flex-col items-center justify-center rounded-md border-2 text-center leading-tight",
                    STATE_STYLE[state],
                    // Booting squares pulse, but only for people who have not asked for reduced motion.
                    state === "booting" && "motion-safe:animate-pulse",
                    // A ring marks the NEW version, so old and new differ by shape and not only text.
                    toVersion && i.version === toVersion && "ring-2 ring-primary ring-offset-1 ring-offset-background",
                  )}
                >
                  <span className="font-mono text-xs font-semibold">{i.version}</span>
                  <span className="text-[10px]">{word}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <ul aria-label="Legend" className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <LegendItem state="ready" text="ready" />
        <LegendItem state="checking" text="checking (healthy, not stable yet)" />
        <LegendItem state="idle" text="idle (standby, no traffic)" />
        <LegendItem state="booting" text="booting" />
        <LegendItem state="problem" text="unhealthy / restarting / crashloop" />
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm border-2 border-muted-foreground/50 ring-2 ring-primary ring-offset-1 ring-offset-background" aria-hidden="true" />
          ringed = new version
        </li>
      </ul>
    </div>
  );
}

function LegendItem({ state, text }: { state: FleetState; text: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={cn("h-3 w-3 rounded-sm border-2", STATE_STYLE[state])} aria-hidden="true" />
      {text}
    </li>
  );
}
