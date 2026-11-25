"use client";

// =============================================================================
// DayTimeline.tsx  —  The 24-hour day: planned limits vs what really happened.
//
// Two charts share ONE x-axis (minute of the simulated day, 00:00 to 23:59):
//   A. Instances: the planned MIN and MAX limits (dashed grey steps, computed from
//      the schedules) against the ACTUAL healthy instance count (solid orange).
//      The shaded bands show when each schedule window is open.
//   B. Traffic in req/s, so you can see WHY the instances moved.
//
// Design rules (same as Charts.tsx, from the dataviz skill):
//  * One measure per chart, no dual axes. Instances and req/s have very different
//    scales, so they get their own chart instead of a second y-axis.
//  * Colour means the same thing everywhere: fleet / instances = orange, traffic =
//    blue, limits = neutral grey (they are a plan, not a measurement). The palette
//    is the one already validated for Charts.tsx, so the two tabs match.
//  * Different line STYLES (solid vs dashed vs dotted) as well as colours, plus a
//    text legend and an aria summary, so colour is never the only signal.
//  * Fixed heights, animation off, fixed x-domain: the picture never jitters.
// =============================================================================

import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMinute, windowPhase, effectiveBounds, type Phase } from "@/lib/engine/scheduler";
import type { Schedule, Service } from "@/lib/engine/types";

// Our own colour variables on the Card (same values as Charts.tsx) so the series
// colours are exactly the validated ones; `dark:` swaps them when `.dark` is set.
const VIZ_TOKENS =
  "[--viz-traffic:#2a78d6] [--viz-fleet:#eb6834] [--viz-queue:#52514e] " +
  "dark:[--viz-traffic:#3987e5] dark:[--viz-fleet:#d95926] dark:[--viz-queue:#c3c2b7]";

const C = {
  traffic: "var(--viz-traffic)",
  fleet: "var(--viz-fleet)",
  limit: "var(--viz-queue)",
  surface: "hsl(var(--card))",
} as const;

const DAY = 1440;
// A tick every 3 hours: 0, 180, ... 1260 (00:00 ... 21:00). Fixed, so nothing rescales.
const X_TICKS = [0, 180, 360, 540, 720, 900, 1080, 1260];
const MARGIN = { top: 18, right: 12, bottom: 0, left: 0 }; // top room for the "now" label
const HEIGHT_A = 210; // px, fixed so the card never jumps while data arrives
const HEIGHT_B = 150;

/** Round UP to a "nice" number (1, 2, 5 x 10^n) so the y-axis max stays stable. */
function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

// One row per minute of the day. `null` (not 0!) for "no data yet" makes Recharts
// leave a GAP in the line instead of drawing a false dive to zero.
interface Row {
  m: number; // minute of day, the x value
  minLimit: number;
  maxLimit: number;
  windowName: string; // which window sets the limits at this minute ("" = base limits)
  phase: Phase;
  instances: number | null;
  rps: number | null;
}

// A shaded stretch of the day: [x1, x2] while one window is active or pre-warming.
interface Span {
  key: string;
  x1: number;
  x2: number;
  phase: Phase;
}

/**
 * Turn one schedule into shaded spans by asking windowPhase() about every minute and
 * grouping consecutive minutes with the same phase. Doing it this way (instead of
 * from/to arithmetic) means windows that CROSS MIDNIGHT split into two spans
 * (00:00-07:00 and 23:00-24:00) automatically, with no special case.
 */
