"use client";

// =============================================================================
// ActiveAlerts.tsx  —  "Alerts right now": everything pending or firing.
//
// An alert has a short life:  pending -> firing -> resolved.
//   * PENDING: the rule's condition is true, but it has not held for its "for" time
//     yet. Nobody is paged. This is what stops a one-tick blip from waking someone.
//   * FIRING:  the condition held long enough. A human should look at it.
//   * RESOLVED: the condition cleared. It leaves this card and lands in the history.
//
// This component only reads the platform and sends one command (ackAlert).
// =============================================================================

import { BellRing } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Command } from "@/lib/engine/commands";
import { metricLabel } from "@/lib/engine/alerts";
import type { AlertRule, AlertState, Service } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

/**
 * Severity as a badge. The word is always printed: the tint is only a hint, so the
 * meaning survives colour-blindness and both themes. Exported so the rules table and
 * the history table look identical.
 */
export function SeverityBadge({ severity }: { severity: AlertRule["severity"] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "whitespace-nowrap",
        severity === "critical"
          ? "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-400"
          : "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400",
      )}
    >
      {severity}
    </Badge>
  );
}

/** Same rounding the engine uses in its event text: whole numbers from 100 up, else 1 decimal. */
export const fmtValue = (n: number) => (Math.abs(n) >= 100 ? String(Math.round(n)) : n.toFixed(1));

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ActiveAlerts({
  alerts,
  rules,
  services,
  tick,
  send,
}: {
  alerts: AlertState[];
  rules: AlertRule[];
  services: Service[];
  tick: number;
  send: (c: Command) => Promise<void>;
}) {
  // Firing first (those need a human), then pending; within a group, oldest first.
  // Copy before sorting: sort() mutates, and `alerts` belongs to the snapshot.
  const ordered = [...alerts].sort((a, b) => {
    if (a.state !== b.state) return a.state === "firing" ? -1 : 1;
    return a.since - b.since;
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="h-4 w-4" aria-hidden="true" /> Alerts right now
        </CardTitle>
        <CardDescription>
          A rule must hold for its &apos;for&apos; time before it fires, so a single blip never pages anyone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {ordered.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            All quiet: no alerts pending or firing.
          </p>
        ) : (
          <ul className="space-y-2">
            {ordered.map((a) => {
              // The engine removes alerts whose rule or service is gone on the next tick,
              // so a missing lookup is a one-poll gap: fall back to the raw ids.
              const rule = rules.find((r) => r.id === a.ruleId);
              const svc = services.find((s) => s.id === a.serviceId);
              const ruleName = rule?.name ?? a.ruleId;
              const svcName = svc?.name ?? a.serviceId;
              const firing = a.state === "firing";
              const unit = rule ? metricLabel(rule.metric).unit : "";
              // The engine fires when (tick - since + 1) >= forTicks, so this is how many
              // more ticks the condition must keep holding.
              const held = tick - a.since + 1;
              const remaining = rule ? Math.max(1, rule.forTicks - held) : 0;
              const ago = Math.max(0, tick - a.since);

              return (
                <li
                  key={a.id}
                  className="flex flex-col gap-2 rounded-lg border bg-card/60 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 select-text space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {rule && <SeverityBadge severity={rule.severity} />}
                      <span className="break-words text-sm font-medium">{ruleName}</span>
                      <span className="text-xs text-muted-foreground">on {svcName}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      {/* State is always text. Firing gets the strong colour, pending the amber hint. */}
                      <span
                        className={cn(
                          "font-semibold",
                          firing ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400",
                        )}
                      >
                        {firing ? "FIRING" : `pending: ${plural(remaining, "more tick")}`}
                      </span>
                      <span className="tabular-nums">
                        since t={a.since} ({plural(ago, "tick")} ago)
                      </span>
                      {rule && (
                        <span className="tabular-nums">
                          now <span className="text-foreground">{fmtValue(a.value)}{unit}</span> (rule: {rule.op}{" "}
                          {rule.threshold}
                          {unit})
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Only a firing alert can be acknowledged (the server rejects pending ones).
                      Acknowledging means "I'm on it": the alert keeps firing, it just stops asking. */}
                  {firing &&
                    (a.acked ? (
                      <span className="shrink-0 text-xs text-muted-foreground">acknowledged</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        aria-label={`Acknowledge ${ruleName} on ${svcName}`}
                        onClick={() => void send({ type: "ackAlert", alertId: a.id })}
                      >
                        Acknowledge
                      </Button>
                    ))}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
