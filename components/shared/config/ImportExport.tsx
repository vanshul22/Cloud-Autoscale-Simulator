"use client";

// =============================================================================
// ImportExport.tsx  —  Save the settings to a file, or load them back from one.
//
// EXPORT builds the JSON in the browser (exportConfig is pure) and hands it to the
// browser as a download: Blob -> temporary object URL -> a hidden link we click.
//
// IMPORT is deliberately cautious. The text is parsed and previewed HERE (so you see
// what is about to happen), then sent as an ordinary `importConfig` command, which the
// SERVER validates field by field and applies all-or-nothing. The checks in this file
// are a friendly preview, never the real safety net.
// =============================================================================

import { Download, FileJson, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { Command } from "@/lib/engine/commands";
import { CONFIG_FORMAT, MAX_CONFIG_BYTES, exportConfig } from "@/lib/engine/config";
import type { Platform } from "@/lib/engine/types";

const FILE_NAME = "cloud-autoscale-config.json";

// What we learned from the pasted text. A discriminated union: each state has exactly
// the fields it needs, so the JSX below can't read a preview that does not exist.
type Parsed =
  | { state: "empty" }
  | { state: "too-big"; bytes: number }
  | { state: "invalid" }
  | {
      state: "ok";
      value: unknown;
      bytes: number;
      matching: number;
      skipped: number;
      schedules: number;
      rules: number;
      rightFormat: boolean;
    };

/** Safe "is this a plain object?" so we can read fields off untrusted JSON. */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function inspect(text: string, knownIds: Set<string>): Parsed {
  if (text.trim() === "") return { state: "empty" };
  // Count BYTES, not characters: the limit is about the size of the file on disk.
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_CONFIG_BYTES) return { state: "too-big", bytes }; // refuse before parsing a huge string
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "invalid" };
  }
  const root = isObj(value) ? value : {};
  const services = Array.isArray(root.services) ? root.services : [];
  let matching = 0;
  let schedules = 0;
  for (const s of services) {
    // Only a service whose id exists here will be applied; the rest are skipped.
    if (isObj(s) && typeof s.id === "string" && knownIds.has(s.id)) {
      matching++;
      if (Array.isArray(s.schedules)) schedules += s.schedules.length;
    }
  }
  return {
    state: "ok",
    value,
    bytes,
    matching,
    skipped: services.length - matching,
    schedules,
    rules: Array.isArray(root.alertRules) ? root.alertRules.length : 0,
    rightFormat: root.format === CONFIG_FORMAT,
  };
}

const kb = (bytes: number) => (bytes / 1024).toFixed(1);