function spansFor(s: Schedule): Span[] {
  const out: Span[] = [];
  let start = 0;
  let current: Phase = windowPhase(s, 0);
  for (let m = 1; m <= DAY; m++) {
    const p: Phase = m < DAY ? windowPhase(s, m) : "off"; // DAY = sentinel that closes the last run
    if (p === current) continue;
    if (current !== "off") out.push({ key: `${s.id}-${start}`, x1: start, x2: Math.min(m, DAY - 1), phase: current });
    start = m;
    current = p;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Tooltip: time first, then each value with its unit. Text stays in normal ink;
// only the little line-key carries the series colour.
// -----------------------------------------------------------------------------
function DayTooltip({
  active,
  payload,
  kind,
}: {
  active?: boolean;
  payload?: { payload: Row }[];
  kind: "instances" | "rps";
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
      <div className="mb-1 font-mono tabular-nums text-muted-foreground">{formatMinute(d.m)}</div>
      {kind === "instances" ? (
        <>
          <div className="mb-1 text-muted-foreground">
            {d.windowName ? `${d.windowName}${d.phase === "prewarm" ? " (pre-warming)" : ""}` : "No window: base limits"}
          </div>
          <TipLine color={C.limit} dash value={`${d.maxLimit}`} name="max limit" />
          <TipLine color={C.limit} dash value={`${d.minLimit}`} name="min limit" />
          <TipLine color={C.fleet} value={d.instances === null ? "no data yet" : `${d.instances}`} name="healthy instances" />
        </>
      ) : (
        <TipLine color={C.traffic} value={d.rps === null ? "no data yet" : `${Math.round(d.rps)} req/s`} name="traffic" />
      )}
    </div>
  );
}

function TipLine({ color, value, name, dash }: { color: string; value: string; name: string; dash?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-3 border-t-2"
        style={{ borderColor: color, borderStyle: dash ? "dashed" : "solid" }}
        aria-hidden
      />
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-muted-foreground">{name}</span>
    </div>
  );
}

/** One legend entry: a small key drawn like the mark it explains, then plain text. */
function Key({ kind, color, label }: { kind: "line" | "dashed" | "dotted" | "band" | "band-light"; color?: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      {kind === "band" || kind === "band-light" ? (
        <span className={`h-3 w-4 rounded-sm bg-current ${kind === "band" ? "opacity-25" : "opacity-10"}`} aria-hidden />
      ) : (
        <span
          className="w-4 border-t-2"
          style={{ borderColor: color, borderStyle: kind === "line" ? "solid" : kind }}
          aria-hidden
        />
      )}
      {label}
    </li>
  );
}

/** The frame both charts share: a heading, a text legend and an aria summary. */
function Panel({
  title,
  unit,
  legend,
  summary,
  height,
  children,
}: {
  title: string;
  unit: string;
  legend: React.ReactNode;
  summary: string; // read aloud by screen readers instead of the SVG
  height: number;
  children: React.ReactElement;
}) {
  return (
    <section className="min-w-0 rounded-lg border bg-card p-3">
      <h3 className="text-sm font-medium">
        {title} <span className="font-normal text-muted-foreground">({unit})</span>
      </h3>
      <ul className="mb-1 mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{legend}</ul>
      {/* role="img": to assistive tech the chart is one picture; the label tells the
          story. text-muted-foreground sets currentColor for the axes and grid. */}
      <div role="img" aria-label={summary} className="w-full text-muted-foreground" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%" minHeight={height}>
          {children}
        </ResponsiveContainer>
      </div>
    </section>
  );
}

export function DayTimeline({ service, clockMinutes }: { service: Service; clockMinutes: number }) {
  const { schedules, autoscale, dayLog } = service;
  const now = Math.floor(clockMinutes);

  // PLANNED limits for every minute. effectiveBounds() is cheap but we call it 1440
  // times, so we do it once per change to the schedules or the base limits, not on
  // every poll. (The array identity may change each poll; the work is tiny either way.)
  // We key on the two base numbers (primitives) rather than the whole `autoscale`
  // object, which is a new object on every poll.
  const baseMin = autoscale.min;
  const baseMax = autoscale.max;
  const planned = useMemo(
    () =>
      Array.from({ length: DAY }, (_, m) => {
        const b = effectiveBounds(schedules, m, { min: baseMin, max: baseMax });
        return { min: b.min, max: b.max, windowName: b.source?.note ?? "", phase: b.phase };
      }),
    [schedules, baseMin, baseMax],
  );

  // Merge the plan with what actually happened. dayLog uses -1 for "not seen yet";
  // we turn that into null so the line has a gap there.
  const rows: Row[] = useMemo(
    () =>
      planned.map((p, m) => {
        const inst = dayLog?.instances[m] ?? -1;
        const rps = dayLog?.rps[m] ?? -1;
        return {
          m,
          minLimit: p.min,
          maxLimit: p.max,
          windowName: p.windowName,
          phase: p.phase,
          instances: inst < 0 ? null : inst,
          rps: rps < 0 ? null : rps,
        };
      }),
    [planned, dayLog],
  );

  // Shaded bands for every enabled window (disabled ones are "off" at every minute,
  // so they produce no spans on their own).
  const spans = useMemo(() => schedules.flatMap(spansFor), [schedules]);

  const filled = rows.reduce((n, r) => n + (r.instances === null ? 0 : 1), 0);

  // Not enough points to draw a line yet: a calm placeholder with the chart's height,
  // so the page does not jump when data arrives.
  if (filled < 2) {
    return (
      <Card className={VIZ_TOKENS}>
        <CardHeader className="pb-3">
          <CardTitle>The 24-hour day</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center px-4 text-center text-sm text-muted-foreground" style={{ height: HEIGHT_A }}>
            The day fills in as the clock moves. Turn the speed up to 60x to watch a whole day in about 24 seconds.
          </div>
        </CardContent>
      </Card>
    );
  }

  // y-axis maxima: whole instances for chart A, a "nice" number for traffic.
  const yMaxInstances = Math.max(1, ...rows.map((r) => Math.max(r.maxLimit, r.instances ?? 0)));
  const yMaxRps = niceCeil(Math.max(...rows.map((r) => r.rps ?? 0)) * 1.05);
  const peakInstances = Math.max(...rows.map((r) => r.instances ?? 0));
  const peakRps = Math.round(Math.max(...rows.map((r) => r.rps ?? 0)));
  const here = rows[Math.min(Math.max(now, 0), DAY - 1)];

  // The "now" marker. Near the right edge the label would be clipped, so flip it to
  // the left side of the line.
  const nowLine = (
    <ReferenceLine
      x={now}
      stroke="currentColor"
      strokeOpacity={0.7}
      label={{ value: "now", position: now > 1200 ? "insideTopLeft" : "insideTopRight", fontSize: 10, fill: "currentColor" }}
    />
  );

  // Shared grid and x-axis. Written as a function returning an array (not a custom
  // component) because Recharts looks at its DIRECT children by type.
  const xAxis = [
    <CartesianGrid key="g" vertical={false} stroke="currentColor" strokeOpacity={0.15} />,
    <XAxis
      key="x"
      dataKey="m"
      type="number"
      domain={[0, DAY - 1]}
      ticks={X_TICKS}
      tickFormatter={(v: number) => formatMinute(v)}
      tick={{ fontSize: 11, fill: "currentColor" }}
      tickLine={false}
      axisLine={{ stroke: "currentColor", strokeOpacity: 0.3 }}
      interval={0}
      allowDataOverflow
    />,
  ];

  const cursor = { stroke: "currentColor", strokeOpacity: 0.4 };

  return (
    <Card className={VIZ_TOKENS}>
      <CardHeader className="pb-3">
        <CardTitle>The 24-hour day</CardTitle>
        <CardDescription>
          Horizontal axis is the time of day on the simulated clock. Points to the right of &quot;now&quot; are
          from the previous day until the clock reaches them again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* A. Limits vs actual instances. */}
        <Panel
          title="Instances: limits vs actual"
          unit="count"
          height={HEIGHT_A}
          summary={`Healthy instances over the 24-hour day. At ${formatMinute(now)} there are ${here.instances ?? "no data for"} instances against planned limits of ${here.minLimit} to ${here.maxLimit}. Peak ${peakInstances}. ${schedules.filter((s) => s.enabled !== false).length} enabled schedule windows are shown as shaded bands.`}
          legend={
            <>
              <Key kind="line" color={C.fleet} label="healthy instances" />
              <Key kind="dashed" color={C.limit} label="max limit" />
              <Key kind="dotted" color={C.limit} label="min limit" />
              <Key kind="band" label="window open" />
              <Key kind="band-light" label="pre-warm" />
            </>
          }
        >
          <ComposedChart data={rows} margin={MARGIN}>
            {xAxis}
            <YAxis
              domain={[0, yMaxInstances]}
              allowDecimals={false}
              tick={{ fontSize: 11, fill: "currentColor" }}
              tickLine={false}
              axisLine={false}
              width={30}
            />
            <Tooltip isAnimationActive={false} cursor={cursor} content={<DayTooltip kind="instances" />} />
            {/* Bands are drawn FIRST so the lines sit on top of them. A lighter
                fill marks pre-warm (the instances boot before the window opens). */}
            {spans.map((s) => (
              <ReferenceArea
                key={s.key}
                x1={s.x1}
                x2={s.x2}
                fill="currentColor"
                fillOpacity={s.phase === "active" ? 0.14 : 0.06}
                stroke="none"
              />
            ))}
            {nowLine}
            {/* Limits are STEP lines (they change at an exact minute), dashed and
                neutral because they are a plan, not a measurement. Different dash
                patterns tell min from max without relying on colour. */}
            <Line type="stepAfter" dataKey="maxLimit" stroke={C.limit} strokeWidth={2} strokeDasharray="6 4" dot={false} activeDot={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="minLimit" stroke={C.limit} strokeWidth={2} strokeDasharray="2 3" dot={false} activeDot={false} isAnimationActive={false} />
            {/* Actual instances: solid, in the fleet colour. null entries leave gaps. */}
            <Line
              type="stepAfter"
              dataKey="instances"
              stroke={C.fleet}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: C.fleet, stroke: C.surface, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </Panel>

        {/* B. Traffic, same x-axis: the reason the instances move. */}
        <Panel
          title="Traffic"
          unit="req/s"
          height={HEIGHT_B}
          summary={`Traffic in requests per second over the 24-hour day. At ${formatMinute(now)} it is ${here.rps === null ? "not recorded" : `${Math.round(here.rps)} requests per second`}; peak ${peakRps}.`}
          legend={<Key kind="line" color={C.traffic} label="traffic" />}
        >
          <ComposedChart data={rows} margin={MARGIN}>
            {xAxis}
            <YAxis
              domain={[0, yMaxRps]}
              allowDecimals={false}
              tick={{ fontSize: 11, fill: "currentColor" }}
              tickLine={false}
              axisLine={false}
              width={30}
            />
            <Tooltip isAnimationActive={false} cursor={cursor} content={<DayTooltip kind="rps" />} />
            {nowLine}
            <Line
              type="monotone"
              dataKey="rps"
              stroke={C.traffic}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: C.traffic, stroke: C.surface, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </Panel>
      </CardContent>
    </Card>
  );
}
