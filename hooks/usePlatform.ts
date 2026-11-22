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

const POLL_MS = 1000;

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

  // Refs hold values that must survive renders without causing one.
  const inFlight = useRef(false); // true while a poll request is pending
  const epoch = useRef(0); // bumped on every send; lets us drop stale poll replies

  const apply = useCallback((snap: Snapshot) => {
    setPlatform(snap.platform);
    setStorage(snap.storage);
    setError(null);
  }, []);

  const poll = useCallback(async () => {
    // Skip if the previous request has not finished (slow network) or the tab is hidden.
    if (inFlight.current || document.hidden) return;
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
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
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
          setError(data.error);
          return;
        }
        epoch.current += 1; // and any poll that started while we waited
        apply(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Command failed");
      }
    },
    [apply],
  );

  return { platform, storage, error, loading, send };
}
