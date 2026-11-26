# Cloud Autoscale Simulator

**Push traffic at a web service and watch a cloud platform react: instances boot and join an
nginx upstream, errors spike and clear, and health alerts fire in red, yellow and green.**

A one-page, fully simulated autoscaling playground. Nothing real is started or sent
anywhere. It's built to be understood: every rule (the autoscaler, the traffic patterns,
the alert thresholds) lives in a small, commented TypeScript file.

**Live demo: https://cloud-autoscale-simulator.vercel.app**
(one shared world: everyone who opens it sees, and can change, the same simulation)

![The Autoscaling Cluster tab after a spike to 400 req/s: the fleet grew to 12 instances, errors cleared, and nginx.conf lists every instance](docs/images/cluster.png)

## What you can do

- **Control traffic**: slider, ±10/±100 buttons, Stop, and patterns: flat, spike, ramp,
  day/night wave, noise.
- **Watch it autoscale**: instances boot, join the pool, and drain when load drops, with
  utilisation, p95 latency, error rate and cost updating live.
- **Compare load balancers**: add large instances by hand, switch autoscaling off, and see
  round-robin overload the small ones while weighted and least-connections even things out.
- **See the nginx.conf** generated from the healthy instances, with added and removed
  `server` lines highlighted as they change.
- **Get notified like a real on-call**: one pop-up per health change (🟢 healthy, 🟡 under
  strain, 🔴 users see errors) with a distinct sound for each. Routine events stay in the
  event log.
- **Overload it and watch the queue**: demand the servers can't handle waits in a queue, times
  out, retries with backoff, and ends up in a dead-letter queue (or is rejected with HTTP 429
  when the queue is full). You can replay or purge the dead letters.
- **Break things on purpose**: crash, OOM-kill, slow down or corrupt an instance (or kill half
  the fleet) and watch the platform notice, pull it from nginx, restart it with a doubling
  backoff, give up on a crash loop, and trip a circuit breaker.
- **Schedule capacity ahead of time**: set busy-hours windows (with optional pre-warm) and watch a
  whole simulated day, planned limits against actual instances, in about 24 seconds at 60x.
- **Ship a new version four ways**: recreate, rolling, blue-green or canary, with a health gate and
  rollback. Deploy a deliberately sneaky bug (it passes health checks but fails real requests)
  and see that only the canary catches it. Go live with new services.
- **Fast-forward time** (1x / 5x / 60x) and **share a link** to the exact view: the tab,
  service and log filter live in the URL.
- **Read the docs in the app**: one short page per tab at `/docs`.

| Overview | Docs |
|---|---|
| ![Overview tab](docs/images/overview.png) | ![Docs page](docs/images/docs.png) |

The **Queue & Workers** tab under a sustained overload (fleet capped at 2 instances, 160 req/s
against 100 capacity): the queue is full, requests are being rejected, and timed-out requests
are retrying and landing in the dead-letter queue.

![Queue & Workers tab during a sustained overload](docs/images/queue.png)

