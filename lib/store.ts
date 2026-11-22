// =============================================================================
// store.ts  —  Where the world lives between requests.
//
// Two backends, chosen automatically:
//   • Upstash Redis  — used when UPSTASH_REDIS_REST_URL is set (i.e. in prod on
//                      Vercel). Every serverless function shares ONE copy of the
//                      world, so all visitors see the same live state.
//   • In-memory map  — used when those env vars are absent (i.e. local `next
//                      dev`, which is a single long-lived process). Zero setup.
//
// Because `next dev` keeps modules alive across requests, the in-memory value
// survives between polls locally. On Vercel it would NOT survive (each
// invocation is a fresh process), which is exactly why production needs Upstash.
// =============================================================================

import { Redis } from "@upstash/redis";
import { seedPlatform } from "./defaults";
import type { Platform } from "./engine/types";

const KEY = "platform:v1";

// Lazily create the Upstash client only if the env vars exist.
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

// In-memory fallback. `globalThis` so Next's dev hot-reload doesn't wipe it.
const g = globalThis as unknown as { __platform?: Platform };

export function usingRedis(): boolean {
  return redis !== null;
}

/** Load the world, seeding a fresh one the first time. */
export async function getPlatform(): Promise<Platform> {
  if (redis) {
    const stored = await redis.get<Platform>(KEY);
    if (stored) return stored;
    const seeded = seedPlatform();
    await redis.set(KEY, seeded);
    return seeded;
  }
  if (!g.__platform) g.__platform = seedPlatform();
  return g.__platform;
}

/** Persist the world. */
export async function savePlatform(p: Platform): Promise<void> {
  if (redis) {
    await redis.set(KEY, p);
    return;
  }
  g.__platform = p;
}

/** Wipe the world back to the seed (used by a "reset" control). */
export async function resetPlatform(): Promise<Platform> {
  const seeded = seedPlatform();
  await savePlatform(seeded);
  return seeded;
}
