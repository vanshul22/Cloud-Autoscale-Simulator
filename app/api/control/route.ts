// POST /api/control  —  the single door for changing the world.
// Body: a `Command` (see lib/engine/commands.ts). Returns the fresh snapshot so the
// UI updates instantly instead of waiting for the next poll.

import { NextResponse } from "next/server";
import { applyCommand, type Command } from "@/lib/engine/commands";
import { advance } from "@/lib/engine/tick";
import { getPlatform, resetPlatform, savePlatform, usingRedis } from "@/lib/store";

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

  const platform = await getPlatform();
  advance(platform); // bring the world up to "now" before applying the change
  try {
    applyCommand(platform, cmd);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invalid command" },
      { status: 400 },
    );
  }
  await savePlatform(platform);
  return NextResponse.json({ platform, storage });
}