The **Reliability** tab the moment an instance crashes: it still shows as healthy ("dead,
health check 0/2 failed") because nothing is detected instantly. Health checks then pull it
out of nginx and restart it with a doubling backoff.

![Reliability tab: fleet health with chaos buttons, circuit breaker and settings](docs/images/reliability.png)

The **Scheduled Scaling** tab after one simulated day: the dashed and dotted lines are the
planned instance limits (stepping up when the business-day window pre-warms at 06:50 and opens
at 07:00), the solid line is the actual fleet following the clock-driven traffic curve below.

![Scheduled Scaling tab: 24-hour planned limits against actual instances, and traffic](docs/images/scheduled.png)

The **Deployments** tab after two rollouts: a healthy build shipped with a rolling deployment, then a
"sneaky bug" (passes health checks, fails 30% of real requests) that only the canary caught and
rolled back at 10% of traffic. Rolling, blue-green and recreate would all have shipped it to everyone.

![Deployments tab: four strategies, deploy history and the go-live form](docs/images/deployments.png)

## Try it in 30 seconds

1. Open the **Autoscaling Cluster** tab and press **Spike** (or set traffic to 400 req/s).
2. Utilisation jumps past 100% and errors appear: you get a 🔴 alert.
3. New instances boot, join `nginx.conf`, errors fall to 0%, and the alert turns 🟢.
4. Press **Stop traffic** and watch the extra instances drain one at a time.

## Status

| Area | State |
|---|---|
| Overview, Autoscaling Cluster, Queue & Workers, Reliability, Scheduled Scaling and Deployments tabs | Built |
| Deployments: recreate, rolling, blue-green and canary with a health gate, auto/manual rollback, deliberately bad releases, revert, and creating new services ("go live") | Built |
| Scheduled scaling: daily windows (incl. across midnight), pre-warm, priority order, 24-hour planned-vs-actual chart, clock-following traffic curve | Built |
| Chaos and self-healing: crash/OOM/slow/error faults, health checks, restart with backoff, crash loops, circuit breaker | Built |
| Autoscaler, traffic patterns, health status, notifications, docs | Built |
| Request queue: overflow waits, timeouts, retries with backoff, dead-letter queue, HTTP 429 | Built |
| Shared live state (Upstash Redis) and safe concurrent updates | Built |
| Load balancer: round-robin, weighted and least-connections, with instance sizes, slow instances, and manual add/remove | Built |
| Events & Alerts, Config tabs | Planned (shown as "soon" in the UI) |

## How it works

```mermaid
flowchart LR
  B[Browser] -- "poll every 2s" --> API["/api/sim"]
  B -- "click: Command" --> CTL["/api/control"]
  API --> S[("Upstash Redis<br/>one Platform object")]
  CTL --> S
  API --> T["tick(): traffic, boot, distribute,<br/>measure, autoscale, health, record"]
  CTL --> T
```

- **Tick-on-read.** Vercel has no background process, so time only moves when someone reads
  the world. Each poll works out how many seconds passed since the last one, runs that many
  `tick()` steps, and saves. One tick is one simulated minute.
- **One health status per service.** `ok`, `warning` or `critical`, with hysteresis (a
  different bar to enter a state than to leave it) so a metric hovering at a threshold
  can't flicker. A notification is written only when the status *changes*.
- **Autoscaler policy** ([`lib/engine/autoscaler.ts`](lib/engine/autoscaler.ts)). Above the
  scale-up threshold it adds enough instances to return to the middle of the band (at least
  +1, at most double). Below the scale-down threshold it removes one at a time, and only if
  the rest wouldn't be overloaded. A cooldown follows every action; min and max always apply.
- **No lost updates.** Many visitors share one Redis copy of the world. Saves are
  compare-and-set on a version number (a Lua script run atomically inside Redis), so a
  concurrent poll can never overwrite someone's click.
- **Free-tier friendly.** Polling is every 2s in production and pauses after 10 minutes
  without interaction; most polls are a single read.

## Tech stack

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS · shadcn/ui · Recharts ·
Sonner (toasts) · Upstash Redis · Vercel

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
```

No setup needed: locally the world is kept in memory. (Restarting the server resets it.)

## Deploy your own (free)

1. **Database.** Create a free Redis database at [console.upstash.com](https://console.upstash.com/redis).
   On its page, copy the **REST** URL and token (not the `redis://` string).
2. **Hosting.** Import this repo at [vercel.com/new](https://vercel.com/new) and add two
   environment variables (see [`.env.example`](.env.example)):

   | Name | Value |
   |---|---|
   | `UPSTASH_REDIS_REST_URL` | the REST URL |
   | `UPSTASH_REDIS_REST_TOKEN` | the REST token |

   Vercel's own Upstash integration names them `KV_REST_API_URL` / `KV_REST_API_TOKEN`;
   the app accepts either pair.
3. **Match the regions.** [`vercel.json`](vercel.json) pins the functions to Mumbai (`bom1`),
   next to the author's Upstash database. Change `regions` to the Vercel region nearest
   *your* database before deploying, or every request will cross an ocean to reach Redis
   (the default region is Washington DC, `iad1`).
4. **Check.** The header pill should read `storage: redis`. If it says `memory`, the
   variables didn't reach the deployment.

## Project structure

```
app/
  api/sim            GET: advance the world and return it (the poll target)
  api/control        POST: apply one validated Command
  docs/              the in-app documentation routes
components/
  tabs/              Overview, Cluster, Queue, Reliability, Scheduled, Deployments
  shared/            traffic controls, charts, instance table, event log, nginx view, config
  ui/                shadcn/ui primitives
hooks/               polling, URL-backed state, toasts, sound
lib/
  engine/            types, tick, autoscaler, balancer, queue, healing, scheduler, deploy, traffic, metrics, nginx, commands
  store.ts           memory locally, Upstash in production (compare-and-set saves)
  docs.ts            the content of the in-app docs
```

If you want to read the code, start with [`lib/engine/types.ts`](lib/engine/types.ts), then
[`tick.ts`](lib/engine/tick.ts), then [`autoscaler.ts`](lib/engine/autoscaler.ts).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build and server |
| `npm run lint` | ESLint |

## Good to know

- **Everything is simulated.** The "instances", "nginx" and "traffic" are numbers in a
  TypeScript model. The app never sends real requests to any site.
- **The demo is public and has no logins.** Anyone with the link can change traffic or
  press Reset.
- **Free tiers have limits.** Check the current Upstash and Vercel free-plan quotas. The app
  is built to use few requests (see "How it works"), but a busy public link can still
  exceed a free quota.
