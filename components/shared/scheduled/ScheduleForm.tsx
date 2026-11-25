"use client";

// =============================================================================
// ScheduleForm.tsx  —  Build your own schedule window.
//
// Every field keeps a DRAFT STRING in local state, so you can type freely (even an
// empty box mid-edit). We validate the drafts on every render and only enable the
// button when they make sense. The server validates again, so this is a friendly
// first line of defence (it explains the problem BEFORE you click), not the only one.
// =============================================================================

import { Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Command } from "@/lib/engine/commands";
import { MAX_SCHEDULES } from "@/lib/engine/commands";
import type { Service } from "@/lib/engine/types";

/** "HH:MM" (what <input type="time"> gives us) -> minutes since midnight, or null if empty/invalid. */
function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** A draft string -> a whole number, or null when it is empty or not a number. */
function toInt(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function ScheduleForm({ service, send }: { service: Service; send: (c: Command) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("18:00");
  const [min, setMin] = useState("2");
  const [max, setMax] = useState("10");
  const [prewarm, setPrewarm] = useState("0");

  const fromMin = toMinutes(from);
  const toMin = toMinutes(to);
  const minN = toInt(min);
  const maxN = toInt(max);
  const preN = toInt(prewarm);

  // Collect every problem so the user sees them all at once, not one per click.
  // The numeric bounds mirror cleanSchedule() in commands.ts (min 0-100, max up to
  // 100, pre-warm 0-180).
  const problems: string[] = [];
  if (fromMin === null || toMin === null) problems.push("Pick both a start and an end time.");
  else if (fromMin === toMin) problems.push("From and To must be different times.");
  if (minN === null || maxN === null) problems.push("Enter whole numbers for min and max instances.");
  else {
    if (minN < 0 || minN > 100) problems.push("Min instances must be between 0 and 100.");
    if (maxN < 1 || maxN > 100) problems.push("Max instances must be between 1 and 100.");
    if (minN > maxN) problems.push("Min instances cannot be higher than max instances.");
  }
  if (preN === null || preN < 0 || preN > 180) problems.push("Pre-warm must be between 0 and 180 minutes.");

  const atLimit = service.schedules.length >= MAX_SCHEDULES;
  const canAdd = problems.length === 0 && !atLimit;
  const crossesMidnight = fromMin !== null && toMin !== null && fromMin > toMin;

  function submit(e: React.FormEvent) {
    e.preventDefault(); // stay on the page; we talk to the server through send()
    // The guard also satisfies TypeScript: after it, every value is a real number.
    if (!canAdd || fromMin === null || toMin === null || minN === null || maxN === null || preN === null) return;
    void send({
      type: "addSchedule",
      serviceId: service.id,
      schedule: { note: note.trim(), fromMin, toMin, min: minN, max: maxN, prewarmMin: preN },
    });
    setNote(""); // keep the numbers: adding a similar window next is common
  }

  const id = (f: string) => `${service.id}-sched-${f}`;
  const problemsId = `${service.id}-sched-problems`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Add a window</CardTitle>
        <CardDescription>New windows go to the end of the list (lowest priority). Reorder them above.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={id("name")}>Name</Label>
            <Input
              id={id("name")}
              type="text"
              maxLength={40}
              placeholder="e.g. Business day"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">A label for you. Up to 40 characters.</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={id("from")}>From</Label>
              <Input id={id("from")} type="time" className="tabular-nums" value={from} onChange={(e) => setFrom(e.target.value)} />
              <p className="text-xs text-muted-foreground">When the window opens.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id("to")}>To</Label>
              <Input id={id("to")} type="time" className="tabular-nums" value={to} onChange={(e) => setTo(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                When it closes. A To earlier than From means the window crosses midnight (23:00 to 07:00).
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id("min")}>Min instances</Label>
              <Input
                id={id("min")}
                type="number"
                inputMode="numeric"
                min={0}
                max={100}
                className="tabular-nums"
                value={min}
                onChange={(e) => setMin(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">The floor: never fewer than this during the window.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id("max")}>Max instances</Label>
              <Input
                id={id("max")}
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                className="tabular-nums"
                value={max}
                onChange={(e) => setMax(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">The ceiling: never more than this (it caps your cloud bill).</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={id("prewarm")}>Pre-warm (minutes)</Label>
            <Input
              id={id("prewarm")}
              type="number"
              inputMode="numeric"
              min={0}
              max={180}
              className="tabular-nums sm:max-w-[50%]"
              value={prewarm}
              onChange={(e) => setPrewarm(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Start this many minutes early. New instances take about 3 ticks to boot, so 10 is a safe lead. 0 = no pre-warm.
            </p>
          </div>

          {crossesMidnight && problems.length === 0 && (
            <p className="text-xs text-muted-foreground">This window crosses midnight: it runs from the evening into the next morning.</p>
          )}

          {/* Problems are plain text next to the button, linked with aria-describedby
              so a screen reader reads WHY the button is disabled. */}
          {problems.length > 0 && (
            <ul id={problemsId} className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          <Button type="submit" disabled={!canAdd} aria-describedby={problems.length > 0 ? problemsId : undefined}>
            <Plus aria-hidden="true" /> Add window
          </Button>
          {atLimit && (
            <p className="text-xs text-muted-foreground">A service can have at most {MAX_SCHEDULES} windows. Remove one first.</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
