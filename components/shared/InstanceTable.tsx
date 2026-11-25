"use client";

// =============================================================================
// InstanceTable.tsx  —  One row per simulated server in the fleet.
// Draws `service`, and lets you add/remove instances by hand (via `send`) so you
// can build an uneven fleet and watch how each load balancer copes with it.
// =============================================================================

import { Minus, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { MAX_INSTANCES } from "@/lib/engine/commands";
import type { Command } from "@/lib/engine/commands";
import { instanceCapacityRps } from "@/lib/engine/metrics";
import type { InstanceStatus, Service } from "@/lib/engine/types";

// Status -> badge colours. Colour is only a hint: the badge always carries the
// status word too, so colour-blind users lose nothing.
const STATUS_STYLE: Record<InstanceStatus, string> = {
  booting: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  healthy: "border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-400",
  unhealthy: "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-400",
  draining: "border-slate-500/40 bg-slate-500/15 text-slate-700 dark:text-slate-300",
  restarting: "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  crashloop: "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-400",
};

export function InstanceTable({
  service,
  send,
}: {
  service: Service;
  send: (c: Command) => Promise<void>;
}) {
  // True while a command is on its way to the server. Disabling the buttons
  // meanwhile stops a double-click from adding (or removing) twice.
  const [busy, setBusy] = useState(false);
  async function run(c: Command) {
    setBusy(true);
    try {
      await send(c);
    } finally {
      setBusy(false);
    }
  }

  // Sort by id so rows keep a stable position. Instance order in the array can
  // change as the engine adds/removes them; sorting by a fixed key stops rows
  // jumping around every tick. useMemo re-sorts only when the list changes.
  const rows = useMemo(
    () => [...service.instances].sort((a, b) => a.id.localeCompare(b.id)),
    [service.instances],
  );

  const healthy = rows.filter((i) => i.status === "healthy").length;
  const booting = rows.filter((i) => i.status === "booting").length;
  const other = rows.length - healthy - booting;
  const rpsPerInstance = service.autoscale.rpsPerInstance;
  const atMax = service.instances.length >= MAX_INSTANCES;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Instances</CardTitle>
        <CardDescription className="tabular-nums">
          {healthy} healthy · {booting} booting · {other} other
        </CardDescription>
        {/* Manual sizing: build an uneven fleet (standard + large) to see how each
            load balancer copes. flex-wrap keeps the group inside a 390px card. */}
        <div role="group" aria-label="Add instance" className="flex flex-wrap items-center gap-2 pt-2">
          <span className="text-xs font-medium text-muted-foreground">Add instance</span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || atMax}
            onClick={() => void run({ type: "addInstance", serviceId: service.id, size: 1 })}
          >
            <Plus aria-hidden="true" />
            Add standard
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || atMax}
            onClick={() => void run({ type: "addInstance", serviceId: service.id, size: 2 })}
          >
            <Plus aria-hidden="true" />
            Add large (2x)
          </Button>
          {atMax && (
            <span className="text-xs text-muted-foreground">Limit of {MAX_INSTANCES} reached</span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No instances running. The autoscaler will start some when it is needed, or add one
            yourself above.
          </p>
        ) : (
          // The Table component already wraps <table> in an overflow-auto div,
          // so a wide table scrolls inside the card, not the whole page.
          <Table className="tabular-nums">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">RPS</TableHead>
                <TableHead className="text-right">Conns</TableHead>
                <TableHead className="min-w-[8rem]">Utilisation</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((inst) => {
                // Measured against THIS instance's own capacity: a 2x instance
                // serving 2x the traffic is exactly as busy as a 1x serving 1x.
                // Real utilisation can exceed 100%; the bar is capped but the
                // text keeps the true number so overload stays visible.
                const capacity = instanceCapacityRps(inst, rpsPerInstance);
                const pct = capacity > 0 ? (inst.rps / capacity) * 100 : 0;
                const barPct = Math.min(100, Math.max(0, pct));
                const barColour =
                  pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-primary";
                const slow = inst.latencyFactor ?? 1;
                return (
                  <TableRow key={inst.id}>
                    <TableCell className="font-mono text-xs">{inst.id}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={cn("capitalize", STATUS_STYLE[inst.status])}>
                          {inst.status}
                        </Badge>
                        {/* Text, not just colour, so slowness is readable by everyone. */}
                        {slow > 1 && (
                          <span className="whitespace-nowrap text-xs font-medium text-orange-700 dark:text-orange-400">
                            slow x{slow}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{Math.max(1, inst.weight || 1)}x</Badge>
                    </TableCell>
                    <TableCell>{inst.version}</TableCell>
                    <TableCell className="text-right">{Math.round(inst.rps)}</TableCell>
                    <TableCell className="text-right">{inst.conns}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                          <div className={cn("h-full rounded-full", barColour)} style={{ width: `${barPct}%` }} />
                        </div>
                        <span className="w-10 text-right text-xs text-muted-foreground">
                          {Math.round(pct)}%
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* A draining instance is already on its way out. */}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        aria-label={`Remove instance ${inst.id}`}
                        title="Remove (drains gracefully)"
                        disabled={busy || inst.status === "draining"}
                        onClick={() =>
                          void run({ type: "removeInstance", serviceId: service.id, instanceId: inst.id })
                        }
                      >
                        <Minus aria-hidden="true" />
                      </Button>
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
