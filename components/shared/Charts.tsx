"use client";

// =============================================================================
// Charts.tsx  —  Small-multiples dashboard of a service's live metrics.
//
// Design rules (from the dataviz skill), and why:
//  * ONE measure per chart, no dual axes. Mixing two scales on one plot makes
//    readers compare the wrong things, so "instances" and "error rate" (very
//    different scales) each get their own small chart.
//  * Colour is assigned by WHAT the thing is, and stays the same everywhere:
//      traffic = blue, fleet capacity / instances = orange (same entity, same
//      colour), utilisation = aqua, latency = violet, errors = red, queue = grey.
//    The palette was run through the dataviz validator (light + dark).
//  * Marks are thin (2px lines, ~10% area wash), grid is a recessive hairline.
//  * Axes are stable (fixed x window, "nice" rounded y max) so the picture
//    doesn't jitter every tick, and animation is OFF so live data doesn't
//    re-animate on each update.
//  * Every chart has a visible title + unit, a plain-text "latest value" (so
//    colour is never the only way to read it), a tooltip, and an aria summary.
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
import type { Metric, Service } from "@/lib/engine/types";

// -----------------------------------------------------------------------------
// Colour tokens. We define our own CSS variables on the Card (instead of relying
// on the theme's --chart-N) so the series colours are exactly the ones we ran
// through the dataviz validator. Tailwind's `dark:` variant swaps them when
// `.dark` is set. Chrome (text, grid) uses `currentColor` so it inherits the
// live theme; the hover-dot ring uses the theme card colour (bare HSL channels,
// hence `hsl(var(--card))`). To adopt the theme's palette instead, change only
// the values in VIZ_TOKENS, e.g. `[--viz-traffic:hsl(var(--chart-1))]`.
// -----------------------------------------------------------------------------
const VIZ_TOKENS =
  "[--viz-traffic:#2a78d6] [--viz-fleet:#eb6834] [--viz-util:#1baf7a] [--viz-latency:#6250d6] [--viz-error:#d03b3b] [--viz-queue:#52514e] " +
  "dark:[--viz-traffic:#3987e5] dark:[--viz-fleet:#d95926] dark:[--viz-util:#199e70] dark:[--viz-latency:#9085e9] dark:[--viz-error:#e66767] dark:[--viz-queue:#c3c2b7]";

const C = {
  traffic: "var(--viz-traffic)",
  fleet: "var(--viz-fleet)",
  util: "var(--viz-util)",
  latency: "var(--viz-latency)",
  error: "var(--viz-error)",
  queue: "var(--viz-queue)",
  surface: "hsl(var(--card))",
} as const;

// The engine keeps at most 120 points. Pinning the x-axis to that window means
// a young chart fills in from the right instead of rescaling every tick.
const WINDOW = 120;
const X_TICKS = [-120, -80, -40, 0];
const CHART_HEIGHT = 168; // px, fixed so nothing shifts while data arrives
const UTIL_PLOT_MAX = 200; // utilisation can hit 999 (no capacity); clip the plot

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

/** Round UP to a "nice" number (1, 2, 5 x 10^n) so the y-axis max is stable. */
function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

/** Axis tick label: 1200 -> "1.2k". Keeps the narrow y-axis from overflowing. */
function compact(v: number): string {
  return Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
}

