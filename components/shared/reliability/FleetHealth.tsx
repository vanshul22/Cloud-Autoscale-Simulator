"use client";

// =============================================================================
// FleetHealth.tsx  —  One row per instance: what state it is in, WHY, and buttons
// to break it (or, for slow/erroring ones, to fix it).
//
// The key lesson of this table: an instance can be DEAD while its status still says
// "healthy". Health checks need a few ticks to notice, and until then nginx keeps
// sending it traffic. So the "What's happening" column spells out the hidden fault
// instead of trusting the status badge alone.
// =============================================================================

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Command } from "@/lib/engine/commands";
import type { HealthConfig, Instance, InstanceStatus, Service } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

// Same colours as InstanceTable, so a status looks identical on every tab. Colour is
// only a hint: the badge always carries the status word too.
const STATUS_STYLE: Record<InstanceStatus, string> = {
  booting: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  healthy: "border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-400",
  unhealthy: "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-400",
  draining: "border-slate-500/40 bg-slate-500/15 text-slate-700 dark:text-slate-300",
  restarting: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  crashloop: "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-400",
};

/**
 * A plain-English sentence for what an instance is doing right now.
 * `need` is how many failed health checks in a row get it pulled from nginx.
 */
function describe(inst: Instance, need: number): string {
  switch (inst.status) {
    case "restarting":
      return `restarting in ${inst.backoffLeft} ticks (backoff)`;
    case "booting":
      return `warming up (${inst.bootTicksLeft} ticks)`;
    case "unhealthy":
      return inst.downReason ?? "out of rotation, being rechecked";
    case "crashloop":
      return "gave up restarting";
    case "draining":
      return "draining: finishing its last requests";
    case "healthy":
      break;
  }
  // Status is "healthy": the platform THINKS it is fine. Check for a hidden fault.
  const left = inst.faultTicksLeft ?? 0;
  if (inst.fault === "crash" || inst.fault === "oom") {
    return `dead, health check ${inst.failedChecks ?? 0}/${need} failed`;
  }
  if (inst.fault === "latency") return `slow x${inst.latencyFactor ?? 1} for ${left} more ticks`;
  if (inst.fault === "errors") {
    return `failing ${Math.round((inst.errorFraction ?? 0) * 100)}% of requests for ${left} more ticks`;
  }
  return "ok";
}

export function FleetHealth({
  service,
  health,
  send,
}: {
  service: Service;
  health: Required<HealthConfig>;
  send: (c: Command) => Promise<void>;
}) {
  // True while a command is on its way, so a double-click cannot fire it twice.
  const [busy, setBusy] = useState(false);
  async function run(c: Command) {
    setBusy(true);
    try {
      await send(c);
    } finally {
      setBusy(false);
    }
  }

  // Sorted by id so rows keep their place while the engine reorders the array.
  const rows = useMemo(
    () => [...service.instances].sort((a, b) => a.id.localeCompare(b.id)),
    [service.instances],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Fleet health</CardTitle>
        <CardDescription>
          Break one instance at a time and watch how the platform reacts. Only a healthy instance with no fault can be
          hit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No instances running.</p>
        ) : (
          // The Table component wraps <table> in an overflow-auto div, so a wide table
          // scrolls inside the card instead of making the whole page scroll sideways.
          <Table className="tabular-nums">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="min-w-[12rem]">What&apos;s happening</TableHead>
                <TableHead className="text-right">Restarts</TableHead>
                <TableHead className="min-w-[17rem]">Break it</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((inst) => {
                // Chaos is only accepted by a healthy instance that is not already broken.
                const canBreak = inst.status === "healthy" && !inst.fault;
                // Only slow/erroring faults can be undone; a dead process needs a restart.
                const canClear = inst.fault === "latency" || inst.fault === "errors";
                const hit = (fault: "crash" | "oom" | "latency" | "errors", severity?: number) =>
                  void run({ type: "injectFault", serviceId: service.id, instanceId: inst.id, fault, severity });
                return (
                  <TableRow key={inst.id}>
                    <TableCell className="font-mono text-xs">{inst.id}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("capitalize", STATUS_STYLE[inst.status])}>
                        {inst.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{describe(inst, health.checkFailuresToEject)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {inst.restartCount ?? 0}/{health.maxRestarts}
                    </TableCell>
                    <TableCell>
                      <div role="group" aria-label={`Break instance ${inst.id}`} className="flex flex-wrap gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={busy || !canBreak}
                          aria-label={`Crash instance ${inst.id}`}
                          onClick={() => hit("crash")}
                        >
                          Crash
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={busy || !canBreak}
                          aria-label={`OOM-kill instance ${inst.id}`}
                          onClick={() => hit("oom")}
                        >
                          OOM
                        </Button>
                        {/* x3 stays under the readiness limit (stays in rotation), x10 is
                            over it (pulled out): the "Try it" experiment needs both. */}
                        {[3, 5, 10].map((x) => (
                          <Button
                            key={x}
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={busy || !canBreak}
                            aria-label={`Make instance ${inst.id} ${x} times slower`}
                            onClick={() => hit("latency", x)}
                          >
                            Slow x{x}
                          </Button>
                        ))}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={busy || !canBreak}
                          aria-label={`Make instance ${inst.id} fail 60% of requests`}
                          onClick={() => hit("errors", 0.6)}
                        >
                          Errors 60%
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-7 px-2 text-xs"
                          disabled={busy || !canClear}
                          aria-label={`Clear fault on instance ${inst.id}`}
                          onClick={() =>
                            void run({ type: "clearFault", serviceId: service.id, instanceId: inst.id })
                          }
                        >
                          Clear
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
