"use client";

// =============================================================================
// AlertRules.tsx  —  The rules that decide when an alert exists.
//
// A rule is "watch METRIC; if it is above/below THRESHOLD for FOR-TICKS ticks in a
// row, fire". Two ways to edit, both sending commands:
//   * the table edits a rule in place (toggle, threshold, for-ticks, remove);
//   * the form below it adds a new one.
//
// Numeric fields keep a DRAFT STRING and only send on blur or Enter (same pattern as
// HealthSettings), so typing "150" does not send "1", "15" and "150" to the server.
// The server validates again; the bounds here just make the form helpful.
// =============================================================================

import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SeverityBadge } from "@/components/shared/events/ActiveAlerts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MAX_ALERT_RULES, describeRule, metricLabel } from "@/lib/engine/alerts";
import type { Command } from "@/lib/engine/commands";
import type { AlertMetric, AlertRule, Service } from "@/lib/engine/types";
import { cn } from "@/lib/utils";

// Bounds mirror cleanRule() in commands.ts (forTicks 1-120, threshold +-1e6).
const FOR_MIN = 1;
const FOR_MAX = 120;
const THRESHOLD_LIMIT = 1e6;

const METRICS: AlertMetric[] = ["p95", "errRate", "utilisation", "queueDepth", "healthyInstances", "crashLoops", "burnRate"];

/**
 * A small number box that commits on blur/Enter. `integer` rounds (for-ticks);
 * thresholds may have decimals (a burn rate of 1.5).
 */
