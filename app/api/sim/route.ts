// GET /api/sim  —  the poll target.
// Loads the world, advances it by however many ticks have elapsed (tick-on-read),
// saves it, and returns the snapshot. Browsers call this every second or two.

import { NextResponse } from "next/server";
import { advance } from "@/lib/engine/tick";
import { getPlatform, update, usingRedis } from "@/lib/store";

export const dynamic = "force-dynamic"; // never cache: the world changes every second

export async function GET() {
  const storage = usingRedis() ? "redis" : "memory";

  try {
    // FAST PATH: with several viewers, most polls arrive within a second of
    // another viewer's poll that already advanced the world. Those just read:
    // one cheap Redis command, no write, no contention.
    const current = await getPlatform();
    if (Date.now() - current.lastTickAt < 1000) {
      return NextResponse.json({ platform: current, storage });
    }

    // SLOW PATH: time has passed, so advance the world and save it. `update`
    // re-reads and retries if another request saved first (see store.ts).
    const { platform } = await update((p) => advance(p));
    return NextResponse.json({ platform, storage });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Simulator unavailable" },
      { status: 503 },
    );
  }
}
