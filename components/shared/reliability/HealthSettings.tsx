"use client";

// =============================================================================
// HealthSettings.tsx  —  The dials of the self-healing policy.
//
// Same pattern as QueueControls: each numeric field keeps a DRAFT STRING so you can
// type freely (even an empty box mid-edit), and we only send to the server on blur or
// Enter. The server clamps again, so the bounds here mirror `updateHealth` in
// commands.ts as a friendly first line of defence. Errors show in the app banner.
// =============================================================================

import { useEffect, useRef, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Command } from "@/lib/engine/commands";
import type { HealthConfig, Service } from "@/lib/engine/types";

type NumField =
  | "checkFailuresToEject"
  | "restartBackoffTicks"
  | "maxRestarts"
  | "readinessLatencyFactor"
  | "faultDurationTicks"
  | "errorRateToTrip"
  | "circuitOpenTicks";

// Each hint states the TRADE-OFF: every knob buys something and costs something.
const FIELDS: { key: NumField; label: string; hint: string; min: number; max: number }[] = [
  {
    key: "checkFailuresToEject",
    label: "Failed checks before removal",
    hint: "Low reacts fast but a single blip can pull a good instance; high is calmer but lets dead ones eat traffic longer.",
    min: 1,
    max: 10,
  },
  {
    key: "restartBackoffTicks",
    label: "Restart backoff (ticks)",
    hint: "Base wait before a restart; it doubles each time. Short recovers quickly, long avoids hammering a broken instance.",
    min: 1,
    max: 30,
  },
  {
    key: "maxRestarts",
    label: "Max restarts",
    hint: "How many restarts before giving up (crash loop). 0 never restarts; high keeps retrying a permanently broken instance.",
    min: 0,
    max: 10,
  },
  {
    key: "readinessLatencyFactor",
    label: "Slow x that fails readiness",
    hint: "An instance this many times slower is taken out of rotation (not restarted). Low removes slow ones early but shrinks capacity.",
    min: 2,
    max: 50,
  },
  {
    key: "faultDurationTicks",
    label: "Slow/error fault lasts (ticks)",
    hint: "How long injected slowness or errors last before clearing by themselves. Crashes are not timed: they need a restart.",
    min: 5,
    max: 300,
  },
  {
    key: "errorRateToTrip",
    label: "Breaker trips above (% errors)",
    hint: "Low protects early but trips on small problems; high tolerates more failures before refusing traffic.",
    min: 1,
    max: 100,
  },
  {
    key: "circuitOpenTicks",
    label: "Breaker stays open (ticks)",
    hint: "Short tests recovery sooner but may re-trip; long gives the system more rest but refuses users for longer.",
    min: 2,
    max: 60,
  },
];

const toDrafts = (h: Pick<Required<HealthConfig>, NumField>): Record<NumField, string> => ({
  checkFailuresToEject: String(h.checkFailuresToEject),
  restartBackoffTicks: String(h.restartBackoffTicks),
  maxRestarts: String(h.maxRestarts),
  readinessLatencyFactor: String(h.readinessLatencyFactor),
  faultDurationTicks: String(h.faultDurationTicks),
  errorRateToTrip: String(h.errorRateToTrip),
  circuitOpenTicks: String(h.circuitOpenTicks),
});

export function HealthSettings({
  service,
  health,
  send,
}: {
  service: Service;
  health: Required<HealthConfig>;
  send: (c: Command) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<NumField, string>>(() => toDrafts(health));
  // A ref (not state) so moving focus does not re-run the resync effect below.
  const focused = useRef<NumField | null>(null);

  // Refresh every draft EXCEPT the one being typed in, so an incoming tick never
  // clobbers half-typed input. Depends on the primitive values, not the `health`
  // object (which is rebuilt on every poll).
  const {
    checkFailuresToEject,
    restartBackoffTicks,
    maxRestarts,
    readinessLatencyFactor,
    faultDurationTicks,
    errorRateToTrip,
    circuitOpenTicks,
  } = health;
  useEffect(() => {
    setDrafts((prev) => {
      const fresh = toDrafts({
        checkFailuresToEject,
        restartBackoffTicks,
        maxRestarts,
        readinessLatencyFactor,
        faultDurationTicks,
        errorRateToTrip,
        circuitOpenTicks,
      });
      const f = focused.current;
      return f ? { ...fresh, [f]: prev[f] } : fresh;
    });
  }, [
    checkFailuresToEject,
    restartBackoffTicks,
    maxRestarts,
    readinessLatencyFactor,
    faultDurationTicks,
    errorRateToTrip,
    circuitOpenTicks,
  ]);

  // Validate + send one field. Called on blur and on Enter.
  function commit(field: NumField, bounds: { min: number; max: number }) {
    const num = Number(drafts[field]);
    // Empty / non-numeric: throw the draft away and show the real value again.
    if (drafts[field].trim() === "" || !Number.isFinite(num)) {
      setDrafts((d) => ({ ...d, [field]: String(health[field]) }));
      return;
    }
    const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.round(num)));
    setDrafts((d) => ({ ...d, [field]: String(clamped) }));
    if (clamped === health[field]) return; // nothing changed -> skip the request
    void send({ type: "updateHealth", serviceId: service.id, patch: { [field]: clamped } });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Reliability settings</CardTitle>
        <CardDescription>Changes apply on the next tick.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`${service.id}-health-${f.key}`}>{f.label}</Label>
              <Input
                id={`${service.id}-health-${f.key}`}
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
      </CardContent>
    </Card>
  );
}
