// GET /api/sim  —  the poll target.
// Loads the world, advances it by however many ticks have elapsed (tick-on-read),
// saves it, and returns the snapshot. The browser calls this about once a second.

import { NextResponse } from "next/server";
import { advance } from "@/lib/engine/tick";
import { getPlatform, savePlatform, usingRedis } from "@/lib/store";

export const dynamic = "force-dynamic"; // never cache: the world changes every second

export async function GET() {
  const platform = await getPlatform();
  advance(platform);
  await savePlatform(platform);
  return NextResponse.json({ platform, storage: usingRedis() ? "redis" : "memory" });
}