/** Human number for readouts: no decimals for big values, 1 for small ones. */
function fmt(v: number, digits = 0): string {
  return v.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

// One row of chart data: a Metric plus the derived fields the charts need.
interface Datum extends Metric {
  ago: number; // ticks relative to the newest point (0 = now, -5 = 5 ago)
  capacity: number; // instances * rpsPerInstance, the line the autoscaler "chases"
  utilPlot: number; // util clipped to the plot range (raw util stays for tooltips)
}

// -----------------------------------------------------------------------------
// Tooltip. Lists every series at the hovered x, value first, name second, with a
// short line-key in the series colour (not a coloured box, and never coloured
// text; the text stays in normal ink).
// -----------------------------------------------------------------------------
interface TipRow {
  key: keyof Datum;
  name: string;
  unit: string;
  color: string;
  digits?: number;
}

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
        <div key={String(r.key)} className="flex items-center gap-2">
          <span className="h-0.5 w-3 rounded" style={{ background: r.color }} aria-hidden />
          <span className="font-semibold tabular-nums">
            {fmt(d[r.key] as number, r.digits)}
            {r.unit}
          </span>
          <span className="text-muted-foreground">{r.name}</span>
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Panel: the frame every small chart shares (title, unit, latest value, legend).
// Having ONE frame is what makes the six charts read as a single system.
// -----------------------------------------------------------------------------
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
  latest: string; // plain-text current value: the "direct label" for the chart
  legend?: { name: string; color: string }[]; // only for charts with 2+ series
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
      {legend && (
        <ul className="mb-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {legend.map((l) => (
            <li key={l.name} className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded" style={{ background: l.color }} aria-hidden />
              {l.name}
            </li>
          ))}
        </ul>
      )}
      {/* role="img" + aria-label: the chart is one picture to assistive tech;
          the text summary carries the same story. `text-muted-foreground` sets
          currentColor, which the axes/grid inherit. */}
      <div
        role="img"
        aria-label={summary}
        className="w-full text-muted-foreground"
        style={{ height: CHART_HEIGHT }}
      >
        <ResponsiveContainer width="100%" height="100%" minHeight={CHART_HEIGHT}>
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </section>
  );
}

// Props every chart shares, so the six charts are guaranteed to look alike.
const MARGIN = { top: 6, right: 8, bottom: 0, left: 0 };

/** The shared grid + x/y axes. Returned as an array of elements (not wrapped in a
 *  custom component) because recharts inspects its DIRECT children by type. */
function axes(yDomain: [number, number], yFormat: (v: number) => string = compact) {
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
      domain={yDomain}
      allowDecimals={false}
      tickFormatter={yFormat}
      tick={{ fontSize: 11, fill: "currentColor" }}
      tickLine={false}
      axisLine={false}
      width={38}
    />,
  ];
}

/** Shared tooltip element: hairline crosshair that snaps to the nearest x. */
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

