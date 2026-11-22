"use client";

// =============================================================================
// NginxView.tsx  —  Shows the nginx.conf that the load balancer WOULD be using,
// and makes config changes visible.
//
// renderNginxConf() is a pure function of the service, so this component just
// calls it on every render. The interesting part is the "diff highlight":
// when the autoscaler adds or removes an instance, the `server` lines inside the
// upstream block change. We compare the new text to the previous text, tint
// added lines green (+) and removed lines red (-), then drop the highlights
// after a few seconds so the view settles back to a plain config.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { renderNginxConf } from "@/lib/engine/nginx";
import type { Service } from "@/lib/engine/types";

const HIGHLIGHT_MS = 4000; // how long added/removed markers stay on screen

// -----------------------------------------------------------------------------
// A tiny line diff (longest-common-subsequence). Configs are ~15-40 lines, so
// the O(n*m) table is trivially cheap and avoids pulling in a diff library.
// -----------------------------------------------------------------------------
type Kind = "same" | "add" | "del";
interface DiffLine {
  text: string;
  kind: Kind;
}

function toLines(conf: string): string[] {
  const lines = conf.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // config ends with "\n"
  return lines;
}

function diffLines(prev: string[], next: string[]): DiffLine[] {
  const n = prev.length;
  const m = next.length;
  // lcs[i][j] = length of the longest common subsequence of prev[i..] and next[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        prev[i] === next[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  // Walk the table: matching lines are "same"; otherwise step along whichever
  // side keeps the longer common subsequence (that's a deletion or an addition).
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (prev[i] === next[j]) {
      out.push({ text: next[j], kind: "same" });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ text: prev[i++], kind: "del" });
    } else {
      out.push({ text: next[j++], kind: "add" });
    }
  }
  while (i < n) out.push({ text: prev[i++], kind: "del" });
  while (j < m) out.push({ text: next[j++], kind: "add" });
  return out;
}

// What we remember between renders.
interface ViewState {
  conf: string; // the config text currently shown
  diff: DiffLine[] | null; // non-null only while highlights are visible
  reloadTick: number; // tick at which the config text last changed
}

// Styles live in a <style> tag so this file is self-contained. The tint is the
// STATIC style (so with reduced motion it simply stays until the 4s timer drops
// it); the fade animation is only added when the user hasn't asked for less motion.
const CSS = `
.nginx-add { background: rgb(16 185 129 / 0.18); }
.nginx-del { background: rgb(239 68 68 / 0.18); }
@keyframes nginx-fade-add { to { background-color: rgb(16 185 129 / 0); } }
@keyframes nginx-fade-del { to { background-color: rgb(239 68 68 / 0); } }
@media (prefers-reduced-motion: no-preference) {
  .nginx-add { animation: nginx-fade-add ${HIGHLIGHT_MS}ms ease-out forwards; }
  .nginx-del { animation: nginx-fade-del ${HIGHLIGHT_MS}ms ease-out forwards; }
}
`;

export function NginxView({ service }: { service: Service }) {
  const conf = useMemo(() => renderNginxConf(service), [service]);
  const history = service.metricsHistory;
  const latestTick = history.length ? history[history.length - 1].t : 0;

  const [view, setView] = useState<ViewState>({ conf, diff: null, reloadTick: latestTick });

  // "Adjusting state while rendering": when the config text differs from what we
  // last showed, compute the diff right now and store it. React re-renders
  // immediately, before painting, so there is no flash of un-highlighted text.
  // (The `!==` guard stops this from looping.)
  if (conf !== view.conf) {
    setView({
      conf,
      diff: diffLines(toLines(view.conf), toLines(conf)),
      reloadTick: latestTick,
    });
  }

  // After a few seconds, drop the highlights (and the removed lines with them).
  // Depending on `view.diff` restarts the timer if the config changes again, and
  // the cleanup cancels a pending timer on change or unmount.
  useEffect(() => {
    if (!view.diff) return;
    const id = setTimeout(() => setView((v) => ({ ...v, diff: null })), HIGHLIGHT_MS);
    return () => clearTimeout(id);
  }, [view.diff]);

  // Plain view = every line "same"; highlighted view = the merged diff.
  const lines: DiffLine[] = view.diff ?? toLines(view.conf).map((text) => ({ text, kind: "same" }));

  // Upstream count: the indented `server <ip>:port` lines (not `server {` or `server_name`).
  const upstreams = (view.conf.match(/^ {4}server \d/gm) ?? []).length;

  return (
    <Card>
      <style>{CSS}</style>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="font-mono text-base">nginx.conf</CardTitle>
        <Badge variant="secondary">
          {upstreams} upstream{upstreams === 1 ? "" : "s"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* overflow-x-auto here (not on the page): long lines scroll inside the
            block. `min-w-0` lets this flex/grid child shrink below its content. */}
        <div className="min-w-0 overflow-x-auto rounded-md border bg-muted/40">
          <pre className="w-max min-w-full py-2 font-mono text-xs leading-5">
            {lines.map((l, idx) => (
              // Index keys are fine: lines have no identity, and the whole list
              // is replaced when the diff appears or is dropped.
              <div
                key={idx}
                className={`flex select-text whitespace-pre px-3 ${
                  l.kind === "add" ? "nginx-add" : l.kind === "del" ? "nginx-del" : ""
                }`}
              >
                {/* Gutter marker: +/- (plus an sr-only word) so the change isn't
                    conveyed by background colour alone. A plain space keeps
                    unchanged lines aligned. */}
                <span
                  aria-hidden
                  className={`mr-2 w-3 shrink-0 select-none text-center font-bold ${
                    l.kind === "add"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : l.kind === "del"
                        ? "text-red-600 dark:text-red-400"
                        : ""
                  }`}
                >
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                </span>
                {l.kind !== "same" && (
                  <span className="sr-only">{l.kind === "add" ? "added: " : "removed: "}</span>
                )}
                <span className={l.kind === "del" ? "line-through decoration-red-500/60" : ""}>
                  {l.text || " "}
                </span>
              </div>
            ))}
          </pre>
        </div>
        <p className="text-xs text-muted-foreground">
          last reload: tick <span className="font-mono tabular-nums">{view.reloadTick}</span>
        </p>
      </CardContent>
    </Card>
  );
}
