"use client";

// =============================================================================
// AlertHistory.tsx  —  Alerts that fired and have since resolved (newest first).
//
// The engine keeps the last 20. Duration is resolvedAt - firedAt: how long the problem
// was really present AFTER the "for" wait, i.e. how long someone could have been paged.
// =============================================================================

import { History } from "lucide-react";

import { SeverityBadge, fmtValue } from "@/components/shared/events/ActiveAlerts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { metricLabel } from "@/lib/engine/alerts";
import type { AlertRecord, AlertRule, Service } from "@/lib/engine/types";

export function AlertHistory({
  history,
  rules,
  services,
}: {
  history: AlertRecord[];
  rules: AlertRule[];
  services: Service[];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" aria-hidden="true" /> Resolved alerts
        </CardTitle>
        <CardDescription>Newest first. The last 20 alerts that fired and then cleared.</CardDescription>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No alerts have fired and resolved yet.</p>
        ) : (
          // The Table wrapper scrolls sideways inside itself, never the whole page.
          <Table className="tabular-nums">
            <TableHeader>
              <TableRow>
                <TableHead>Rule</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead className="text-right">Fired at</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Peak</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((r, idx) => {
                // Records store the rule NAME, not its id, so look the unit up by name. A rule
                // that was renamed or deleted since simply shows the bare number.
                const rule = rules.find((x) => x.name === r.ruleName);
                const unit = rule ? metricLabel(rule.metric).unit : "";
                const dur = r.resolvedAt - r.firedAt;
                return (
                  // No ids on records, so the key is content plus position.
                  <TableRow key={`${r.firedAt}-${r.resolvedAt}-${r.ruleName}-${r.serviceId}-${idx}`}>
                    <TableCell className="min-w-[9rem] break-words font-medium">{r.ruleName}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {services.find((s) => s.id === r.serviceId)?.name ?? r.serviceId}
                    </TableCell>
                    <TableCell>
                      <SeverityBadge severity={r.severity} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-xs">t={r.firedAt}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {dur} tick{dur === 1 ? "" : "s"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {fmtValue(r.peak)}
                      {unit}
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