// -----------------------------------------------------------------------------
// The component
// -----------------------------------------------------------------------------
export function Charts({ service }: { service: Service }) {
  const { metricsHistory, autoscale } = service;

  // Derive chart rows once per history change (not on every unrelated render).
  const data: Datum[] = useMemo(() => {
    const lastT = metricsHistory.length ? metricsHistory[metricsHistory.length - 1].t : 0;
    return metricsHistory.map((m) => ({
      ...m,
      ago: m.t - lastT,
      // Capacity per point uses THAT point's instance count, so the line steps
      // up/down exactly when the autoscaler added/removed instances.
      capacity: m.instances * autoscale.rpsPerInstance,
      utilPlot: Math.min(m.util, UTIL_PLOT_MAX),
    }));
  }, [metricsHistory, autoscale.rpsPerInstance]);

  // y-axis maxima: "nice" rounded values so the axes only change when needed.
  const domains = useMemo(() => {
    const max = (k: keyof Datum) => data.reduce((a, d) => Math.max(a, d[k] as number), 0);
    return {
      rps: niceCeil(Math.max(max("rps"), max("capacity")) * 1.05),
      util: Math.max(120, Math.min(Math.ceil(max("utilPlot") / 20) * 20, UTIL_PLOT_MAX)),
      p95: Math.max(100, niceCeil(max("p95") * 1.05)),
      instances: Math.max(autoscale.max, max("instances"), 1),
      err: Math.max(5, Math.ceil(max("errRate") / 5) * 5),
      queue: Math.max(10, niceCeil(max("queueDepth") * 1.05)),
    };
  }, [data, autoscale.max]);

  // Not enough points to draw a line yet: show a calm placeholder with the same
  // height as the real thing so the page doesn't jump when data arrives.
  if (data.length < 2) {
    return (
      <Card className={VIZ_TOKENS}>
        <CardHeader>
          <CardTitle>Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
            Collecting data…
          </div>
        </CardContent>
      </Card>
    );
  }

  const now = data[data.length - 1];
  const peak = (k: keyof Datum) => Math.max(...data.map((d) => d[k] as number));

  return (
    <Card className={VIZ_TOKENS}>
      <CardHeader className="pb-3">
        <CardTitle>Metrics</CardTitle>
        <p className="text-xs text-muted-foreground">
          Last {data.length} ticks · horizontal axis is ticks ago (0 = now)
        </p>
      </CardHeader>
      <CardContent>
        {/* 1 column on phones, 2 on desktop. min-w-0 lets grid children shrink
            below their content width, which prevents horizontal page scroll. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* (a) Traffic vs capacity: the autoscaler chasing the load. */}
          <Panel
            title="Traffic vs capacity"
            unit="req/s"
            latest={`${fmt(now.rps)} / ${fmt(now.capacity)}`}
            legend={[
              { name: "Traffic", color: C.traffic },
              { name: "Capacity (instances × rps each)", color: C.fleet },
            ]}
            summary={`Traffic versus capacity in requests per second. Now ${fmt(now.rps)} traffic against ${fmt(now.capacity)} capacity; peak traffic ${fmt(peak("rps"))}.`}
          >
            <ComposedChart data={data} margin={MARGIN}>
              {axes([0, domains.rps])}
              {tip([
                { key: "rps", name: "Traffic", unit: " req/s", color: C.traffic },
                { key: "capacity", name: "Capacity", unit: " req/s", color: C.fleet },
              ])}
              {/* Area = a ~10% wash under the line; the line itself is 2px. */}
              <Area
                type="monotone"
                dataKey="rps"
                stroke={C.traffic}
                strokeWidth={2}
                fill={C.traffic}
                fillOpacity={0.1}
                dot={false}
                activeDot={activeDot(C.traffic)}
                isAnimationActive={false}
              />
              {/* Capacity is a STEP line: it only changes in whole-instance jumps.
                  Different shape from traffic = not colour alone. */}
              <Line
                type="stepAfter"
                dataKey="capacity"
                stroke={C.fleet}
                strokeWidth={2}
                dot={false}
                activeDot={activeDot(C.fleet)}
                isAnimationActive={false}
              />
            </ComposedChart>
          </Panel>

          {/* (b) Utilisation with the autoscaler's thresholds drawn in. */}
          <Panel
            title="Utilisation"
            unit="%"
            latest={`${fmt(now.util)}%`}
            summary={`Utilisation percent. Now ${fmt(now.util)}%; scale up above ${autoscale.scaleUpAt}%, scale down below ${autoscale.scaleDownAt}%; peak ${fmt(peak("util"))}%.`}
          >
            <ComposedChart data={data} margin={MARGIN}>
              {axes([0, domains.util], (v) => `${v}%`)}
              {tip([{ key: "util", name: "Utilisation", unit: "%", color: C.util }])}
              {/* Threshold lines are annotations, so they're dashed and neutral;
                  only 100% (saturated) borrows the error colour. */}
              <ReferenceLine
                y={autoscale.scaleUpAt}
                stroke="currentColor"
                strokeOpacity={0.55}
                strokeDasharray="4 4"
                label={{ value: `scale up ${autoscale.scaleUpAt}%`, position: "insideTopLeft", fontSize: 10, fill: "currentColor" }}
              />
              <ReferenceLine
                y={autoscale.scaleDownAt}
                stroke="currentColor"
                strokeOpacity={0.55}
                strokeDasharray="4 4"
                label={{ value: `scale down ${autoscale.scaleDownAt}%`, position: "insideTopLeft", fontSize: 10, fill: "currentColor" }}
              />
              <ReferenceLine
                y={100}
                stroke={C.error}
                strokeOpacity={0.7}
                strokeDasharray="4 4"
                label={{ value: "100% saturated", position: "insideTopLeft", fontSize: 10, fill: "currentColor" }}
              />
              <Area
                type="monotone"
                dataKey="utilPlot"
                stroke={C.util}
                strokeWidth={2}
                fill={C.util}
                fillOpacity={0.1}
                dot={false}
                activeDot={activeDot(C.util)}
                isAnimationActive={false}
              />
            </ComposedChart>
          </Panel>

          {/* (c) p95 latency. */}
          <Panel
            title="p95 latency"
            unit="ms"
            latest={`${fmt(now.p95)} ms`}
            summary={`95th percentile latency in milliseconds. Now ${fmt(now.p95)} ms; peak ${fmt(peak("p95"))} ms.`}
          >
            <ComposedChart data={data} margin={MARGIN}>
              {axes([0, domains.p95])}
              {tip([{ key: "p95", name: "p95 latency", unit: " ms", color: C.latency }])}
              <Line
                type="monotone"
                dataKey="p95"
                stroke={C.latency}
                strokeWidth={2}
                dot={false}
                activeDot={activeDot(C.latency)}
                isAnimationActive={false}
              />
            </ComposedChart>
          </Panel>

          {/* (d) Healthy instances: a step line because the count is whole numbers. */}
          <Panel
            title="Healthy instances"
            unit="count"
            latest={`${now.instances}`}
            summary={`Healthy instance count. Now ${now.instances}; peak ${peak("instances")}; autoscaler range ${autoscale.min} to ${autoscale.max}.`}
          >
            <ComposedChart data={data} margin={MARGIN}>
              {axes([0, domains.instances])}
              {tip([{ key: "instances", name: "Healthy instances", unit: "", color: C.fleet }])}
              <Line
                type="stepAfter"
                dataKey="instances"
                stroke={C.fleet}
                strokeWidth={2}
                dot={false}
                activeDot={activeDot(C.fleet)}
                isAnimationActive={false}
              />
            </ComposedChart>
          </Panel>

          {/* (e) Error rate, its own chart rather than a second y-axis. */}
          <Panel
            title="Error rate"
            unit="%"
            latest={`${fmt(now.errRate, 1)}%`}
            summary={`Error rate percent. Now ${fmt(now.errRate, 1)}%; peak ${fmt(peak("errRate"), 1)}%.`}
          >
            <ComposedChart data={data} margin={MARGIN}>
              {axes([0, domains.err], (v) => `${v}%`)}
              {tip([{ key: "errRate", name: "Error rate", unit: "%", color: C.error, digits: 1 }])}
              <Area
                type="monotone"
                dataKey="errRate"
                stroke={C.error}
                strokeWidth={2}
                fill={C.error}
                fillOpacity={0.1}
                dot={false}
                activeDot={activeDot(C.error)}
                isAnimationActive={false}
              />
            </ComposedChart>
          </Panel>

          {/* (f) Queue depth: neutral grey, because it's context, not an alarm. */}
          <Panel
            title="Queue depth"
            unit="jobs"
            latest={`${fmt(now.queueDepth)}`}
            summary={`Queue depth in jobs. Now ${fmt(now.queueDepth)}; peak ${fmt(peak("queueDepth"))}.`}
          >
            <ComposedChart data={data} margin={MARGIN}>
              {axes([0, domains.queue])}
              {tip([{ key: "queueDepth", name: "Queue depth", unit: " jobs", color: C.queue }])}
              <Line
                type="monotone"
                dataKey="queueDepth"
                stroke={C.queue}
                strokeWidth={2}
                dot={false}
                activeDot={activeDot(C.queue)}
                isAnimationActive={false}
              />
            </ComposedChart>
          </Panel>
        </div>
      </CardContent>
    </Card>
  );
}
