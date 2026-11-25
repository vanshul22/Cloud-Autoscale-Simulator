"use client";

// =============================================================================
// QueueCohorts.tsx  —  A look inside the queue: who is waiting, and for how long.
//
// The engine does not track single requests (thousands would bloat the saved
// world). It tracks COHORTS: groups that entered the queue on the same tick. Each
// row here is one cohort, listed oldest first, which is also the order they are
// served in (FIFO: first in, first out).
// =============================================================================

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { QueueState } from "@/lib/engine/types";

// Showing every cohort could make the card grow without bound, so cap the rows.
const MAX_ROWS = 20;

export function QueueCohorts({ queue, tick }: { queue: QueueState; tick: number }) {
  const cohorts = queue.cohorts;
  const shown = cohorts.slice(0, MAX_ROWS);
  const hidden = cohorts.length - shown.length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Inside the queue</CardTitle>
        <CardDescription>
          Groups of requests that arrived together, oldest first (the order they are served in).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {cohorts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Queue is empty</p>
        ) : (
          <>
            {/* The Table component already wraps the <table> in an overflow-auto box,
                so a narrow screen scrolls THIS table sideways, never the page.
                min-w keeps the columns from squashing into each other first. */}
            <Table className="min-w-[440px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Waiting</TableHead>
                  <TableHead>Attempt</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((c, i) => (
                  // No stable id exists for a cohort; the list is re-derived from
                  // scratch every tick, so the index is a fine key here.
                  <TableRow key={i}>
                    <TableCell className="text-right font-mono tabular-nums">{c.n.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{c.age}s</TableCell>
                    <TableCell>
                      {c.attempts === 0 ? "first try" : `retry ${c.attempts}/${queue.maxRetries}`}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {/* readyAt in the future means it timed out and is waiting out
                          its backoff delay: it is not standing in line yet. */}
                      {c.readyAt > tick ? `backing off until tick ${c.readyAt}` : "waiting"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-2 text-xs text-muted-foreground tabular-nums">
              {cohorts.length} {cohorts.length === 1 ? "group" : "groups"}, {queue.depth.toLocaleString()} requests in total
              {hidden > 0 && ` (showing the oldest ${MAX_ROWS}, ${hidden} more not shown)`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
