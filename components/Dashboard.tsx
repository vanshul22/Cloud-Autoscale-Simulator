"use client";

import Link from "next/link";
import { AlertTriangle, BookOpen, Cloud, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { Overview } from "@/components/tabs/Overview";
import { Cluster } from "@/components/tabs/Cluster";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "sonner";
import { useAlertToasts } from "@/hooks/useAlertToasts";
import { usePlatform } from "@/hooks/usePlatform";
import { useQueryState } from "@/hooks/useQueryState";
import { useSoundSetting } from "@/hooks/useSoundSetting";
import { cn } from "@/lib/utils";

// Tabs that exist in the plan but are not built yet: visible, disabled, hinted.
const SOON_TABS = [
  "Deployments",
  "Scheduled Scaling",
  "Queue & Workers",
  "Reliability",
  "Events & Alerts",
  "Config",
] as const;

const SPEEDS = [1, 5, 60] as const;

// The tabs that are actually built. A URL asking for any other tab (a typo, or a
// "soon" tab) falls back to Overview instead of showing an empty page.
const TABS = ["overview", "cluster"] as const;

/** 0..1439 minutes since midnight -> "HH:MM". */
function formatClock(mins: number): string {
  const m = Math.floor(mins) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function Dashboard() {
  const { platform, storage, error, loading, send } = usePlatform();
  const [soundOn, setSoundOn] = useSoundSetting();
  useAlertToasts(platform, soundOn); // pop-ups (and sound) for alerts and warnings
  // View state (which tab, which service) lives in the URL query string, e.g.
  //   /?tab=cluster&service=web
  // so a refresh or a shared link restores exactly this view. World state still
  // lives on the server. Defaults are omitted from the URL to keep it clean.
  const [tab, setTab] = useQueryState("tab", "overview", TABS);
  const [serviceParam, setServiceParam] = useQueryState<string>("service", "");
  const serviceId = serviceParam || null; // "" (no param) means "first service"

  function selectService(id: string) {
    setServiceParam(id);
    setTab("cluster");
  }

  function handleReset() {
    // Reset wipes every service, so make the user confirm it.
    if (window.confirm("Reset the simulation? All services return to their defaults.")) {
      void send({ type: "reset" });
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 sm:px-6">
      {/* Where the alert pop-ups render. richColors tints error/warning/success.
          `expand` keeps every toast fully visible instead of collapsing them into a
          stack, and visibleToasts lifts the default limit of 3 so none are hidden. */}
      <Toaster theme="dark" position="top-right" richColors closeButton expand visibleToasts={10} />
      {/* ---------------- Header ---------------- */}
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary" aria-hidden="true">
            <Cloud className="h-5 w-5" />
          </span>
          <h1 className="text-base font-semibold tracking-tight sm:text-lg">Cloud Autoscale Simulator</h1>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Storage pill: tells you whether state survives a server restart. */}
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground"
            title={storage === "redis" ? "State is persisted in Redis" : "State lives in server memory and resets on restart"}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", storage === "redis" ? "bg-[hsl(var(--success))]" : "bg-[hsl(var(--warning))]")} aria-hidden="true" />
            storage: <span className="font-mono text-foreground">{storage ?? "…"}</span>
          </span>

          {/* Simulated clock + tick; fixed-width mono so digits never shift neighbours. */}
          <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground" aria-label="Simulation time">
            <span>
              sim <span className="inline-block min-w-[3.5ch] text-sm text-foreground">{platform ? formatClock(platform.clockMinutes) : "--:--"}</span>
            </span>
            <span>
              tick <span className="inline-block min-w-[5ch] text-foreground">{platform?.tick ?? "-"}</span>
            </span>
          </div>

          {/* Speed: a toggle group. aria-pressed announces which one is active. */}
          <div role="group" aria-label="Simulation speed" className="inline-flex rounded-lg border p-0.5">
            {SPEEDS.map((sp) => (
              <button
                key={sp}
                type="button"
                disabled={!platform}
                aria-pressed={platform?.speed === sp}
                onClick={() => void send({ type: "setSpeed", speed: sp })}
                className="min-w-10 rounded-md px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
              >
                {sp}x
              </button>
            ))}
          </div>

          {/* Alert sound on/off. Turning it ON plays a short chime so you can hear it works. */}
          <Button
            variant="outline"
            size="sm"
            aria-pressed={soundOn}
            aria-label={soundOn ? "Alert sound on. Click to mute" : "Alert sound off. Click to unmute"}
            title={soundOn ? "Alert sound on" : "Alert sound off"}
            onClick={() => setSoundOn(!soundOn)}
          >
            {soundOn ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}
            Sound {soundOn ? "on" : "off"}
          </Button>

          <Button variant="outline" size="sm" onClick={handleReset} disabled={!platform}>
            <RotateCcw aria-hidden="true" /> Reset
          </Button>
        </div>
      </header>

      {/* Friendly error banner. role=alert makes screen readers announce it. */}
      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {platform ? "Something went wrong: " : "Can't reach the simulator yet: "}
            {error}
            {platform ? "" : ". Retrying every second."}
          </span>
        </div>
      )}

      {/* ---------------- Body ---------------- */}
      {loading && !platform ? (
        <LoadingSkeleton />
      ) : platform ? (
        <Tabs value={tab} onValueChange={setTab}>
          <div className="flex items-center justify-between gap-3">
          {/* Horizontal scroll *inside* this strip keeps the page itself from scrolling sideways on phones. */}
          <div className="-mx-4 min-w-0 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <TabsList className="h-auto w-max justify-start gap-1 bg-transparent p-0">
              <TabsTrigger value="overview" className="data-[state=active]:bg-accent">
                Overview
              </TabsTrigger>
              <TabsTrigger value="cluster" className="data-[state=active]:bg-accent">
                Autoscaling Cluster
              </TabsTrigger>
              {SOON_TABS.map((name) => (
                <TabsTrigger key={name} value={name} disabled className="gap-1.5">
                  {name}
                  <span className="rounded bg-muted px-1 text-[10px] uppercase tracking-wide">soon</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {/* The doc for whichever tab is open: /docs/overview or /docs/cluster. */}
          <Link
            href={`/docs/${tab}`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" /> Docs
          </Link>
          </div>

          <TabsContent value="overview" className="mt-4">
            <Overview platform={platform} onSelect={selectService} />
          </TabsContent>
          <TabsContent value="cluster" className="mt-4">
            <Cluster platform={platform} serviceId={serviceId} onSelectService={setServiceParam} send={send} />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}

/** Placeholder blocks shaped like the real layout so the page doesn't jump on load. */
function LoadingSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading simulation">
      <div className="h-9 w-72 max-w-full rounded-lg bg-muted motion-safe:animate-pulse" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
        ))}
      </div>
      <div className="h-56 rounded-xl bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
