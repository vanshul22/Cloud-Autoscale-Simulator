# Cloud Autoscale Simulator

A one-page, fully **simulated** cloud platform. Push traffic at a service and watch
it autoscale, load-balance, log events and heal itself. Free to run, free to host.

> Everything is simulated in TypeScript. No real requests are sent anywhere.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

No setup needed: locally the world is kept in memory.

## How it works (read in this order)

| File | What it teaches |
|------|-----------------|
| `lib/engine/types.ts` | The world model: `Platform` > `Service` > `Instance` |
| `lib/engine/tick.ts` | One simulation step. The heart of everything |
| `lib/engine/traffic.ts` | Traffic patterns (flat, spike, ramp, sine, noise) |
| `lib/engine/metrics.ts` | Utilisation, p95 latency, error rate, cost |
| `lib/engine/autoscaler.ts` | The scaling decision (**you write this**) |
| `lib/engine/nginx.ts` | Generates the `nginx.conf` for the live instances |
| `lib/engine/commands.ts` | Every action the UI can perform |
| `lib/store.ts` | Memory locally, Upstash Redis in production |
| `app/api/sim`, `app/api/control` | Poll the world / change the world |

### The key idea: tick-on-read

Vercel has no background process, so time only moves when someone polls. Each
`GET /api/sim` works out how many seconds passed since the last poll, runs that many
`tick()` steps, saves the world, and returns it.

## Deploy free

1. Create a free database at [Upstash](https://upstash.com) (Redis).
2. Push this repo to GitHub, import it in [Vercel](https://vercel.com).
3. Add env vars `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

All visitors then share one live world.
