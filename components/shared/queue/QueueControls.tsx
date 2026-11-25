"use client";

// =============================================================================
// QueueControls.tsx  —  Tune the queue's rules and manage the dead-letter queue.
//
// Same pattern as ConfigPanel: each numeric field keeps a DRAFT STRING in local
// state so you can type freely (even an empty box mid-edit), and we only send to
// the server on blur or Enter. The server clamps again, so the bounds here are a
// friendly first line of defence that mirrors `updateQueue` in commands.ts.
//
// Errors (e.g. "replay when the queue is full") are shown by the app-level banner,
// so this component just fires the command.
// =============================================================================

import { RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Command } from "@/lib/engine/commands";
import type { QueueState, Service } from "@/lib/engine/types";

type NumField = "capacity" | "maxWaitTicks" | "maxRetries" | "retryBackoffTicks";

// Field metadata drives both the rendering and the clamping. The one-line hint on
// each field states the TRADE-OFF, because every knob here buys something and
// costs something.
const FIELDS: { key: NumField; label: string; hint: string; min: number; max: number }[] = [
  {
    key: "capacity",
    label: "Queue capacity (requests)",
    hint: "Bigger absorbs longer spikes but adds delay. 0 = no queue: overflow fails at once.",
    min: 0,
    max: 100000,
  },
  {
    key: "maxWaitTicks",
    label: "Max wait (ticks)",
    hint: "Short gives up quickly and keeps latency low; long wastes time on requests nobody is waiting for.",
    min: 1,
    max: 120,
  },
  {
    key: "maxRetries",
    label: "Max retries",
    hint: "More retries save more requests, but every retry adds load to a system that is already overloaded.",
    min: 0,
    max: 10,
  },
  {
    key: "retryBackoffTicks",
    label: "Retry backoff (ticks)",
    hint: "Base delay before a retry; it doubles each attempt. Longer gives the system room to recover.",
    min: 1,
    max: 60,
  },
];

const toDrafts = (q: Pick<QueueState, NumField>): Record<NumField, string> => ({
  capacity: String(q.capacity),
  maxWaitTicks: String(q.maxWaitTicks),
  maxRetries: String(q.maxRetries),
  retryBackoffTicks: String(q.retryBackoffTicks),
});

export function QueueControls({
  service,
  queue,
  send,
}: {
  service: Service;
  queue: QueueState;
  send: (c: Command) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<NumField, string>>(() => toDrafts(queue));
  // A ref (not state) so moving focus does not re-run the resync effect below;
  // otherwise blur would briefly flash the OLD server value before the reply lands.
  const focused = useRef<NumField | null>(null);

  // Whenever the server-side values change, refresh every draft EXCEPT the one being
  // typed in, so an incoming tick never clobbers half-typed input. The effect depends
  // on the four primitive values (not the `queue` object, which is new every poll).
  const { capacity, maxWaitTicks, maxRetries, retryBackoffTicks } = queue;
  useEffect(() => {
    setDrafts((prev) => {
      const fresh = toDrafts({ capacity, maxWaitTicks, maxRetries, retryBackoffTicks });
      const f = focused.current;
      return f ? { ...fresh, [f]: prev[f] } : fresh;
    });
  }, [capacity, maxWaitTicks, maxRetries, retryBackoffTicks]);

  // Validate + send one field. Called on blur and on Enter.
  function commit(field: NumField, bounds: { min: number; max: number }) {
    const num = Number(drafts[field]);
    // Empty / non-numeric: throw the draft away and show the real value again.
    if (drafts[field].trim() === "" || !Number.isFinite(num)) {
      setDrafts((d) => ({ ...d, [field]: String(queue[field]) }));
      return;
    }
    const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.round(num)));
    setDrafts((d) => ({ ...d, [field]: String(clamped) }));
    if (clamped === queue[field]) return; // nothing changed -> skip the request
    void send({ type: "updateQueue", serviceId: service.id, patch: { [field]: clamped } });
  }

  const hasDlq = queue.dlq > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Queue settings</CardTitle>
        <CardDescription>Changes apply on the next tick.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`${service.id}-queue-${f.key}`}>{f.label}</Label>
              <Input
                id={`${service.id}-queue-${f.key}`}
                type="number"
                inputMode="numeric"
                min={f.min}
                max={f.max}
                className="tabular-nums"
                value={drafts[f.key]}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                onFocus={() => (focused.current = f.key)}
                onBlur={() => {
                  focused.current = null;
                  commit(f.key, f);
                }}
                onKeyDown={(e) => {
                  // Enter commits by blurring, which funnels through onBlur above.
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
              <p className="text-xs text-muted-foreground">{f.hint}</p>
            </div>
          ))}
        </div>

        {/* Dead-letter queue: requests that failed for good. In real systems a human
            looks at these, then either fixes the cause and replays them, or discards. */}
        <section aria-labelledby={`${service.id}-dlq-title`} className="space-y-2 border-t pt-4">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id={`${service.id}-dlq-title`} className="text-sm font-medium">
              Dead-letter queue
            </h3>
            <span className="font-mono text-sm font-semibold tabular-nums">
              {queue.dlq.toLocaleString()} <span className="text-xs font-normal text-muted-foreground">requests</span>
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Requests that ran out of retries. Replay puts them back in line with a fresh start (only as many as fit in
            the queue); purge discards them.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!hasDlq}
              onClick={() => void send({ type: "replayDlq", serviceId: service.id })}
            >
              <RotateCcw aria-hidden="true" /> Replay all
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={!hasDlq}
              onClick={() => void send({ type: "purgeDlq", serviceId: service.id })}
            >
              <Trash2 aria-hidden="true" /> Purge
            </Button>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
