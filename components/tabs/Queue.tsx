"use client";

// =============================================================================
// Queue.tsx  —  The "Queue & Workers" tab.
//
// What it teaches: when demand exceeds capacity, a queue turns a burst of errors
// into a delay, but it is finite, waiting has a cost, and retries add load. The
// tab shows the mechanism (pipeline), its history (charts), its contents
// (cohorts) and its dials (controls).
// =============================================================================

import { Lightbulb } from "lucide-react";

import { QueueCharts } from "@/components/shared/queue/QueueCharts";
import { QueueCohorts } from "@/components/shared/queue/QueueCohorts";
import { QueueControls } from "@/components/shared/queue/QueueControls";
import { QueuePipeline } from "@/components/shared/queue/QueuePipeline";
import { Stat } from "@/components/shared/Stat";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Command } from "@/lib/engine/commands";
import type { Platform, QueueState } from "@/lib/engine/types";

interface QueueTabProps {
  platform: Platform;
  serviceId: string | null;
  /** Lets the service selector change the shared selection held by Dashboard. */
  onSelectService?: (serviceId: string) => void;
  send: (c: Command) => Promise<void>;
}

// Values used for any field a saved world is missing. The live site keeps its world
// in Redis, so for a moment after a deploy it can still hold the OLD, smaller queue
// object until the next tick upgrades it. Filling the gaps here means no component
// below ever has to handle `undefined`. (The numbers match the engine's defaults.)
const QUEUE_FALLBACK: QueueState = {
  cohorts: [],
  capacity: 0,
  maxWaitTicks: 8,
  maxRetries: 2,
  retryBackoffTicks: 2,
  depth: 0,
  oldestAge: 0,
  dlq: 0,
  processed: 0,
  rejected: 0,
  retried: 0,
  servedNow: 0,
  rejectedNow: 0,
  failedNow: 0,
};

export function QueueTab({ platform, serviceId, onSelectService, send }: QueueTabProps) {
  // Fall back to the first service if the selected one vanished (e.g. after a reset).
  const service = platform.services.find((s) => s.id === serviceId) ?? platform.services[0];
  if (!service) {
    return <p className="text-sm text-muted-foreground">No services to show.</p>;
  }

  // Old fields first, saved ones on top, and `cohorts` guarded on its own because a
  // saved `undefined` would otherwise survive the spread.
  const queue: QueueState = { ...QUEUE_FALLBACK, ...service.queue, cohorts: service.queue?.cohorts ?? [] };

  return (
    <div className="space-y-4">
      {/* Title row (or a service switcher when there are several). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {platform.services.length > 1 ? (
          <div role="group" aria-label="Select service" className="flex flex-wrap gap-1.5">
            {platform.services.map((s) => (
              <Button
                key={s.id}
                size="sm"
                variant={s.id === service.id ? "default" : "outline"}
                aria-pressed={s.id === service.id}
                onClick={() => onSelectService?.(s.id)}
              >
                {s.name}
              </Button>
            ))}
          </div>
        ) : (
          <h2 className="text-lg font-semibold">{service.name}</h2>
        )}
        <span className="font-mono text-sm text-muted-foreground">{service.domain}</span>
        <StatusBadge status={service.status} />
      </div>

      {/* KPI row: 2 cols on phones, 3 on tablets, 6 on desktop. Red tones only when
          the count is above zero; the number itself is always shown. */}
      <section aria-label="Queue metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Waiting" value={queue.depth.toLocaleString()} unit={`/ ${queue.capacity.toLocaleString()}`} />
        <Stat label="Longest wait" value={queue.oldestAge} unit="s" />
        <Stat label="Served from queue" value={queue.processed.toLocaleString()} />
        <Stat label="Rejected 429" value={queue.rejected.toLocaleString()} tone={queue.rejected > 0 ? "bad" : "default"} />
        <Stat label="Retries" value={queue.retried.toLocaleString()} />
        <Stat label="Dead-lettered" value={queue.dlq.toLocaleString()} tone={queue.dlq > 0 ? "bad" : "default"} />
      </section>

      {/* Same trick as Cluster: on desktop two columns (left: pipeline, charts,
          cohorts; right: controls, try-it). On phones the column wrappers vanish
          (`max-lg:contents`) so every card becomes a direct grid child and `order-N`
          sets the phone order: pipeline, charts, cohorts, controls, try-it.
          `min-w-0` lets cards shrink instead of forcing sideways page scroll. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start">
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-1 min-w-0 lg:order-none">
            <QueuePipeline service={service} queue={queue} />
          </div>
          <div className="order-2 min-w-0 lg:order-none">
            <QueueCharts service={service} queue={queue} />
          </div>
          <div className="order-3 min-w-0 lg:order-none">
            <QueueCohorts queue={queue} tick={platform.tick} />
          </div>
        </div>
        <div className="min-w-0 max-lg:contents lg:space-y-4">
          <div className="order-4 min-w-0 lg:order-none">
            <QueueControls service={service} queue={queue} send={send} />
          </div>
          <div className="order-5 min-w-0 lg:order-none">
            <TryIt />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A short list of experiments, because the fastest way to learn this is to break it. */
function TryIt() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="h-4 w-4" aria-hidden="true" /> Try it
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            Set max instances to 2 in the Cluster tab&apos;s config, then push traffic to 160 req/s: the queue fills,
            requests time out, retry, and end up in the DLQ.
          </li>
          <li>Set capacity to 0 to see the same overload with no queue.</li>
          <li>Raise max retries and watch retried requests add load.</li>
        </ul>
      </CardContent>
    </Card>
  );
}
