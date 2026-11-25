"use client";

// =============================================================================
// QueueCharts.tsx  —  Two small charts that show the queue's behaviour over time.
//
//   (a) Queue depth, with a dashed line at the queue's capacity. The gap between
//       the two is "how much room is left before we start answering 429".
//   (b) Per second: requests served from the queue vs rejected (429).
//
// The design rules are the same as Charts.tsx so the app reads as one system:
//   * ONE measure per chart, no dual axes (depth is a "level", served/rejected are
//     "rates", so they get separate charts instead of sharing a y-axis).
//   * Colour follows the thing, everywhere: queue = grey, served = green (the same
//     green as "utilisation": healthy work getting done), rejected = red (errors).
//     Series are ALSO told apart by shape (served is a smooth line, rejected is a
//     step line) and by a legend, so colour is never the only signal.
//   * Fixed height, fixed x window, no animation: live data must not jitter.
// =============================================================================

import { useMemo, type ReactNode } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Metric, QueueState, Service } from "@/lib/engine/types";

// Same validated hex values as Charts.tsx (light + dark). They are defined as CSS
// variables on a Card so Tailwind's `dark:` variant can swap them. Exported so the
// pipeline diagram can reuse the exact same colours.
export const QUEUE_VIZ_TOKENS =
  "[--viz-fleet:#eb6834] [--viz-util:#1baf7a] [--viz-error:#d03b3b] [--viz-queue:#52514e] " +
  "dark:[--viz-fleet:#d95926] dark:[--viz-util:#199e70] dark:[--viz-error:#e66767] dark:[--viz-queue:#c3c2b7]";

const C = {
  queue: "var(--viz-queue)",
  served: "var(--viz-util)",
  rejected: "var(--viz-error)",
  capacity: "var(--viz-fleet)",
  surface: "hsl(var(--card))",
} as const;

// The engine keeps at most 120 points; pinning the x-axis to that window means a
// young chart fills in from the right instead of rescaling every tick.
const WINDOW = 120;
const X_TICKS = [-120, -80, -40, 0];
const CHART_HEIGHT = 168; // px, fixed so nothing shifts while data arrives

/** Round UP to a "nice" number (1, 2, 5 x 10^n) so the y-axis max stays stable. */
function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

/** Axis tick label: 1200 -> "1.2k", so a narrow y-axis never overflows. */
function compact(v: number): string {
  return Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
}

function fmt(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// One chart row: a Metric plus fields the charts need. `queueServed` and
// `queueRejected` are optional on old saved points, so we normalise them to 0.
interface Datum extends Metric {
  ago: number; // ticks relative to the newest point (0 = now)
  served: number;
  rejected: number;
}

interface TipRow {
  key: "queueDepth" | "served" | "rejected";
  name: string;
  unit: string;
  color: string;
}

// Tooltip: value first, name second, with a short line-key in the series colour.
// The text itself stays in normal ink (never coloured text).
function ChartTooltip({
  active,
  payload,
  rows,
}: {
  active?: boolean;
  payload?: { payload: Datum }[];
  rows: TipRow[];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
      <div className="mb-1 text-muted-foreground">
        tick {d.t} · {d.ago === 0 ? "now" : `${-d.ago} ago`}
      </div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2">
          <span className="h-0.5 w-3 rounded" style={{ background: r.color }} aria-hidden />
          <span className="font-semibold tabular-nums">
            {fmt(d[r.key])}
            {r.unit}
          </span>
          <span className="text-muted-foreground">{r.name}</span>
        </div>
      ))}
    </div>
  );
}

