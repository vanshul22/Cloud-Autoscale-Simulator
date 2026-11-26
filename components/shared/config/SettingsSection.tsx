"use client";

// =============================================================================
// SettingsSection.tsx  —  One block of the Config tab: heading, a plain-English
// one-liner, a "defaults / N changed" badge and a Reset button.
//
// It knows nothing about WHAT the settings are. The parent works out which fields
// differ from the built-in defaults and passes them in as short strings such as
// "min 2 -> 4". That keeps this wrapper reusable for every section.
//
// "Modified" is never shown by colour alone: the badge always carries words, and the
// exact differences are printed as text underneath.
// =============================================================================

import { RotateCcw } from "lucide-react";
import { useId } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SettingsSectionProps {
  title: string;
  /** One plain-English sentence on what this section controls. */
  description: string;
  /** Human-readable differences from the defaults, e.g. ["min 2 -> 4"]. Empty = at defaults. */
  changed: string[];
  /** Runs when Reset is clicked (the parent sends resetServiceConfig). */
  onReset: () => void;
  /** Extra reason to disable Reset, e.g. while a request is in flight. */
  busy?: boolean;
  /** Overrides the "defaults" test, for sections where "changed" is not a list of fields (schedules). */
  atDefaults?: boolean;
  /** Text for the badge when `atDefaults` is used and the section is not at defaults. */
  badgeText?: string;
  children: React.ReactNode;
}

export function SettingsSection({
  title,
  description,
  changed,
  onReset,
  busy = false,
  atDefaults,
  badgeText,
  children,
}: SettingsSectionProps) {
  // useId gives each section its own id so aria-labelledby never collides.
  const headingId = useId();
  const isDefault = atDefaults ?? changed.length === 0;
  const badge = isDefault ? "defaults" : (badgeText ?? `${changed.length} changed`);

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id={headingId} className="text-base font-semibold">
          {title}
        </h3>
        {/* The badge is text first; the outline + dot only reinforce it. A modified
            badge is filled so it stands out even in greyscale. */}
        <Badge
          variant={isDefault ? "outline" : "secondary"}
          className={cn("gap-1.5 tabular-nums", isDefault && "text-muted-foreground")}
        >
          <span
            aria-hidden="true"
            className={cn("h-1.5 w-1.5 rounded-full", isDefault ? "bg-muted-foreground/50" : "bg-[hsl(var(--warning))]")}
          />
          {badge}
        </Badge>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={busy || isDefault}
          aria-label={`Reset ${title} to defaults`}
          onClick={onReset}
        >
          <RotateCcw aria-hidden="true" /> Reset
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      {/* Exactly what differs ("min 2 -> 4"). `break-words` so a long list wraps on a phone. */}
      {!isDefault && changed.length > 0 && (
        <p className="break-words font-mono text-xs tabular-nums text-muted-foreground">Changed: {changed.join(", ")}</p>
      )}
      {children}
    </section>
  );
}
