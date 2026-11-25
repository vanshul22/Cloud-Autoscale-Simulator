"use client";

// =============================================================================
// QueuePipeline.tsx  —  The queue's mechanism, drawn as a flow with LIVE numbers.
//
//   Requests in -> Servers -> (overflow) -> Queue -> three possible outcomes:
//        served when there is spare capacity
//        timed out -> retried with backoff -> dead-letter queue (DLQ)
//        queue full -> rejected (HTTP 429)
//
// Every box carries a text label and its number, so nothing relies on colour
// alone; the thin coloured edge on the outcome boxes just echoes the chart colours.
// "This tick" values (servedNow ...) describe the LAST second of simulated traffic.
// =============================================================================

import { ArrowDown, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

import { QUEUE_VIZ_TOKENS } from "@/components/shared/queue/QueueCharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { capacityRps, utilisationPct } from "@/lib/engine/metrics";
import type { QueueState, Service } from "@/lib/engine/types";

const n = (v: number) => Math.round(v).toLocaleString();

/** One labelled box in the flow. `accent` is a CSS colour for the left edge. */
function Box({
  title,
  accent,
  children,
}: {
  title: string;
  accent?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="min-w-0 rounded-lg border bg-background/40 p-3"
      // A 3px left edge in the series colour; the box title + number carry the meaning.
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="mt-1 space-y-0.5 text-sm">{children}</div>
    </div>
  );
}

/** Arrow between boxes: points down on phones (stacked) and right on wider screens. */
function Connector({ label }: { label: string }) {
  return (
    <div
      className="flex items-center justify-center gap-1 text-xs text-muted-foreground sm:flex-col sm:gap-0.5"
      aria-hidden="true"
    >
      <ArrowDown className="h-4 w-4 sm:hidden" />
      <ArrowRight className="hidden h-4 w-4 sm:block" />
      <span>{label}</span>
    </div>
  );
}

const big = "font-mono text-lg font-semibold tabular-nums";

export function QueuePipeline({ service, queue }: { service: Service; queue: QueueState }) {
  const capacity = capacityRps(service);
  const util = utilisationPct(service);
  const demand = service.currentRps;
  // What the servers could not take this second. The engine rounds it the same way.
  const overflow = Math.max(0, Math.round(demand - capacity));
  const noQueue = queue.capacity <= 0;
  // Fill ratio for the bar, clamped so a transient depth > capacity cannot overflow it.
  const fill = noQueue ? 0 : Math.min(100, (queue.depth / queue.capacity) * 100);

  return (
    <Card className={QUEUE_VIZ_TOKENS}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Life of a request</CardTitle>
        <CardDescription>
          Servers take traffic first. Only the overflow waits. Numbers update every tick (1 tick = 1 second).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Row 1: in -> servers -> queue. On phones everything stacks (1 column) with
            down arrows; from `sm` it is a row with right arrows between the boxes. */}
        <div className="grid grid-cols-1 items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1.3fr)]">
          <Box title="Requests in">
            <div className={big}>
              {n(demand)} <span className="text-xs font-normal text-muted-foreground">req/s</span>
            </div>
            <div className="text-xs text-muted-foreground">arriving now</div>
          </Box>

          <Connector label="to servers" />

          <Box title="Servers">
            <div className={big}>
              {n(capacity)} <span className="text-xs font-normal text-muted-foreground">req/s</span>
            </div>
            <div className="text-xs text-muted-foreground">
              capacity, at {util >= 999 ? "999+" : Math.round(util)}% utilisation
            </div>
          </Box>

          <Connector label={`overflow ${n(overflow)}/s`} />

          <Box title="Queue" accent="var(--viz-queue)">
            {noQueue ? (
              <>
                <div className={big}>off</div>
                <div className="text-xs text-muted-foreground">
                  capacity is 0, so overflow is rejected at once
                </div>
              </>
            ) : (
              <>
                <div className={big}>
                  {n(queue.depth)}{" "}
                  <span className="text-xs font-normal text-muted-foreground">/ {n(queue.capacity)} waiting</span>
                </div>
                {/* The fill bar is a meter: value, min and max are exposed to screen
                    readers, and the number above says the same thing in text. */}
                <div
                  role="meter"
                  aria-label="Queue fill"
                  aria-valuemin={0}
                  aria-valuemax={queue.capacity}
                  aria-valuenow={Math.min(queue.depth, queue.capacity)}
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300"
                    style={{ width: `${fill}%`, background: "var(--viz-queue)" }}
                  />
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  oldest has waited {queue.oldestAge}s (gives up at {queue.maxWaitTicks}s)
                </div>
              </>
            )}
          </Box>
        </div>

        {/* Row 2: what can happen to a queued request. Three outcomes side by side
            on wider screens, stacked on phones. */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
            Three things can happen to a request that reaches the queue
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <Box title="1. Served" accent="var(--viz-util)">
              <div className={big}>
                {n(queue.servedNow)} <span className="text-xs font-normal text-muted-foreground">req/s now</span>
              </div>
              <div className="text-xs text-muted-foreground">
                When servers have spare capacity, the oldest waiting requests go first.
              </div>
            </Box>

            <Box title="2. Timeout, retry, dead-letter" accent="var(--viz-fleet)">
              <div className={big}>
                {n(queue.dlq)} <span className="text-xs font-normal text-muted-foreground">in the DLQ</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Waits more than {queue.maxWaitTicks}s: times out, then retries after a backoff (
                {queue.retryBackoffTicks}s, doubling) up to {queue.maxRetries}{" "}
                {queue.maxRetries === 1 ? "time" : "times"}, then goes to the dead-letter queue.
                {queue.failedNow > 0 && ` ${n(queue.failedNow)} dead-lettered this tick.`}
              </div>
            </Box>

            <Box title="3. Queue full: rejected" accent="var(--viz-error)">
              <div className={big}>
                {n(queue.rejectedNow)} <span className="text-xs font-normal text-muted-foreground">req/s now</span>
              </div>
              <div className="text-xs text-muted-foreground">
                No room left, so the caller gets HTTP 429 (Too Many Requests).
              </div>
            </Box>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