function NumberCell({
  value,
  min,
  max,
  integer,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  integer: boolean;
  label: string;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // A ref, not state: focus changes must not re-run the resync effect below.
  const focused = useRef(false);

  // Pull in the server's value, but never while the user is typing in this box
  // (a tick arrives every second and would wipe half-typed input).
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  function commit() {
    const num = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(num)) {
      setDraft(String(value)); // junk: throw the draft away and show the real value
      return;
    }
    const clamped = Math.min(max, Math.max(min, integer ? Math.round(num) : num));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped); // nothing changed -> skip the request
  }

  return (
    <Input
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      step="any"
      min={min}
      max={max}
      aria-label={label}
      className="h-8 w-20 tabular-nums"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      // Enter commits by blurring, which funnels through onBlur above.
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

export function AlertRules({
  rules,
  services,
  send,
}: {
  rules: AlertRule[];
  services: Service[];
  send: (c: Command) => Promise<void>;
}) {
  const atLimit = rules.length >= MAX_ALERT_RULES;
  const scopeName = (id: string) => (id === "*" ? "All services" : (services.find((s) => s.id === id)?.name ?? id));

  // ---- the "Add a rule" form: every field is a draft ----
  const [name, setName] = useState("");
  const [metric, setMetric] = useState<AlertMetric>("utilisation");
  const [op, setOp] = useState<">" | "<">(">");
  const [threshold, setThreshold] = useState("80");
  const [forTicks, setForTicks] = useState("3");
  const [severity, setSeverity] = useState<AlertRule["severity"]>("warning");
  const [scope, setScope] = useState("*");

  const thresholdN = threshold.trim() === "" ? NaN : Number(threshold);
  const forN = forTicks.trim() === "" ? NaN : Number(forTicks);

  // Collect every problem so the user sees them all before clicking.
  const problems: string[] = [];
  if (name.trim() === "") problems.push("Give the rule a name.");
  if (!Number.isFinite(thresholdN) || Math.abs(thresholdN) > THRESHOLD_LIMIT) problems.push("Threshold must be a number.");
  if (!Number.isInteger(forN) || forN < FOR_MIN || forN > FOR_MAX) {
    problems.push(`'For' must be a whole number of ticks from ${FOR_MIN} to ${FOR_MAX}.`);
  }
  const canAdd = problems.length === 0 && !atLimit;
  const unit = metricLabel(metric).unit.trim();

  function submit(e: React.FormEvent) {
    e.preventDefault(); // stay on the page; we talk to the server through send()
    if (!canAdd) return;
    void send({
      type: "addAlertRule",
      rule: { name: name.trim(), metric, op, threshold: thresholdN, forTicks: forN, severity, serviceId: scope },
    });
    setName(""); // keep the rest: adding a sibling rule is the common next step
  }

  function restoreDefaults() {
    // Replaces every rule (and clears live alerts), so ask first.
    if (window.confirm("Restore the default alert rules? Your changes and any rules you added will be lost.")) {
      void send({ type: "resetAlertRules" });
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Alert rules</CardTitle>
        <CardDescription>Changes apply on the next tick.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {rules.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            No rules, so nothing can alert. Add one below or restore the defaults.
          </p>
        ) : (
          // The Table wrapper scrolls sideways inside itself, so a wide table never
          // makes the whole page scroll on a phone.
          <Table className="tabular-nums">
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">On</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Threshold</TableHead>
                <TableHead>For (ticks)</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">Remove</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r) => {
                // A disabled rule is dimmed, but its controls stay usable so you can edit then re-enable.
                const dim = r.enabled ? "" : "opacity-60";
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Switch
                        checked={r.enabled}
                        aria-label={`Enable ${r.name}`}
                        onCheckedChange={(on) =>
                          void send({ type: "updateAlertRule", ruleId: r.id, patch: { enabled: on } })
                        }
                      />
                    </TableCell>
                    <TableCell className={cn("min-w-[9rem] break-words font-medium", dim)}>{r.name}</TableCell>
                    <TableCell className={cn("min-w-[11rem] text-xs text-muted-foreground", dim)}>
                      {describeRule(r)}
                    </TableCell>
                    <TableCell className={dim}>
                      <SeverityBadge severity={r.severity} />
                    </TableCell>
                    <TableCell className={cn("whitespace-nowrap", dim)}>{scopeName(r.serviceId)}</TableCell>
                    <TableCell>
                      <NumberCell
                        value={r.threshold}
                        min={-THRESHOLD_LIMIT}
                        max={THRESHOLD_LIMIT}
                        integer={false}
                        label={`Threshold for ${r.name}`}
                        onCommit={(n) => void send({ type: "updateAlertRule", ruleId: r.id, patch: { threshold: n } })}
                      />
                    </TableCell>
                    <TableCell>
                      <NumberCell
                        value={r.forTicks}
                        min={FOR_MIN}
                        max={FOR_MAX}
                        integer
                        label={`For ticks for ${r.name}`}
                        onCommit={(n) => void send({ type: "updateAlertRule", ruleId: r.id, patch: { forTicks: n } })}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        aria-label={`Remove rule ${r.name}`}
                        onClick={() => void send({ type: "removeAlertRule", ruleId: r.id })}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {/* ---------------- Add a rule ---------------- */}
        <form onSubmit={submit} className="space-y-3 border-t pt-4" aria-labelledby="add-rule-heading">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id="add-rule-heading" className="text-sm font-medium">
              Add a rule
            </h3>
            <span className="text-xs tabular-nums text-muted-foreground">
              {rules.length} / {MAX_ALERT_RULES} rules
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="rule-name">Name</Label>
              <Input
                id="rule-name"
                value={name}
                maxLength={40}
                placeholder="e.g. Checkout is slow"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rule-metric">Metric</Label>
              <Select value={metric} onValueChange={(v) => setMetric(v as AlertMetric)}>
                <SelectTrigger id="rule-metric" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METRICS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {metricLabel(m).label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rule-op">Comparison</Label>
              <Select value={op} onValueChange={(v) => setOp(v as ">" | "<")}>
                <SelectTrigger id="rule-op" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value=">">is above</SelectItem>
                  <SelectItem value="<">is below</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rule-threshold">Threshold{unit ? ` (${unit})` : ""}</Label>
              <Input
                id="rule-threshold"
                type="number"
                inputMode="decimal"
                step="any"
                className="tabular-nums"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rule-for">For (ticks, 1-120)</Label>
              <Input
                id="rule-for"
                type="number"
                inputMode="numeric"
                min={FOR_MIN}
                max={FOR_MAX}
                className="tabular-nums"
                value={forTicks}
                onChange={(e) => setForTicks(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rule-severity">Severity</Label>
              <Select value={severity} onValueChange={(v) => setSeverity(v as AlertRule["severity"])}>
                <SelectTrigger id="rule-severity" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="warning">warning</SelectItem>
                  <SelectItem value="critical">critical</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rule-scope">Scope</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger id="rule-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="*">All services</SelectItem>
                  {services.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Problems are text, listed before the click that would fail. */}
          {problems.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {atLimit && (
            <p className="text-xs text-muted-foreground">
              At most {MAX_ALERT_RULES} rules. Remove one to add another.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={!canAdd}>
              <Plus aria-hidden="true" /> Add rule
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={restoreDefaults}>
              <RotateCcw aria-hidden="true" /> Restore default rules
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