// The frame both charts share: title, unit, latest value, optional legend.
function Panel({
  title,
  unit,
  latest,
  legend,
  summary,
  children,
}: {
  title: string;
  unit: string;
  latest: string; // plain-text current value, so the number is readable without colour
  legend?: { name: string; color: string }[];
  summary: string; // read aloud by screen readers instead of the SVG
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border bg-card p-3">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-sm font-medium">
          {title} <span className="font-normal text-muted-foreground">({unit})</span>
        </h3>
        <span className="text-sm font-semibold tabular-nums">{latest}</span>
      </header>
      {/* The legend row is always rendered (even if empty) so both panels have the
          same height and their plots line up side by side. */}
      <ul className="mb-1 flex min-h-4 flex-wrap gap-x-3 text-xs text-muted-foreground">
        {legend?.map((l) => (
          <li key={l.name} className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded" style={{ background: l.color }} aria-hidden />
            {l.name}
          </li>
        ))}
      </ul>
      {/* role="img" + aria-label: to assistive tech the chart is one picture and
          the text summary tells the same story. `text-muted-foreground` sets
          currentColor, which the axes and grid inherit. */}
      <div role="img" aria-label={summary} className="w-full text-muted-foreground" style={{ height: CHART_HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%" minHeight={CHART_HEIGHT}>
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </section>
  );
}

const MARGIN = { top: 6, right: 8, bottom: 0, left: 0 };

/** Shared grid + axes, returned as an array because recharts inspects its DIRECT
 *  children by type (wrapping them in a custom component would hide them). */
function axes(yMax: number) {
  return [
    <CartesianGrid key="g" vertical={false} stroke="currentColor" strokeOpacity={0.15} />,
    <XAxis
      key="x"
      dataKey="ago"
      type="number"
      domain={[-WINDOW, 0]}
      ticks={X_TICKS}
      tickFormatter={(v: number) => (v === 0 ? "now" : `${v}`)}
      tick={{ fontSize: 11, fill: "currentColor" }}
      tickLine={false}
      axisLine={{ stroke: "currentColor", strokeOpacity: 0.3 }}
      interval={0}
      allowDataOverflow
    />,
    <YAxis
      key="y"
      domain={[0, yMax]}
      allowDecimals={false}
      tickFormatter={compact}
      tick={{ fontSize: 11, fill: "currentColor" }}
      tickLine={false}
      axisLine={false}
      width={38}
    />,
  ];
}

function tip(rows: TipRow[]) {
  return (
    <Tooltip
      isAnimationActive={false}
      cursor={{ stroke: "currentColor", strokeOpacity: 0.4 }}
      content={<ChartTooltip rows={rows} />}
    />
  );
}

/** Hover dot: >= 8px with a 2px ring in the card colour so it stays legible. */
const activeDot = (color: string) => ({ r: 4, fill: color, stroke: C.surface, strokeWidth: 2 });

export function QueueCharts({ service, queue }: { service: Service; queue: QueueState }) {
  const { metricsHistory } = service;

  // Derive rows once per history change, not on every unrelated render.
  const data: Datum[] = useMemo(() => {
    const lastT = metricsHistory.length ? metricsHistory[metricsHistory.length - 1].t : 0;
    return metricsHistory.map((m) => ({
      ...m,
      ago: m.t - lastT,
      queueDepth: m.queueDepth ?? 0,
      served: m.queueServed ?? 0, // missing on points saved before the queue feature
      rejected: m.queueRejected ?? 0,
    }));
  }, [metricsHistory]);

  // "Nice" y maxima so the axes only change when the data really outgrows them.
  // The depth axis also has to fit the capacity line, or the line would be clipped.
  const domains = useMemo(() => {
    const max = (k: "queueDepth" | "served" | "rejected") => data.reduce((a, d) => Math.max(a, d[k]), 0);
    return {
      depth: Math.max(10, niceCeil(Math.max(max("queueDepth"), queue.capacity) * 1.05)),
      rate: Math.max(10, niceCeil(Math.max(max("served"), max("rejected")) * 1.05)),
    };
  }, [data, queue.capacity]);

  // Not enough points for a line: a placeholder with the same height as the real
  // thing, so the page does not jump when data arrives.
  if (data.length < 2) {
    return (
      <Card className={QUEUE_VIZ_TOKENS}>
        <CardHeader>
          <CardTitle>Queue over time</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            Collecting data…
          </div>
        </CardContent>
      </Card>
    );
  }

  const now = data[data.length - 1];
  const peak = (k: "queueDepth" | "served" | "rejected") => Math.max(...data.map((d) => d[k]));

  return (
    <Card className={QUEUE_VIZ_TOKENS}>
      <CardHeader className="pb-3">
        <CardTitle>Queue over time</CardTitle>
        <p className="text-xs text-muted-foreground">
          Last {data.length} ticks · horizontal axis is ticks ago (0 = now)
        </p>
      </CardHeader>
      <CardContent>
        {/* 1 column on phones, 2 on desktop. min-w-0 lets the panels shrink below
            their content width, which prevents sideways page scroll. */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {/* (a) Depth against capacity. */}
          <Panel
            title="Queue depth"
            unit="requests"
            latest={`${fmt(now.queueDepth)} / ${fmt(queue.capacity)}`}
            legend={[
              { name: "Waiting", color: C.queue },
              ...(queue.capacity > 0 ? [{ name: "Queue capacity (dashed)", color: C.capacity }] : []),
            ]}
            summary={`Queue depth in requests. Now ${fmt(now.queueDepth)} waiting of ${fmt(queue.capacity)} capacity; peak ${fmt(peak("queueDepth"))}.`}
          >
            <ComposedChart data={data} margin={MARGIN}>
              {axes(domains.depth)}
              {tip([{ key: "queueDepth", name: "Waiting", unit: " requests", color: C.queue }])}
              {/* Capacity is an annotation, so it is dashed. At 0 there is no queue
                  and therefore nothing to draw. */}
              {queue.capacity > 0 && (
                <ReferenceLine
                  y={queue.capacity}
                  stroke={C.capacity}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  label={{ value: `capacity ${fmt(queue.capacity)}`, position: "insideTopLeft", fontSize: 10, fill: "currentColor" }}
                />
              )}
              <Area
                type="monotone"
                dataKey="queueDepth"
                stroke={C.queue}
                strokeWidth={2}
                fill={C.queue}
                fillOpacity={0.1}
                dot={false}
                activeDot={activeDot(C.queue)}
                isAnimationActive={false}
              />
            </ComposedChart>
          </Panel>

          {/* (b) Two RATES on one axis: same unit (requests per second), so one
              axis is honest. Different line shapes keep them apart without colour. */}
          <Panel
            title="Served vs rejected (429)"
            unit="req/s"
            latest={`${fmt(now.served)} served · ${fmt(now.rejected)} rejected`}
            legend={[
              { name: "Served from queue", color: C.served },
              { name: "Rejected (429)", color: C.rejected },
            ]}
            summary={`Requests per second. Now ${fmt(now.served)} served from the queue and ${fmt(now.rejected)} rejected with 429; peak served ${fmt(peak("served"))}, peak rejected ${fmt(peak("rejected"))}.`}
          >
            <ComposedChart data={data} margin={MARGIN}>
              {axes(domains.rate)}
              {tip([
                { key: "served", name: "Served from queue", unit: " req/s", color: C.served },
                { key: "rejected", name: "Rejected (429)", unit: " req/s", color: C.rejected },
              ])}
              <Line
                type="monotone"
                dataKey="served"
                stroke={C.served}
                strokeWidth={2}
                dot={false}
                activeDot={activeDot(C.served)}
                isAnimationActive={false}
              />
              {/* A STEP line: rejections come in whole requests and switch on/off. */}
              <Line
                type="stepAfter"
                dataKey="rejected"
                stroke={C.rejected}
                strokeWidth={2}
                dot={false}
                activeDot={activeDot(C.rejected)}
                isAnimationActive={false}
              />
            </ComposedChart>
          </Panel>
        </div>
      </CardContent>
    </Card>
  );
}
