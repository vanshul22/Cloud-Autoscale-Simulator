// =============================================================================
// queue.ts  —  What happens to requests the servers cannot handle right now.
//
// Without a queue, demand above capacity simply FAILS. With one, the overflow
// WAITS for spare capacity, which turns a short spike into a short delay instead
// of a burst of errors. But a queue is not magic, and this file shows its limits:
//   - it is finite (full => rejected, "HTTP 429 Too Many Requests"),
//   - waiting has a cost (latency grows with the time spent in line),
//   - a request can wait too long and time out,
//   - retrying timed-out work adds MORE load to a system that is already
//     overloaded (a "retry storm"), which is why retries get a growing backoff
//     delay and a hard limit, after which the request goes to the dead-letter
//     queue (DLQ) for a human to look at.
//
// A tick is treated as one second of traffic, so "rps" and "requests per tick"
// are the same number. stepQueue() runs once per tick, in tick.ts, after we know
// how many requests arrived and how many the healthy instances can serve.
// =============================================================================

import type { Cohort, QueueState } from "./types";

/** Defaults for a brand-new queue. */
export function defaultQueue(): QueueState {
  return {
    cohorts: [],
    capacity: 600, // room for ~one second of a 6x overload at 100 req/s capacity
    maxWaitTicks: 8, // a request that waited 8 ticks gives up
    maxRetries: 2, // then it gets 2 more tries before the DLQ
    retryBackoffTicks: 2, // wait 2 ticks before retry 1, 4 before retry 2
    depth: 0,
    oldestAge: 0,
    dlq: 0,
    processed: 0,
    rejected: 0,
    retried: 0,
    servedNow: 0,
    rejectedNow: 0,
    failedNow: 0,
  };
}

/**
 * Fill in anything a saved world is missing. The live site keeps its world in
 * Redis, and worlds saved before this feature existed have an older, smaller
 * queue object. Reading `cohorts` from one of those would crash the tick, so
 * every consumer passes the queue through here first.
 */
export function normalizeQueue(q: Partial<QueueState> | undefined): QueueState {
  return { ...defaultQueue(), ...(q ?? {}), cohorts: q?.cohorts ?? [] };
}

// -----------------------------------------------------------------------------
// ⭐ THE RETRY POLICY: the part of this file worth reading closely and tuning.
//
// A request just timed out. Should we try again, and how long should we wait?
//
//   delay = base * 2^attempts      0 -> 2 ticks, 1 -> 4 ticks   (exponential backoff)
//
// Why exponential? If the system is overloaded, retrying immediately just feeds
// the overload. Waiting longer each time gives it room to recover. Ideas to try:
//   - add random "jitter" so a thousand retries don't all land on the same tick
//   - a retry budget (e.g. only retry while the queue is under 50% full)
//   - never retry at all (set maxRetries to 0 and watch the DLQ fill)
// -----------------------------------------------------------------------------
export function retryDecision(
  attempts: number,
  q: Pick<QueueState, "maxRetries" | "retryBackoffTicks">,
): { retry: false } | { retry: true; delayTicks: number } {
  if (attempts >= q.maxRetries) return { retry: false }; // out of tries -> DLQ
  return { retry: true, delayTicks: q.retryBackoffTicks * 2 ** attempts };
}

const waiting = (cohorts: Cohort[]) => cohorts.reduce((sum, c) => sum + c.n, 0);

/**
 * Advance the queue by one tick. Mutates `q`.
 *
 *   demandRps   : requests that arrived this tick
 *   capacityRps : the most the healthy instances could serve in total
 *   servedRps   : what they actually served directly. This can be LESS than
 *                 min(demand, capacity): a balancer that sends too much to a small
 *                 instance overloads it while others sit idle (see balancer.ts).
 *                 Omit it and we assume a perfectly even split.
 */
export function stepQueue(
  q: QueueState,
  input: { tick: number; demandRps: number; capacityRps: number; servedRps?: number },
): void {
  const { tick } = input;
  const demand = Math.max(0, input.demandRps);
  const served = Math.min(demand, input.servedRps ?? Math.min(demand, input.capacityRps));

  // Fresh counters for "what happened this tick".
  q.servedNow = 0;
  q.rejectedNow = 0;
  q.failedNow = 0;

  // Servers handle new traffic first, up to capacity. What is left over is either
  // SPARE capacity (used to drain the queue) or OVERFLOW (needs to queue).
  const spare = Math.max(0, input.capacityRps - served);
  const overflow = Math.max(0, demand - served);

  // ---- 1. AGE everyone in line; time out the ones that waited too long -------
  const stillWaiting: Cohort[] = [];
  for (const c of q.cohorts) {
    if (c.readyAt > tick) {
      stillWaiting.push(c); // backing off before a retry: not standing in line yet
      continue;
    }
    c.age += 1;
    if (c.age <= q.maxWaitTicks) {
      stillWaiting.push(c);
      continue;
    }
    // Waited too long: this attempt failed. Retry later, or give up.
    const d = retryDecision(c.attempts, q);
    if (d.retry) {
      q.retried += c.n;
      stillWaiting.push({ n: c.n, age: 0, attempts: c.attempts + 1, readyAt: tick + d.delayTicks });
    } else {
      q.dlq += c.n;
      q.failedNow += c.n;
    }
  }
  q.cohorts = stillWaiting;

  // ---- 2. SERVE the oldest waiting requests first (FIFO) with spare capacity -
  let budget = Math.floor(spare);
  for (const c of q.cohorts) {
    if (budget <= 0) break;
    if (c.readyAt > tick) continue; // still backing off
    const take = Math.min(c.n, budget);
    c.n -= take;
    budget -= take;
    q.servedNow += take;
    q.processed += take;
  }
  q.cohorts = q.cohorts.filter((c) => c.n > 0);

  // ---- 3. ENQUEUE this tick's overflow, or REJECT what does not fit ----------
  const arrivals = Math.round(overflow);
  const room = Math.max(0, q.capacity - waiting(q.cohorts));
  const accepted = Math.min(arrivals, room);
  q.rejectedNow = arrivals - accepted; // queue full: the caller gets HTTP 429
  q.rejected += q.rejectedNow;
  if (accepted > 0) q.cohorts.push({ n: accepted, age: 0, attempts: 0, readyAt: tick });

  // ---- 4. Derived numbers for the UI -----------------------------------------
  q.depth = waiting(q.cohorts);
  q.oldestAge = q.cohorts.reduce((m, c) => (c.readyAt <= tick ? Math.max(m, c.age) : m), 0);
}
