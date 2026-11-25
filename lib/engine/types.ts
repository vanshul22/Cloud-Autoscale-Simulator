// =============================================================================
// types.ts  —  The vocabulary of the whole simulation.
//
// Everything in the app (every tab, every API route, every engine module) reads
// and writes ONE shared object: `Platform`. Think of it as the "world state".
// The engine's job is to take a Platform, advance it by one `tick`, and hand
// back a new Platform. The UI's job is to render a Platform and send commands
// that mutate it.
//
// Keeping all state in one serialisable object is what lets us store it in Redis
// and rebuild the exact same world on any serverless function invocation.
// =============================================================================

/** How traffic changes over time (the "shape" of load). */
export type Pattern = "flat" | "spike" | "ramp" | "sine" | "noise";

/** Load-balancing algorithm used to spread requests across instances. */
export type LbAlgo = "round-robin" | "least-conn" | "weighted";

/**
 * Lifecycle of a single instance (a simulated container/VM).
 *  booting     -> just created, warming up, not yet taking traffic
 *  healthy     -> serving requests normally
 *  unhealthy   -> failed a health check; LB stops sending it traffic
 *  draining    -> being removed gracefully; finishing in-flight requests
 *  restarting  -> crashed; waiting out a backoff timer before coming back
 *  crashloop   -> restarted too many times; given up on (needs manual/auto replace)
 */
export type InstanceStatus =
  | "booting"
  | "healthy"
  | "unhealthy"
  | "draining"
  | "restarting"
  | "crashloop";

/** High-level health of a whole service. */
export type ServiceStatus = "live" | "deploying" | "degraded" | "down";

/** A deployment rollout strategy (how new versions replace old ones). */
export type DeployStrategy = "recreate" | "rolling" | "blue-green" | "canary";

// -----------------------------------------------------------------------------
// Instance: one simulated server.
// -----------------------------------------------------------------------------
export interface Instance {
  id: string; // e.g. "i-a1b2"
  status: InstanceStatus;
  version: string; // which code version this instance runs (matters for deploys)

  bootTicksLeft: number; // ticks until a "booting" instance becomes "healthy"
  restartsLeft: number; // remaining restart attempts before we declare crashloop
  backoffLeft: number; // ticks left to wait while "restarting"

  rps: number; // requests/sec this instance is currently handling
  conns: number; // active connections (used by least-conn balancing)
  // Size: relative capacity. 1 = a standard instance (serves rpsPerInstance req/s),
  // 2 = a large one (twice that). Weighted and least-connections balancing use it;
  // round-robin deliberately ignores it, which is exactly its weakness.
  weight: number;
  // How much SLOWER than normal this instance answers (1 = normal, 3 = three times
  // slower). A slow instance holds each connection longer, which least-connections
  // notices and round-robin/weighted do not. The Reliability tab's "inject latency"
  // sets it. Optional: instances saved before this field existed count as 1.
  latencyFactor?: number;

  // When chaos injects a fault we remember it so the tick can act on it.
  fault?: "crash" | "oom" | "latency" | "errors";
}

// -----------------------------------------------------------------------------
// Autoscaling configuration (per service).
// -----------------------------------------------------------------------------
export interface AutoscaleConfig {
  min: number; // never go below this many instances
  max: number; // never go above this many instances
  rpsPerInstance: number; // capacity: how many RPS one healthy instance can serve
  scaleUpAt: number; // utilisation % above which we add instances (e.g. 70)
  scaleDownAt: number; // utilisation % below which we remove instances (e.g. 30)
  cooldownTicks: number; // ticks to wait after a scale action before acting again
  lb: LbAlgo;
  // false = hands off: the autoscaler never adds or removes instances, so you can
  // size the fleet yourself (add/remove buttons) and compare balancers. Optional:
  // saved worlds without it behave as true.
  enabled?: boolean;
}

// -----------------------------------------------------------------------------
// Scheduled scaling: a daily time window that overrides min/max.
// Times are "minutes since midnight" in the simulated clock (0..1439).
// -----------------------------------------------------------------------------
export interface Schedule {
  id: string;
  fromMin: number; // window start, e.g. 540 = 09:00
  toMin: number; // window end,   e.g. 1080 = 18:00
  min: number; // min instances to enforce during the window
  max: number; // max instances to allow during the window
  note: string; // human label, e.g. "business hours"
}

// -----------------------------------------------------------------------------
// Queue: requests the servers cannot handle RIGHT NOW wait here instead of failing.
//
// Life of a request when demand exceeds capacity:
//   1. overflow arrives -> if there is room it WAITS in the queue (else: rejected, 429)
//   2. when servers have spare capacity, the OLDEST waiting requests are served first
//   3. a request that waits longer than maxWaitTicks TIMES OUT
//   4. a timed-out request is RETRIED after a backoff delay, up to maxRetries times
//   5. after the last retry it lands in the DEAD-LETTER QUEUE (DLQ): failed for good
// -----------------------------------------------------------------------------

/**
 * A group of requests that entered the queue together. Tracking groups instead of
 * single requests keeps the saved world small (thousands of requests = a handful
 * of groups) while still letting us age, retry and serve them in order.
 */
export interface Cohort {
  n: number; // how many requests are in this group
  age: number; // ticks spent waiting in line since (re)entering
  attempts: number; // 0 = first try, 1 = first retry, ...
  readyAt: number; // tick when it may be served; later than "now" means backing off
}