export function ImportExport({ platform, send }: { platform: Platform; send: (c: Command) => Promise<void> }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Re-parse only when the text or the set of service ids changes (not on every poll).
  const idsKey = platform.services.map((s) => s.id).join("|");
  const parsed = useMemo(
    () => inspect(text, new Set(idsKey ? idsKey.split("|") : [])),
    [text, idsKey],
  );

  function exportFile() {
    const json = JSON.stringify(exportConfig(platform), null, 2); // 2 = readable, indented
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = FILE_NAME;
    a.click();
    URL.revokeObjectURL(url); // free the temporary URL (the download has already started)
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setSent(false);
    if (!file) return;
    setFileName(file.name);
    // Check the size BEFORE reading so a huge file never loads into memory.
    if (file.size > MAX_CONFIG_BYTES) {
      setText("");
      setFileError(`${file.name} is ${kb(file.size)} KB. The limit is ${kb(MAX_CONFIG_BYTES)} KB.`);
      return;
    }
    setFileError(null);
    setText(await file.text()); // the textarea now shows the file, so there is ONE source of truth
  }

  async function apply() {
    if (parsed.state !== "ok") return;
    if (!window.confirm("This overwrites the settings of every matching service. Continue?")) return;
    setSending(true);
    try {
      await send({ type: "importConfig", config: parsed.value });
      setSent(true);
    } finally {
      setSending(false);
    }
  }

  function clearAll() {
    setText("");
    setFileName(null);
    setFileError(null);
    setSent(false);
    if (fileRef.current) fileRef.current.value = ""; // so picking the SAME file again fires onChange
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileJson className="h-4 w-4" aria-hidden="true" /> Export and import
        </CardTitle>
        <CardDescription>Keep a setup as a file, share it, or restore it later.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Button size="sm" variant="outline" onClick={exportFile}>
            <Download aria-hidden="true" /> Export configuration
          </Button>
          <p className="text-xs text-muted-foreground">
            Saves <span className="font-mono">{FILE_NAME}</span>. It holds SETTINGS only, never running instances, queues,
            events or metrics.
          </p>
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="config-import-file">Choose a configuration file</Label>
            {/* w-full + min-w-0 stop the native file input from stretching a phone screen. */}
            <input
              id="config-import-file"
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              onChange={(e) => void onPickFile(e)}
              className="block w-full min-w-0 max-w-full rounded-md border border-input bg-transparent text-xs text-muted-foreground file:mr-3 file:border-0 file:border-r file:border-input file:bg-secondary file:px-3 file:py-2 file:text-xs file:font-medium file:text-secondary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {fileName && (
              <p className="break-all text-xs text-muted-foreground">
                File: <span className="font-mono">{fileName}</span>
              </p>
            )}
          </div>

          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="config-import-text">Or paste the JSON here</Label>
            <textarea
              id="config-import-text"
              value={text}
              rows={6}
              spellCheck={false}
              aria-describedby="config-import-status"
              onChange={(e) => {
                setText(e.target.value);
                setSent(false);
              }}
              className="block w-full min-w-0 max-w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder='{ "format": "cloud-autoscale-simulator-config", ... }'
            />
          </div>

          {/* One status area, role=status so changes are announced. min-h keeps the card
              from jumping as the message changes. */}
          <div id="config-import-status" role="status" className="min-h-[3.5rem] space-y-1 text-xs">
            {fileError && <p className="text-destructive">{fileError}</p>}
            {parsed.state === "invalid" && <p className="text-destructive">That is not valid JSON</p>}
            {parsed.state === "too-big" && (
              <p className="text-destructive">
                That text is {kb(parsed.bytes)} KB. The limit is {kb(MAX_CONFIG_BYTES)} KB, so it will not be applied.
              </p>
            )}
            {parsed.state === "ok" && (
              <>
                <p className="tabular-nums text-muted-foreground">
                  {parsed.matching} {parsed.matching === 1 ? "service" : "services"} in the file match a service here
                  {parsed.skipped > 0 && `, ${parsed.skipped} with no matching service (will be skipped)`}.{" "}
                  {parsed.schedules} {parsed.schedules === 1 ? "schedule" : "schedules"}, {parsed.rules} alert{" "}
                  {parsed.rules === 1 ? "rule" : "rules"}, {kb(parsed.bytes)} KB.
                </p>
                {!parsed.rightFormat && (
                  <p className="text-[hsl(var(--warning))]">
                    Warning: the format field is not &quot;{CONFIG_FORMAT}&quot;, so the server will probably refuse it.
                  </p>
                )}
              </>
            )}
            {sent && parsed.state === "ok" && (
              <p className="text-muted-foreground">Sent. If the file was refused, the red banner at the top says why.</p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={parsed.state !== "ok" || sending} onClick={() => void apply()}>
              <Upload aria-hidden="true" /> {sending ? "Applying..." : "Apply configuration"}
            </Button>
            <Button size="sm" variant="ghost" disabled={text === "" && !fileName} onClick={clearAll}>
              Clear
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">A bad file changes nothing: it is applied all-or-nothing.</p>
        </div>
      </CardContent>
    </Card>
  );
}
