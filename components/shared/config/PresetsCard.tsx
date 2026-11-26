"use client";

// =============================================================================
// PresetsCard.tsx  —  Named bundles of settings you can apply in one click.
//
// A preset is just a LIST OF ORDINARY COMMANDS (see presetCommands in config.ts), so
// applying one does exactly what changing the same fields by hand would do, with the
// same server-side validation. We send them one after another, waiting for each,
// because each reply carries the new world and the next command builds on it.
// =============================================================================

import { Wand2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Command } from "@/lib/engine/commands";
import { PRESETS, presetCommands, type Preset } from "@/lib/engine/config";
import type { Service } from "@/lib/engine/types";

export function PresetsCard({ service, send }: { service: Service; send: (c: Command) => Promise<void> }) {
  // Which preset is being applied right now (null = none). Disables every button so
  // two presets can never interleave their commands.
  const [applying, setApplying] = useState<Preset["id"] | null>(null);

  async function apply(preset: Preset) {
    // A preset overwrites settings, so ask first (same pattern as the Reset button).
    if (!window.confirm(`This overwrites the settings of ${service.name}.`)) return;
    setApplying(preset.id);
    try {
      for (const cmd of presetCommands(preset.id, service.id)) {
        await send(cmd); // in order: never fire them all at once
      }
    } finally {
      setApplying(null); // always re-enable the buttons, even if a command failed
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wand2 className="h-4 w-4" aria-hidden="true" /> Presets
        </CardTitle>
        <CardDescription>
          Start from a known setup instead of tuning field by field. Each one trades something for something else.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
        {PRESETS.map((preset) => (
          <div key={preset.id} className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card/60 p-3">
            <h3 className="text-sm font-semibold">{preset.title}</h3>
            <p className="text-xs text-muted-foreground">{preset.description}</p>
            <p className="text-xs">
              <span className="font-medium">Trade-off: </span>
              <span className="text-muted-foreground">{preset.tradeoff}</span>
            </p>
            {/* mt-auto pushes the button to the card's bottom so the three line up. */}
            <Button
              size="sm"
              variant="outline"
              className="mt-auto h-auto min-h-8 w-full whitespace-normal py-1.5"
              disabled={applying !== null}
              onClick={() => void apply(preset)}
            >
              {applying === preset.id ? "Applying..." : `Apply to ${service.name}`}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