export interface QueueState {
  cohorts: Cohort[]; // waiting groups, oldest first
  capacity: number; // max requests waiting; beyond this we reject with 429 (0 = no queue)
  maxWaitTicks: number; // a request waiting longer than this times out
  maxRetries: number; // retries after a timeout before the request goes to the DLQ
  retryBackoffTicks: number; // base delay before a retry; doubles on each attempt

  // Derived from `cohorts` every tick, kept so the UI and charts can read them directly.
  depth: number; // total requests waiting or backing off
  oldestAge: number; // longest anyone has waited, in ticks (drives added latency)

  // Lifetime counters.
  dlq: number; // requests that failed for good (the dead-letter queue)
  processed: number; // requests served after waiting in the queue
  rejected: number; // requests refused because the queue was full (HTTP 429)
  retried: number; // retry attempts started

  // What happened during the LAST tick only (the error rate is computed from these).
  servedNow: number;
  rejectedNow: number;
  failedNow: number; // moved to the DLQ this tick
}

// -----------------------------------------------------------------------------
// Health / self-healing policy (per service).
// -----------------------------------------------------------------------------
export interface HealthConfig {
  restartBackoffTicks: number; // base backoff; doubles each restart (exponential)
  maxRestarts: number; // after this many failed restarts -> crashloop
  errorRateToTrip: number; // error % that opens the circuit breaker
  circuitOpen: boolean; // when true, service sheds traffic to protect itself
}

// -----------------------------------------------------------------------------
// Rollout: present on a service only while a deployment is in progress.
// -----------------------------------------------------------------------------
export interface Rollout {
  strategy: DeployStrategy;
  fromVersion: string;
  toVersion: string;
  stepPct: number; // how much traffic/instances to shift per step (canary/rolling)
  progressPct: number; // 0..100, how far the rollout has advanced
  phase: "progressing" | "awaiting-approval" | "succeeded" | "rolled-back";
  newHealthyPct: number; // health of the new version so far (drives the gate)
}

// -----------------------------------------------------------------------------
// One point of time-series data, kept per service for the charts.
// -----------------------------------------------------------------------------
export interface Metric {
  t: number; // tick number
  rps: number;
  util: number; // utilisation %, 0..100+
  p95: number; // 95th-percentile latency in ms
  errRate: number; // error rate %, 0..100
  instances: number; // healthy instance count
  queueDepth: number;
  // Optional: points saved before the queue feature existed do not have these.
  queueServed?: number; // requests drained from the queue this tick
  queueRejected?: number; // requests refused (429) this tick
}

// -----------------------------------------------------------------------------
// Event: one line in the log. The whole point of the "event log" tab.
// -----------------------------------------------------------------------------
export interface SimEvent {
  t: number; // tick number
  service: string; // service id, or "platform" for global events
  level: "info" | "warn" | "error";
  msg: string;
  // "status" marks a service's health changing (green/yellow/red). Only these
  // become pop-up notifications; every other event is log-only, so routine
  // activity (a scale-up, an instance booting) never interrupts you.
  kind?: "status";
}

// -----------------------------------------------------------------------------
// Service: one deployed web service (the thing the Cluster tab focuses on).
// -----------------------------------------------------------------------------
export interface Service {
  id: string;
  name: string;
  domain: string; // e.g. "shop.demo.app"
  status: ServiceStatus;
  version: string; // currently-live version

  targetRps: number; // where traffic controls want RPS to go
  currentRps: number; // actual RPS right now (eases toward target each tick)
  pattern: Pattern;
  patternTick: number; // local clock for pattern math (sine/ramp need their own t)

  instances: Instance[];
  rrCursor: number; // round-robin pointer (balancer state)

  autoscale: AutoscaleConfig;
  cooldownLeft: number; // ticks remaining before the autoscaler may act again
  schedules: Schedule[];
  queue: QueueState;
  health: HealthConfig;
  deployment?: Rollout;

  // The service's traffic-light health: "ok" (green) | "warning" (yellow) |
  // "critical" (red). We remember the last value so we can notify exactly once
  // when it CHANGES. Optional because worlds saved before this field existed
  // (e.g. in Redis) lack it; tick.ts treats a missing value as "ok".
  alertLevel?: "ok" | "warning" | "critical";

  metricsHistory: Metric[]; // capped ring buffer for charts
  costPerInstanceHr: number; // $ per instance-hour, for the cost estimate
}

// -----------------------------------------------------------------------------
// Platform: the entire world. This is what we persist in Redis.
// -----------------------------------------------------------------------------
export interface Platform {
  // Version counter, bumped on every save. In production many requests share one
  // Redis copy of the world; `rev` lets a save say "only write if nobody else
  // saved since I read" (compare-and-set), so concurrent requests cannot silently
  // overwrite each other's changes. Optional: the seed world starts without one.
  rev?: number;
  tick: number; // monotonically increasing simulation step
  speed: 1 | 5 | 60; // time multiplier (fast-forward schedules/deploys)
  lastTickAt: number; // epoch ms of the last advance (for tick-on-read)
  clockMinutes: number; // simulated time-of-day, 0..1439, for schedules
  services: Service[];
  events: SimEvent[]; // global stream, newest first, capped
}

/** A read-only snapshot the API returns to the browser. Same shape today, but
 *  giving it a name means we can trim fields later without touching callers. */
export type Snapshot = Platform;
