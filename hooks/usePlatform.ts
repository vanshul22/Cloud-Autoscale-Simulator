"use client";

// =============================================================================
// usePlatform  —  the browser's single connection to the simulation.
//
// The server holds the world; the browser only ever has a *snapshot*. This hook:
//   1. polls GET /api/sim every second (the server advances time on each read),
//   2. exposes `send(cmd)` which POSTs a Command and applies the reply at once,
//      so a slider drag feels instant instead of waiting up to 1s for a poll.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
// `import type` is erased at build time: no server code reaches the client bundle.
import type { Command } from "@/lib/engine/commands";
import type { Platform } from "@/lib/engine/types";

// Locally, poll every second for the smoothest charts. When deployed, poll every
// 2s: the server still simulates every elapsed second (time is derived from the
// clock, not from poll count), but each poll costs a Redis command, and the free
// Upstash tier has a monthly command budget. Halving polls roughly doubles how
// long the free tier lasts.
const POLL_MS = process.env.NODE_ENV === "production" ? 2000 : 1000;

// Stop polling after this long with no mouse/keyboard/touch activity, and resume
// on the next interaction. A tab left open overnight would otherwise spend the
// free quota for nobody. (The world also just pauses: it only advances when read.)
const IDLE_MS = 10 * 60 * 1000;

type Storage = "memory" | "redis";
interface Snapshot {
  platform: Platform;
  storage: Storage;
}

export function usePlatform() {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [idle, setIdle] = useState(false); // true while polling is paused for inactivity

  // Refs hold values that must survive renders without causing one.
  const inFlight = useRef(false); // true while a poll request is pending
  const epoch = useRef(0); // bumped on every send; lets us drop stale poll replies
  const lastActivity = useRef(Date.now()); // last time the user touched the page
  // When a COMMAND is rejected (bad input, a failed import...) its message must stay on
  // screen long enough to read. Every successful poll used to wipe it about a second later,
  // which made the reason for a failure almost impossible to see. Until this moment, polls
  // leave the error alone; a connection error from polling itself is unaffected.
  const holdErrorUntil = useRef(0);
  const ERROR_HOLD_MS = 8000;

  const apply = useCallback((snap: Snapshot) => {
    setPlatform(snap.platform);
    setStorage(snap.storage);
    if (Date.now() >= holdErrorUntil.current) setError(null);
  }, []);

  const poll = useCallback(async () => {
    // Skip if the previous request has not finished (slow network) or the tab is hidden.
    if (inFlight.current || document.hidden) return;
    // Nobody has interacted for a while: stop spending the quota until they do.
    if (Date.now() - lastActivity.current > IDLE_MS) {
      setIdle(true);
      return;
    }
    inFlight.current = true;
    const startedAt = epoch.current;
    try {
      const res = await fetch("/api/sim", { cache: "no-store" });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const snap = (await res.json()) as Snapshot;
      // If a command completed while this poll was in flight, this snapshot is
      // older than what the command returned. Applying it would flicker backwards.
      if (startedAt === epoch.current) apply(snap);
    } catch (e) {
      // Keep showing the last good snapshot; just surface that we are offline.
      setError(e instanceof Error ? e.message : "Could not reach the simulator");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    poll(); // first load immediately, don't wait a second
    const id = setInterval(poll, POLL_MS);
    // When the tab becomes visible again, refresh straight away.
    const onVisible = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Any real interaction counts as "still here"; if we had paused, resume now.
    // These events are cheap (we only store a timestamp), so no throttling needed.
    const onActivity = () => {
      lastActivity.current = Date.now();
      setIdle((wasIdle) => {
        if (wasIdle) poll();
        return false;
      });
    };
    const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true });

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
    };
  }, [poll]);

  const send = useCallback(
    async (cmd: Command) => {
      epoch.current += 1; // invalidate any poll currently in flight
      try {
        const res = await fetch("/api/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cmd),
        });
        const data = (await res.json()) as Snapshot | { error: string };
        if ("error" in data) {
          holdErrorUntil.current = Date.now() + ERROR_HOLD_MS; // keep it readable (see above)
          setError(data.error);
          return;
        }
        epoch.current += 1; // and any poll that started while we waited
        holdErrorUntil.current = 0; // a command that worked clears any old error
        apply(data);
      } catch (e) {
        holdErrorUntil.current = Date.now() + ERROR_HOLD_MS;
        setError(e instanceof Error ? e.message : "Command failed");
      }
    },
    [apply],
  );

  return { platform, storage, error, loading, idle, send };
}
