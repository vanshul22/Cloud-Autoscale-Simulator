import { cn } from "@/lib/utils";
import type { ServiceStatus } from "@/lib/engine/types";

// One entry per status: a text label (never colour alone), a dot colour and a
// soft tinted background. Colours come from the --success/--warning/... tokens.
const STYLES: Record<ServiceStatus, { label: string; dot: string; chip: string; pulse: boolean }> = {
  live: {
    label: "Live",
    dot: "bg-[hsl(var(--success))]",
    chip: "text-[hsl(var(--success))] bg-[hsl(var(--success)/0.12)] border-[hsl(var(--success)/0.3)]",
    pulse: true,
  },
  deploying: {
    label: "Deploying",
    dot: "bg-[hsl(var(--info))]",
    chip: "text-[hsl(var(--info))] bg-[hsl(var(--info)/0.12)] border-[hsl(var(--info)/0.3)]",
    pulse: true,
  },
  degraded: {
    label: "Degraded",
    dot: "bg-[hsl(var(--warning))]",
    chip: "text-[hsl(var(--warning))] bg-[hsl(var(--warning)/0.12)] border-[hsl(var(--warning)/0.3)]",
    pulse: false,
  },
  down: {
    label: "Down",
    dot: "bg-destructive",
    chip: "text-destructive bg-destructive/10 border-destructive/30",
    pulse: false,
  },
};

export function StatusBadge({ status, className }: { status: ServiceStatus; className?: string }) {
  const s = STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        s.chip,
        className,
      )}
    >
      <span className="relative flex h-2 w-2" aria-hidden="true">
        {/* motion-safe: the ping ring only animates when the user allows motion */}
        {s.pulse && (
          <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping", s.dot)} />
        )}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", s.dot)} />
      </span>
      {s.label}
    </span>
  );
}
