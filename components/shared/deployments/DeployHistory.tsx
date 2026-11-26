"use client";

// =============================================================================
// DeployHistory.tsx  —  A table of finished deployments, newest first.
//
// The engine keeps the last 10 per service (deployHistory). Comparing rows is the
// point: the same bad release rolled back after a few ticks under one strategy, and
// shipped to everyone under another.
// =============================================================================

import { ListChecks } from "lucide-react";

import { RELEASE_QUALITY } from "@/components/shared/deployments/StrategyPicker";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { BadRelease, DeployRecord } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

// Lower-case table wording for the release quality column.
const QUALITY_WORD: Record<BadRelease, string> = {
  none: "healthy",
  errors: "sneaky bug",
  slow: "slow",
  crash: "crashes",
};

export function DeployHistory({ history }: { history: DeployRecord[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="h-4 w-4" aria-hidden="true" /> Deploy history
        </CardTitle>
        <CardDescription>Newest first. The last 10 finished deployments.</CardDescription>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No finished deployments yet.</p>
        ) : (
          // The Table component already scrolls sideways inside its own wrapper,
          // so a wide table never makes the whole page scroll.
          <Table className="tabular-nums">
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Strategy</TableHead>
                <TableHead>Release</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((r, idx) => {
                const ok = r.outcome === "succeeded";
                return (
                  // History has no ids, so the key is its content plus its position.
                  <TableRow key={`${r.startedTick}-${r.from}-${r.to}-${idx}`}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {r.from} -&gt; {r.to}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{r.strategy}</TableCell>
                    <TableCell className="whitespace-nowrap" title={RELEASE_QUALITY[r.bad].hint}>
                      {QUALITY_WORD[r.bad]}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          "whitespace-nowrap",
                          ok
                            ? "border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-400"
                            : "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400",
                        )}
                      >
                        {ok ? "succeeded" : "rolled back"}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">{r.endedTick - r.startedTick} ticks</TableCell>
                    {/* Long reasons are cut with an ellipsis; the full text is in the tooltip. */}
                    <TableCell className="max-w-[14rem] truncate text-muted-foreground" title={r.reason}>
                      {r.reason}
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
