// POST /api/control  —  the single door for changing the world.
// Body: a `Command` (see lib/engine/commands.ts). Returns the fresh snapshot so the
// UI updates instantly instead of waiting for the next poll.

import { NextResponse } from "next/server";
import { applyCommand, type Command } from "@/lib/engine/commands";
import { advance } from "@/lib/engine/tick";
import { resetPlatform, update, usingRedis } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let cmd: Command;
  try {
    cmd = (await req.json()) as Command;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!cmd || typeof cmd.type !== "string") {
    return NextResponse.json({ error: "Missing command type" }, { status: 400 });
  }

  const storage = usingRedis() ? "redis" : "memory";

  if (cmd.type === "reset") {
    const platform = await resetPlatform();
    return NextResponse.json({ platform, storage });
  }

  try {
    // `update` loads the world, runs this change, and saves only if nobody else
    // saved meanwhile (otherwise it reloads and runs it again). So a click is
    // never lost to a concurrent poll from another visitor.
    const { platform } = await update((p) => {
      advance(p); // bring the world up to "now" before applying the change
      applyCommand(p, cmd);
    });
    return NextResponse.json({ platform, storage });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Invalid command";
    // "busy" is our retry-exhausted case (a server condition); the rest are bad input.
    const status = message.startsWith("The simulator is busy") ? 503 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
