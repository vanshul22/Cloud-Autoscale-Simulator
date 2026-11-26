"use client";

// =============================================================================
// ServiceManager.tsx  —  "Go live" with a brand-new service, or shut one down.
//
// Going live is a deployment too: the platform starts the instances, waits for them
// to pass their health checks, then puts them behind the load balancer. A new service
// starts with NO traffic, so it sits idle until you give it some (Cluster tab).
//
// Like the other forms, each field keeps a DRAFT STRING so you can type freely, and we
// validate on every render. The server validates again; this just explains the
// problem before you click.
// =============================================================================

import { Plus, Power, Server } from "lucide-react";
import { useId, useState } from "react";

import { StatusBadge } from "@/components/shared/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Command } from "@/lib/engine/commands";
import { MAX_SERVICES } from "@/lib/engine/commands";
import type { Platform } from "@/lib/engine/types";

// "api.demo.app": dot-separated labels of letters, digits and hyphens, at least two
// of them, and no label may start or end with a hyphen.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function ServiceManager({ platform, send }: { platform: Platform; send: (c: Command) => Promise<void> }) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [count, setCount] = useState("2");
  const [busy, setBusy] = useState(false);

  const uid = useId();
  const id = (f: string) => `${uid}-${f}`;
  const problemsId = id("problems");

  const cleanName = name.trim();
  const cleanDomain = domain.trim();
  const n = count.trim() === "" ? NaN : Number(count);

  const problems: string[] = [];
  if (cleanName === "") problems.push("Give the service a name.");
  if (!DOMAIN_RE.test(cleanDomain)) problems.push("The domain must look like api.demo.app (letters, digits, dots, hyphens).");
  if (!Number.isInteger(n) || n < 1 || n > 6) problems.push("Instances must be a whole number from 1 to 6.");

  const atLimit = platform.services.length >= MAX_SERVICES;
  const canGo = problems.length === 0 && !atLimit && !busy;
  // Only scold once the user has started typing; an untouched form just shows hints.
  const touched = name !== "" || domain !== "";

  async function run(c: Command) {
    setBusy(true);
    try {
      await send(c);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault(); // stay on the page; we talk to the server through send()
    if (!canGo) return;
    void run({ type: "createService", name: cleanName, domain: cleanDomain, instances: n });
    setName("");
    setDomain("");
  }

  const onlyOne = platform.services.length <= 1;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4" aria-hidden="true" /> Go live with a new service
        </CardTitle>
        <CardDescription>
          Up to {MAX_SERVICES} services. A new service starts with no traffic. Select it in the Cluster tab and set its
          traffic.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={id("name")}>Name</Label>
            <Input
              id={id("name")}
              type="text"
              maxLength={30}
              placeholder="e.g. Payments"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("domain")}>Domain</Label>
            <Input
              id={id("domain")}
              type="text"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="api.demo.app"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("count")}>Instances</Label>
            <Input
              id={id("count")}
              type="number"
              inputMode="numeric"
              min={1}
              max={6}
              className="tabular-nums sm:max-w-[50%]"
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">How many to start with (1-6). The autoscaler can change it later.</p>
          </div>

          {/* Problems are plain text, linked to the button with aria-describedby so a
              screen reader says WHY it is disabled. */}
          {touched && problems.length > 0 && (
            <ul id={problemsId} className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          <Button type="submit" disabled={!canGo} aria-describedby={touched && problems.length > 0 ? problemsId : undefined}>
            <Plus aria-hidden="true" /> Go live
          </Button>
          {atLimit && (
            <p className="text-xs text-muted-foreground">
              The platform is full ({MAX_SERVICES} services). Shut one down to make room.
            </p>
          )}
        </form>

        <div className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Services ({platform.services.length} of {MAX_SERVICES})
          </h3>
          <ul className="divide-y rounded-md border">
            {platform.services.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1 basis-40">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{s.domain}</div>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusBadge status={s.status} />
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {s.version} · {s.instances.filter((i) => i.status !== "draining").length} instances
                    {s.provisioning ? " · going live" : ""}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  aria-label={`Shut down ${s.name}`}
                  // The platform needs at least one service to show anything.
                  disabled={busy || onlyOne}
                  title={onlyOne ? "The last service cannot be shut down" : undefined}
                  onClick={() => {
                    // Shutting down deletes the service and its history, so confirm first.
                    if (window.confirm(`Shut down ${s.name}? Its instances and history are removed.`)) {
                      void run({ type: "deleteService", serviceId: s.id });
                    }
                  }}
                >
                  <Power aria-hidden="true" /> Shut down
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
