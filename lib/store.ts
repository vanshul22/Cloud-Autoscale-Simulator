// =============================================================================
// store.ts  —  Where the world lives between requests.
//
// Two backends, chosen automatically:
//   • Upstash Redis  — used when Redis env vars are set (i.e. in prod on Vercel).
//                      Every serverless function shares ONE copy of the world, so
//                      all visitors see the same live state.
//   • In-memory map  — used when those env vars are absent (i.e. local `next
//                      dev`, which is a single long-lived process). Zero setup.
//
// Because `next dev` keeps modules alive across requests, the in-memory value
// survives between polls locally. On Vercel it would NOT survive (each invocation
// can be a fresh process), which is exactly why production needs Upstash.
//
// CONCURRENCY (the part that only matters live): with several visitors, two
// requests can read the same world, change it, and save, with the second save
// wiping out the first one's change (a "lost update"). `update()` prevents that
// with optimistic locking: every save carries the version (`rev`) it read, and
// Redis refuses the write if someone else saved in between. The loser simply
// re-reads and re-applies its change on top of the newer world.
// =============================================================================

import { Redis } from "@upstash/redis";
import { seedPlatform } from "./defaults";
import type { Platform } from "./engine/types";

const KEY = "platform:v1";

// Vercel's Upstash integration names its variables KV_REST_API_*; Upstash's own
// dashboard names them UPSTASH_REDIS_REST_*. Accept both so setup just works.
const REST_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

const redis = REST_URL && REST_TOKEN ? new Redis({ url: REST_URL, token: REST_TOKEN }) : null;

// In-memory fallback. `globalThis` so Next's dev hot-reload doesn't wipe it.
const g = globalThis as unknown as { __platform?: Platform };

export function usingRedis(): boolean {
  return redis !== null;
}

// Compare-and-set, run INSIDE Redis so the check and the write are one atomic
// step (nothing can slip in between them). ARGV[1] = the rev we read,
// ARGV[2] = the new world as JSON. Returns 1 if written, 0 if someone beat us.
// One command instead of "GET, compare, SET" also keeps us inside the free quota.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local rev = cjson.decode(cur).rev or 0
  if rev ~= tonumber(ARGV[1]) then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

/** Load the world, seeding a fresh one the first time. */
export async function getPlatform(): Promise<Platform> {
  if (redis) {
    const stored = await redis.get<Platform>(KEY);
    if (stored) return stored;
    // NX = only if still missing, so two first visitors cannot both seed.
    await redis.set(KEY, seedPlatform(), { nx: true });
    return (await redis.get<Platform>(KEY)) ?? seedPlatform();
  }
  if (!g.__platform) g.__platform = seedPlatform();
  return g.__platform;
}

/**
 * Persist the world IF nobody else saved since we read it.
 * Returns false when we lost the race (caller should re-read and retry).
 */
export async function savePlatform(p: Platform): Promise<boolean> {
  const readRev = p.rev ?? 0;
  p.rev = readRev + 1;
  if (redis) {
    const ok = await redis.eval<string[], number>(CAS_SCRIPT, [KEY], [
      String(readRev),
      JSON.stringify(p),
    ]);
    if (ok !== 1) {
      p.rev = readRev; // we did not write; undo the bump on our local copy
      return false;
    }
    return true;
  }
  g.__platform = p; // single process locally: no race to guard against
  return true;
}

/**
 * Read-modify-write with retry. `change` receives a freshly loaded world and
 * mutates it; we save it if still current, otherwise reload and run `change`
 * again. Errors thrown by `change` (e.g. invalid input) propagate and nothing
 * is saved.
 */
export async function update<T>(
  change: (p: Platform) => T,
  attempts = 4,
): Promise<{ platform: Platform; result: T }> {
  for (let i = 0; i < attempts; i++) {
    const platform = await getPlatform();
    const result = change(platform);
    if (await savePlatform(platform)) return { platform, result };
  }
  throw new Error("The simulator is busy. Please try again.");
}

/** Wipe the world back to the seed (used by a "reset" control). */
export async function resetPlatform(): Promise<Platform> {
  const seeded = seedPlatform();
  if (redis) {
    // A plain overwrite on purpose: reset must win over any in-flight save.
    await redis.set(KEY, seeded);
  } else {
    g.__platform = seeded;
  }
  return seeded;
}
