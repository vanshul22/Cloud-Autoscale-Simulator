"use client";

// =============================================================================
// ServiceDetails.tsx  —  Rename a service, change its domain, set what an instance costs.
//
// Same draft-string pattern as the other forms: the boxes hold text while you type
// and nothing is sent until you press "Save details". We send ONLY the fields that
// changed, so saving a new name never touches the cost. The server validates again
// (and also checks the domain is not used by another service), so the checks here
// are a friendly first line of defence that mirror `updateService` in commands.ts.
// =============================================================================

import { Save } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Command } from "@/lib/engine/commands";
import type { Service } from "@/lib/engine/types";

// Mirrors validDomain in commands.ts: letters/digits, dots and hyphens, at least one dot.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]{0,58}[a-z0-9])?$/;
const MAX_NAME = 30; // the server cuts names to 30 characters
const MAX_COST = 10; // the server caps the cost at $10/hr

export function ServiceDetails({
  service,
  defaultCost,
  send,
}: {
  service: Service;
  /** The built-in cost per instance-hour, shown so you know what "reset" returns to. */
  defaultCost: number;
  send: (c: Command) => Promise<void>;
}) {
  const [name, setName] = useState(service.name);
  const [domain, setDomain] = useState(service.domain);
  const [cost, setCost] = useState(String(service.costPerInstanceHr));
  const [saving, setSaving] = useState(false);

  // When the server-side values change (after Save, a preset, an import or a reset)
  // show them. Depends on the three primitives, not the `service` object, which is
  // rebuilt on every poll; otherwise each tick would erase what you are typing.
  useEffect(() => setName(service.name), [service.name]);
  useEffect(() => setDomain(service.domain), [service.domain]);
  useEffect(() => setCost(String(service.costPerInstanceHr)), [service.costPerInstanceHr]);

  // ---- validation (computed on every render from the drafts) ----------------------
  const trimmedName = name.trim();
  const trimmedDomain = domain.trim().toLowerCase();
  const costNum = Number(cost);
  const nameError = trimmedName === "" ? "Give the service a name." : null;
  const domainError =
    DOMAIN_RE.test(trimmedDomain) && trimmedDomain.includes(".")
      ? null
      : "Use a domain like shop.demo.app (letters, digits, dots and hyphens).";
  const costError =
    cost.trim() === "" || !Number.isFinite(costNum) || costNum < 0
      ? "Enter a number, zero or more."
      : costNum > MAX_COST
        ? `The most allowed is $${MAX_COST}/hr.`
        : null;
  const invalid = Boolean(nameError || domainError || costError);

  // Which fields differ from what the server holds. Cost is compared as a number
  // because "0.10" and "0.1" are the same price.
  const nameChanged = trimmedName !== service.name;
  const domainChanged = trimmedDomain !== service.domain;
  const costChanged = !costError && Math.abs(costNum - service.costPerInstanceHr) > 1e-9;
  const dirty = nameChanged || domainChanged || costChanged;

  async function save() {
    if (invalid || !dirty) return;
    // Build the patch from changed fields only.
    const patch: { name?: string; domain?: string; costPerInstanceHr?: number } = {};
    if (nameChanged) patch.name = trimmedName;
    if (domainChanged) patch.domain = trimmedDomain;
    if (costChanged) patch.costPerInstanceHr = costNum; // a real number, never the draft string
    setSaving(true);
    try {
      await send({ type: "updateService", serviceId: service.id, patch });
    } finally {
      setSaving(false);
    }
  }

  const id = `${service.id}-details`;
  const atDefaultCost = Math.abs(service.costPerInstanceHr - defaultCost) < 1e-9;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Service details</CardTitle>
        <CardDescription>The name and address people see, and what each running instance costs per hour.</CardDescription>
      </CardHeader>
      <CardContent>
        {/* A real <form> so Enter submits; noValidate because we show our own messages. */}
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={MAX_NAME}
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? `${id}-name-err` : undefined}
                onChange={(e) => setName(e.target.value)}
              />
              {nameError && (
                <p id={`${id}-name-err`} className="text-xs text-destructive">
                  {nameError}
                </p>
              )}
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={`${id}-domain`}>Domain</Label>
              <Input
                id={`${id}-domain`}
                value={domain}
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                aria-invalid={Boolean(domainError)}
                aria-describedby={domainError ? `${id}-domain-err` : undefined}
                onChange={(e) => setDomain(e.target.value)}
              />
              {domainError && (
                <p id={`${id}-domain-err`} className="text-xs text-destructive">
                  {domainError}
                </p>
              )}
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor={`${id}-cost`}>Cost per instance-hour ($)</Label>
              <Input
                id={`${id}-cost`}
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0}
                max={MAX_COST}
                className="tabular-nums"
                value={cost}
                aria-invalid={Boolean(costError)}
                aria-describedby={`${id}-cost-hint`}
                onChange={(e) => setCost(e.target.value)}
              />
              <div id={`${id}-cost-hint`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs text-muted-foreground">
                  Default <span className="font-mono tabular-nums">${defaultCost.toFixed(2)}</span>/hr
                </span>
                {/* Reset only the cost, not the name or domain. Disabled when already default. */}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  disabled={atDefaultCost || saving}
                  onClick={() => void send({ type: "resetServiceConfig", serviceId: service.id, section: "cost" })}
                >
                  Reset cost
                </Button>
              </div>
              {costError && <p className="text-xs text-destructive">{costError}</p>}
            </div>
          </div>
          <Button type="submit" size="sm" disabled={invalid || !dirty || saving}>
            <Save aria-hidden="true" /> {saving ? "Saving..." : "Save details"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
