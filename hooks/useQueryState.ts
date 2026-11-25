"use client";

// =============================================================================
// useQueryState  —  React state that lives in the URL query string.
//
//   const [tab, setTab] = useQueryState("tab", "overview", ["overview", "cluster"]);
//
// Works like useState, but the value is stored as  ?tab=cluster  so:
//   - a page refresh keeps it           (the URL survives, React state does not)
//   - a link can be shared / bookmarked (the link IS the view)
//   - back/forward and "open in new tab" behave sensibly
//
// Design choices worth knowing:
//   * The default value is NOT written to the URL, so a clean page has a clean URL.
//   * `allowed` guards against hand-edited or stale URLs (?tab=banana): anything
//     not in the list quietly falls back to the default.
//   * We update with history.replaceState instead of router.replace. Next.js
//     (>=14.1) syncs replaceState into useSearchParams, and it avoids a server
//     round-trip for what is purely client-side view state.
//   * Each update re-reads window.location.search instead of trusting a value
//     captured at render time. Otherwise two filters changing in the same moment
//     would overwrite each other's keys.
// =============================================================================

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";

export function useQueryState<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): [T, (next: T) => void] {
  const params = useSearchParams();
  const raw = params.get(key);

  const value: T =
    raw !== null && (!allowed || (allowed as readonly string[]).includes(raw))
      ? (raw as T)
      : fallback;

  const setValue = useCallback(
    (next: T) => {
      const url = new URL(window.location.href);
      if (next === fallback) url.searchParams.delete(key);
      else url.searchParams.set(key, next);
      // The state argument MUST be null. Next.js wraps history.replaceState so
      // that useSearchParams() sees URL changes, but it deliberately skips calls
      // that carry its own internal marker (the object in window.history.state).
      // Passing that object back would change the address bar while React never
      // re-rendered: the tab would not switch. With null, Next syncs it for us.
      window.history.replaceState(null, "", url);
    },
    [key, fallback],
  );

  return [value, setValue];
}
