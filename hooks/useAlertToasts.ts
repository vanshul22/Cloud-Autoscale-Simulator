"use client";

// =============================================================================
// useAlertToasts  —  Turns service HEALTH CHANGES into pop-up notifications.
//
// The engine writes events; it knows nothing about the UI. This hook is the
// bridge. It deliberately shows very little: only events marked kind:"status",
// which the engine writes exactly once each time a service's health changes:
//
//   red    (error)  : users are seeing failures          -> siren, stays until closed
//   yellow (warn)   : under strain / still recovering    -> double beep
//   green  (info)   : healthy again                      -> soft chime
//
// Routine events (instance added, scaling up...) are in the event log, never here.
//
// ONE TOAST SLOT PER SERVICE: each toast uses the service id as its `id`, so a new
// status REPLACES that service's previous toast instead of stacking. The red
// toast simply turns green when the service recovers. You always see the
// current status, never a pile of stale ones.
// =============================================================================

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { Platform, SimEvent } from "@/lib/engine/types";
import { playSound, type SoundKind } from "@/lib/sound";

// Events have no id, so identify one by its content.
const keyOf = (e: SimEvent) => `${e.t}|${e.service}|${e.level}|${e.msg}`;

// When several statuses land together we play ONE sound, for the worst of them.
const SEVERITY: Record<SoundKind, number> = { success: 1, warn: 2, error: 3 };

export function useAlertToasts(platform: Platform | null, soundOn: boolean): void {
  // Keys of events already handled. null until the first snapshot arrives.
  const seen = useRef<Set<string> | null>(null);
  const lastTick = useRef(0);

  useEffect(() => {
    if (!platform) return;

    // First snapshot, or the world was reset (tick went backwards): treat the
    // existing history as already read. Otherwise a page refresh would replay
    // every old status change as a fresh notification.
    if (seen.current === null || platform.tick < lastTick.current) {
      seen.current = new Set(platform.events.map(keyOf));
      lastTick.current = platform.tick;
      return;
    }
    lastTick.current = platform.tick;

    // Only status changes are notification-worthy. Events are newest-first;
    // reverse so they are shown in the order they happened.
    const fresh = platform.events
      .filter((e) => e.kind === "status" && !seen.current!.has(keyOf(e)))
      .reverse();

    let loudest: SoundKind | null = null;
    for (const e of fresh) {
      const kind = notify(e, platform);
      if (!loudest || SEVERITY[kind] > SEVERITY[loudest]) loudest = kind;
    }
    if (loudest && soundOn) playSound(loudest);

    // Keep only keys still in the capped log, so this set can never grow forever.
    seen.current = new Set(platform.events.map(keyOf));
  }, [platform, soundOn]);
}

/** Show the toast for one status change. Returns its sound kind. */
function notify(e: SimEvent, platform: Platform): SoundKind {
  const name = platform.services.find((s) => s.id === e.service)?.name ?? "Platform";
  const id = `status-${e.service}`; // same id => replaces the service's previous toast

  if (e.level === "error") {
    // Infinity = stays until closed (or replaced by the next status). A real
    // incident does not vanish on a timer; someone has to acknowledge it.
    toast.error(`Critical: ${name}`, { id, description: e.msg, duration: Infinity });
    return "error";
  }
  if (e.level === "warn") {
    toast.warning(`Warning: ${name}`, { id, description: e.msg, duration: 20000 });
    return "warn";
  }
  toast.success(`Healthy: ${name}`, { id, description: e.msg, duration: 8000 });
  return "success";
}
