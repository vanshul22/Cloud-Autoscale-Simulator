"use client";

// =============================================================================
// ConfigPanel.tsx  —  Edit the autoscaler's rules and the load balancer.
//
// Each numeric field keeps a *draft string* in local state so the user can type
// freely (even an empty box mid-edit). We only send to the server when they
// finish (blur or Enter). The server clamps again, so validation here is just
// a friendly first line of defence.
// =============================================================================

import { useEffect, useRef, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Command } from "@/lib/engine/commands";
import type { AutoscaleConfig, LbAlgo, Service } from "@/lib/engine/types";

// The numeric fields of AutoscaleConfig (everything except `lb`, a string, and
// `enabled`, a boolean: those two have their own controls).
type NumField = Exclude<keyof AutoscaleConfig, "lb" | "enabled">;

// Field metadata drives both the rendering and the clamping. The bounds mirror
// the server's `updateAutoscale` so what you see is what will be stored.
const FIELDS: { key: NumField; label: string; hint: string; min: number; max: number }[] = [
  { key: "min", label: "Min instances", hint: "Never scale below", min: 0, max: 100 },
  { key: "max", label: "Max instances", hint: "Never scale above", min: 1, max: 100 },
  { key: "rpsPerInstance", label: "RPS per instance", hint: "Capacity of one instance", min: 1, max: 10000 },
  { key: "scaleUpAt", label: "Scale up at (%)", hint: "Add instances above this", min: 1, max: 100 },
  { key: "scaleDownAt", label: "Scale down at (%)", hint: "Remove instances below this", min: 0, max: 99 },
  { key: "cooldownTicks", label: "Cooldown (ticks)", hint: "Pause between scale actions", min: 0, max: 120 },
];

// These describe what the engine really does (see lib/engine/balancer.ts). The
// choice only matters once instances differ in size or speed.
const LB_INFO: Record<LbAlgo, { label: string; blurb: string }> = {
  "round-robin": {
    label: "Round robin",
    blurb:
      "Equal number of requests to every instance. Ignores instance size and speed, so small or slow instances get overloaded.",
  },
  "least-conn": {
    label: "Least connections",
    blurb:
      "Sends traffic where there are the fewest open connections per unit of size. A slow instance holds connections longer, so it automatically gets less.",
  },
  weighted: {
    label: "Weighted",
    blurb:
      "Traffic proportional to instance size (a 2x instance gets twice as much). Does not notice a slow instance.",
  },
};

export function ConfigPanel({
  service,
  send,
}: {
  service: Service;
  send: (c: Command) => Promise<void>;
}) {
  const cfg = service.autoscale;
  // Worlds saved before the switch existed have no `enabled`; they were always
  // autoscaling, so undefined counts as ON.
  const autoscaleOn = cfg.enabled !== false;

  // One draft string per field, plus which field (if any) currently has focus.
  const [drafts, setDrafts] = useState<Record<NumField, string>>(() => toDrafts(cfg));
  // A ref (not state) so changing focus doesn't re-run the resync effect below;
  // otherwise blur would briefly flash the OLD server value before the reply lands.
  const focused = useRef<NumField | null>(null);

  // Whenever the server-side config changes, refresh every draft EXCEPT the one
  // being typed in, so an incoming tick never clobbers half-typed input.
  useEffect(() => {
    setDrafts((prev) => {
      const fresh = toDrafts(cfg);
      const f = focused.current;
      return f ? { ...fresh, [f]: prev[f] } : fresh;
    });
  }, [cfg]);

  // Validate + send one field. Called on blur and on Enter.
  function commit(field: NumField, bounds: { min: number; max: number }) {
    const n = Number(drafts[field]);
    // Empty / non-numeric: throw the draft away and show the real value again.
    if (drafts[field].trim() === "" || !Number.isFinite(n)) {
      setDrafts((d) => ({ ...d, [field]: String(cfg[field]) }));
      return;
    }
    const clamped = Math.min(bounds.max, Math.max(bounds.min, n));
    setDrafts((d) => ({ ...d, [field]: String(clamped) }));
    if (clamped === cfg[field]) return; // nothing changed -> skip the request
    void send({ type: "updateAutoscale", serviceId: service.id, patch: { [field]: clamped } });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Autoscaling &amp; load balancer</CardTitle>
        <CardDescription>
          Between scaleDownAt and scaleUpAt nothing happens (deadband prevents flapping)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start gap-3">
          <Switch
            id={`${service.id}-autoscale-enabled`}
            className="mt-0.5"
            checked={autoscaleOn}
            onCheckedChange={(on) =>
              void send({ type: "updateAutoscale", serviceId: service.id, patch: { enabled: on } })
            }
          />
          <div className="space-y-1">
            <Label htmlFor={`${service.id}-autoscale-enabled`}>Autoscaling</Label>
            <p className="text-xs text-muted-foreground">
              Off = hands off: the autoscaler never adds or removes instances, so you can size the
              fleet yourself with the Add/Remove buttons.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`${service.id}-${f.key}`}>{f.label}</Label>
              <Input
                id={`${service.id}-${f.key}`}
                type="number"
                inputMode="decimal"
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

        <div className="space-y-1.5">
          <Label htmlFor={`${service.id}-lb`}>Load balancer algorithm</Label>
          <Select
            value={cfg.lb}
            onValueChange={(v) =>
              void send({ type: "updateAutoscale", serviceId: service.id, patch: { lb: v as LbAlgo } })
            }
          >
            <SelectTrigger id={`${service.id}-lb`} className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LB_INFO) as LbAlgo[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {LB_INFO[k].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{LB_INFO[cfg.lb].blurb}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// Turn the numeric config into the string drafts the inputs display.
function toDrafts(cfg: AutoscaleConfig): Record<NumField, string> {
  return {
    min: String(cfg.min),
    max: String(cfg.max),
    rpsPerInstance: String(cfg.rpsPerInstance),
    scaleUpAt: String(cfg.scaleUpAt),
    scaleDownAt: String(cfg.scaleDownAt),
    cooldownTicks: String(cfg.cooldownTicks),
  };
}
