import { cn } from "@/lib/utils";

export type StatTone = "default" | "good" | "warn" | "bad";

const TONE: Record<StatTone, string> = {
  default: "text-foreground",
  good: "text-[hsl(var(--success))]",
  warn: "text-[hsl(var(--warning))]",
  bad: "text-destructive",
};

interface StatProps {
  label: string;
  value: React.ReactNode;
  /** Small unit/suffix shown after the value, e.g. "ms" or "/ 8". */
  unit?: string;
  /** Colours the value. Pair it with the number itself: tone is a hint, not the signal. */
  tone?: StatTone;
  className?: string;
}

/**
 * A compact label/value tile. The value is mono + tabular-nums and the tile has a
 * min-width, so changing digits never shifts the layout around it.
 */
export function Stat({ label, value, unit, tone = "default", className }: StatProps) {
  return (
    <div className={cn("min-w-0 rounded-lg border bg-card/60 px-3 py-2.5", className)}>
      <div className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-1 flex items-baseline gap-1 font-mono text-xl font-semibold tabular-nums", TONE[tone])}>
        <span className="truncate">{value}</span>
        {unit && <span className="text-xs font-normal text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

// ---- Shared formatting + thresholds so Overview and Cluster agree on what "bad" means.

/** Utilisation can be 999 when there are no healthy instances; show that as "999+". */
export function fmtPct(n: number): string {
  return n >= 999 ? "999+" : n.toFixed(0);
}

export const utilTone = (u: number): StatTone => (u >= 90 ? "bad" : u >= 70 ? "warn" : "good");
export const errTone = (e: number): StatTone => (e >= 5 ? "bad" : e >= 0.5 ? "warn" : "good");
export const latencyTone = (ms: number): StatTone => (ms >= 500 ? "bad" : ms >= 150 ? "warn" : "good");
