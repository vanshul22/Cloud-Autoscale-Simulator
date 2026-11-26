// =============================================================================
// docs.ts  —  The in-app documentation, one short page per tab.
//
// Rule for every page: someone who reads it for 30 seconds should understand what
// the tab is for, what to click, and what the numbers mean. So each page is:
//   tagline  -> one sentence
//   tryIt    -> 3 steps you can do right now
//   sections -> short bullet lists
//   files    -> where the code lives (for the curious)
//
// The content is plain data (not markdown) so there is no extra dependency, and
// the pages render as static HTML at build time. To document a new tab, add an
// entry here; the /docs routes pick it up automatically.
//
// Only tabs that are actually built are documented. Planned tabs get their page
// when they exist, so these docs never describe something you cannot click.
// =============================================================================

export interface DocSection {
  heading: string;
  items: string[];
}

export interface TabDoc {
  slug: string; // URL: /docs/<slug>. Matches the tab's ?tab= value.
  title: string;
  tagline: string;
  tryIt: string[];
  sections: DocSection[];
  files: { path: string; what: string }[];
}

export const DOCS: TabDoc[] = [
  {
    slug: "overview",
    title: "Overview",
    tagline: "Every service on the platform, its health and its cost, on one screen.",
    tryIt: [
      "Look at the three totals at the top: traffic, instances, and spend per hour.",
      "Find the service card. Its status badge says live, deploying, degraded or down.",
      "Click the card to open that service in the Autoscaling Cluster tab.",
    ],
    sections: [
      {
        heading: "What you see",
        items: [
          "Totals for the whole platform: traffic (req/s), instances running, spend ($/hour).",
          "One card per service: status, traffic, healthy/total instances, utilisation, p95 latency, error rate and cost.",
          "Numbers turn amber, then red, as a service gets into trouble. The status badge always has a text label too.",
        ],
      },
      {
        heading: "Header controls (on every tab)",
        items: [
          "sim clock and tick: simulated time. One tick is one simulated minute.",
          "1x / 5x / 60x: how fast time runs. Use 60x to watch a whole day in seconds.",
          "Sound on/off: alert sounds. Browsers need one click on the page before they allow sound.",
          "Reset: wipes the world back to its starting state.",
        ],
      },
      {
        heading: "Notifications",
        items: [
          "One pop-up each time a service's health changes: red = users are seeing errors, yellow = under strain, green = healthy again.",
          "Each service has one pop-up slot, so a new status replaces the old one instead of piling up.",
        ],
      },
      {
        heading: "Words you will see",
        items: [
          "Utilisation: traffic divided by capacity. 100% means the instances are full.",
          "p95 latency: 95% of requests are faster than this number.",
        ],
      },
    ],
    files: [
      { path: "components/tabs/Overview.tsx", what: "this tab" },
      { path: "hooks/usePlatform.ts", what: "polls the server once a second" },
      { path: "lib/engine/tick.ts", what: "advances the simulation one step" },
    ],
  },
  {
    slug: "cluster",
    title: "Autoscaling Cluster",
    tagline: "Push traffic at one service and watch it add and remove servers by itself.",
    tryIt: [
      "Press Spike (or set traffic to 400 req/s). Utilisation jumps and errors appear.",
      "Watch new instances boot, join the nginx.conf, and bring errors back to 0%.",
      "Press Stop traffic. The extra instances are removed one at a time.",
      "Compare balancers: turn Autoscaling off, add one large instance, set traffic near 160 req/s, then switch Round-robin and Weighted.",
    ],
    sections: [
      {
        heading: "Traffic controls",
        items: [
          "Slider, +/- buttons and Stop set the base load in requests per second.",
          "Patterns: Flat = steady. Spike = 5x burst for 30 ticks. Ramp = steady climb. Day/night = smooth wave. Noise = random jitter.",
        ],
      },
      {
        heading: "Instances and nginx.conf",
        items: [
          "Each instance is a simulated server: booting (3 ticks), then healthy, then draining and removed. The bar shows how full it is.",
          "nginx.conf is generated from the healthy instances. Green + lines were just added, red - lines were just removed.",
        ],
      },
      {
        heading: "How autoscaling decides",
        items: [
          "Utilisation above the scale-up % (default 70): add enough instances to get back to the middle of the band, at most double.",
          "Utilisation below the scale-down % (default 30): remove one instance, but only if the rest would not be overloaded.",
          "Between the two: do nothing. This gap stops it adding and removing in a loop.",
          "After each change it waits (cooldown) so new instances can start taking load. Always stays within min and max.",
        ],
      },
      {
        heading: "Charts, log and config",
        items: [
          "Charts: traffic vs capacity, utilisation with the scale lines, p95 latency, instances and error rate.",
          "Event log: filter by level. The filter is saved in the page address (?level=error), so a refresh keeps it.",
          "Config: min and max instances, capacity per instance, thresholds, cooldown and load balancer.",
        ],
      },
      {
        heading: "Notifications",
        items: [
          "Red when error rate is above 5% (requests refused because the queue is full, or that gave up after retries). Yellow when p95 is above 500 ms or utilisation is above the scale-up line. Green when calm again.",
          "Scale-ups and instance changes go to the event log only, never to a pop-up.",
        ],
      },
      {
        heading: "Load balancer and instance sizes",
        items: [
          "Add standard or large (2x capacity) instances by hand, and remove any instance with its Remove button. Switch Autoscaling off in the config to keep the fleet exactly as you set it.",
          "Round-robin deals requests out equally: it ignores size and speed, so small instances get overloaded while a large one idles.",
          "Weighted splits traffic by size: a 2x instance gets twice as much. Least-conn sends traffic where the fewest connections are open per unit of size, so it also steers away from a slow instance.",
          "With identical instances all three behave the same. Mix sizes and compare the Utilisation bars and the p95 latency.",
        ],
      },
    ],
    files: [
      { path: "components/tabs/Cluster.tsx", what: "this tab's layout" },
      { path: "lib/engine/balancer.ts", what: "how traffic is split across instances" },
      { path: "lib/engine/autoscaler.ts", what: "the scaling decision" },
      { path: "lib/engine/tick.ts", what: "one simulation step, and the health status" },
      { path: "lib/engine/traffic.ts", what: "the traffic patterns" },
      { path: "lib/engine/metrics.ts", what: "utilisation, latency, errors, cost" },
      { path: "lib/engine/nginx.ts", what: "generates nginx.conf" },
    ],
  },
  {
    slug: "queue",
    title: "Queue & Workers",
    tagline: "What happens to requests the servers can't handle yet: they wait in line, retry, or fail.",
    tryIt: [
      "In the Cluster tab's config, set Max instances to 2. Then set traffic to 160 req/s (capacity is only 100).",
      "Watch the queue fill, then requests start timing out, retrying and landing in the dead-letter queue.",
      "Set Queue capacity to 0 and repeat: the same overload now fails at once, with no waiting.",
    ],
    sections: [
      {
        heading: "The life of a request",
        items: [
          "Servers handle traffic up to their capacity. Anything above that is overflow, and it waits in the queue.",
          "When servers have spare capacity, the oldest waiting requests are served first. Workers here are the instances: they drain the queue with whatever capacity is left over.",
          "A request that waits longer than Max wait times out. It is retried after a delay that doubles each time (2 ticks, then 4), up to Max retries.",
          "After the last retry it goes to the dead-letter queue (DLQ): failed for good, kept so someone can look at it.",
          "If the queue is full, new overflow is rejected right away with HTTP 429 (Too Many Requests).",
        ],
      },
      {
        heading: "What you see",
        items: [
          "The flow diagram shows live numbers at every step. Boxes are labelled, never colour alone.",
          "Charts: queue depth against the capacity line, and per second how many were served from the queue vs rejected.",
          "Inside the queue: the waiting groups, how long each has waited, and whether it is a first try or a retry.",
        ],
      },
      {
        heading: "Settings and the dead-letter queue",
        items: [
          "Capacity: how many requests may wait (0 means no queue). Bigger absorbs longer spikes but makes waits longer.",
          "Max wait, Max retries, Retry backoff: how patient the system is, and how hard it hammers an overloaded service.",
          "Replay all puts dead-lettered requests back in line (only as many as fit). Purge discards them.",
        ],
      },
      {
        heading: "Why it matters",
        items: [
          "A queue turns a short spike into a short delay instead of errors. The price is latency: p95 includes the time spent waiting.",
          "It cannot fix a lasting shortage. If demand stays above capacity, nothing ever drains and the queue just fills and then rejects.",
          "Retries add load to a system that is already struggling. Backoff and a retry limit are what stop a retry storm.",
        ],
      },
      {
        heading: "Known limit",
        items: [
          "This models one waiting line in front of the servers. There are no separate background workers or job types yet.",
        ],
      },
    ],
    files: [
      { path: "components/tabs/Queue.tsx", what: "this tab" },
      { path: "lib/engine/queue.ts", what: "the queue, timeouts, retries and dead-letter queue" },
      { path: "lib/engine/tick.ts", what: "runs the queue each tick" },
    ],
  },
  {
    slug: "reliability",
    title: "Reliability",
    tagline: "Break things on purpose and watch the platform detect, remove, restart and recover.",
    tryIt: [
      "Press Kill a random instance. Watch the timeline: a burst of errors, then the instance is pulled from nginx and restarted.",
      "Inject Slow x3 on one instance, then Slow x10 on another. The x3 one stays in rotation; the x10 one fails its readiness check and is removed.",
      "Set Max restarts to 1 and keep crashing the same instance until it is declared crash-looping.",
    ],
    sections: [
      {
        heading: "How a failure plays out",
        items: [
          "Nothing is detected instantly. For a couple of ticks nginx still sends traffic to the dead instance, and those requests fail. That is the error burst you see.",
          "Health checks then fail several times in a row and the instance is pulled out of the nginx upstream.",
          "A dead instance (crash, OOM) fails its liveness check, so it is restarted. The wait before each restart doubles (2, 4, 8 ticks...), so a broken instance cannot restart in a tight loop.",
          "A slow or erroring instance fails its readiness check instead: it is taken out of rotation but not restarted, and is re-checked every tick. It rejoins once it passes.",
          "After Max restarts it is declared crash-looping and left out. If capacity is short, the autoscaler adds a replacement.",
        ],
      },
      {
        heading: "Circuit breaker",
        items: [
          "If the failure rate stays above the trip level for 3 ticks, the breaker opens: requests are refused instantly instead of piling onto struggling instances.",
          "After a pause it goes half-open and lets 20% of traffic through. If that goes well it closes; if not, it opens again.",
          "A breaker cannot fix a capacity shortage. If overload persists, it keeps tripping.",
        ],
      },
      {
        heading: "Settings",
        items: [
          "Failed checks before removal: how patient health checks are. Lower reacts faster but risks removing a healthy instance on a blip.",
          "Restart backoff and Max restarts: how quickly and how many times to retry a broken instance.",
          "Slow x that fails readiness: how many times slower than normal an instance may be before it is taken out of rotation.",
        ],
      },
      {
        heading: "Known limit",
        items: [
          "Faults are injected by hand. There is no random background failure, and slow or erroring faults end by themselves after the fault duration.",
        ],
      },
    ],
    files: [
      { path: "components/tabs/Reliability.tsx", what: "this tab" },
      { path: "lib/engine/healing.ts", what: "health checks, restarts, crash loops, circuit breaker" },
      { path: "lib/engine/tick.ts", what: "runs the health step each tick" },
    ],
  },
  {
    slug: "scheduled",
    title: "Scheduled Scaling",
    tagline: "Tell the platform about predictable busy hours so capacity is ready before the traffic is.",
    tryIt: [
      "Click Use the daily traffic curve, then add the Business day and Night presets.",
      "Set the speed to 60x in the header and watch the instances follow the schedule through a whole simulated day (about 24 seconds).",
      "Add the Flash sale preset, jump the clock to 11:55, and press Spike in the Cluster tab at 12:00. Compare with no schedule.",
    ],
    sections: [
      {
        heading: "What a schedule does",
        items: [
          "A window changes the autoscaler's minimum and maximum instance limits for certain hours. The reactive autoscaler keeps working inside those limits.",
          "Raising the minimum means capacity is already running when the rush arrives, instead of being added after the slowdown starts.",
          "Pre-warm starts a window early, so new instances (about 3 ticks to boot) are ready the moment it opens. It helps when a rush is faster than that boot time.",
          "Windows can cross midnight (23:00 to 07:00).",
        ],
      },
      {
        heading: "Overlapping windows",
        items: [
          "If two windows cover the same minute, the first one in the list wins. Use the arrows to change priority: put a specific window (lunch rush) above a broad one (business day).",
        ],
      },
      {
        heading: "Reading the 24-hour chart",
        items: [
          "Dashed lines are the planned minimum and maximum limits; the solid line is how many healthy instances there actually were at that minute.",
          "Shaded bands are the schedule windows (lighter = pre-warm). The vertical line is the simulated clock now. The day fills in as the clock moves.",
          "One tick is one simulated minute: a day takes 24 real minutes at 1x, or about 24 seconds at 60x.",
        ],
      },
      {
        heading: "What the numbers showed",
        items: [
          "In a predictable 5x flash sale at 12:00, reactive autoscaling alone gave a worst-case p95 of about 5.3 seconds (the queue absorbed the burst); a schedule with capacity ready gave about 0.4 seconds.",
          "Over a smooth full day the saving is small, because the reactive autoscaler keeps up on its own. Schedules matter most for sudden, predictable rushes.",
        ],
      },
      {
        heading: "Careful",
        items: [
          "A limit that is too tight hurts. A night window that starts while the evening peak is still running leaves too few instances and slows everything down.",
          "Schedules only set limits. If Autoscaling is switched off in the Cluster config, they do nothing.",
        ],
      },
    ],
    files: [
      { path: "components/tabs/Scheduled.tsx", what: "this tab" },
      { path: "lib/engine/scheduler.ts", what: "window maths, overlap rule, next change" },
      { path: "lib/engine/tick.ts", what: "applies the limits and records the day" },
    ],
  },
  {
    slug: "deployments",
    title: "Deployments",
    tagline: "Ship a new version four different ways, and see which one actually protects your users.",
    tryIt: [
      "Deploy a Healthy build with Rolling, then with Blue-green. Watch the fleet strip change from v1 to v2, and watch the cost.",
      "Deploy a Sneaky bug with Rolling. It passes every health check and ships to everyone. Revert, then try Canary and watch it get caught at 10%.",
      "Pick Recreate and note the downtime while the new instances boot.",
    ],
    sections: [
      {
        heading: "The four strategies",
        items: [
          "Recreate: stop everything, start the new version. Simplest and cheapest, but the service is down while it boots.",
          "Rolling: replace a batch at a time, retiring old instances only after the new ones are ready. No downtime, and a broken build is caught on the first batch.",
          "Blue-green: start a full second fleet idle, then switch all traffic at once. Instant cutover, but you pay for two fleets while it runs.",
          "Canary: send 10%, then 50%, then 100% of real traffic to the new version while watching its error rate. Smallest blast radius, and the slowest.",
        ],
      },
      {
        heading: "Health gate and rollback",
        items: [
          "A new instance only counts once it is ready: running and passing its health checks for a few ticks in a row. If the new instances are not ready before the deadline, the gate fails.",
          "A failed gate rolls back automatically (if that is switched on): the new instances are removed and the old version is brought back to full strength. You can also roll back or promote by hand.",
          "The autoscaler pauses during a rollout so it does not fight the changes.",
        ],
      },
      {
        heading: "What the experiments showed",
        items: [
          "A healthy release: Recreate had about 2 ticks of downtime; Rolling had none but took the longest of the three fast options; Blue-green switched instantly but ran 8 instances instead of 4 for a while; Canary was slowest but safest.",
          "A sneaky bug (passes health checks, fails 30% of real requests): Recreate, Rolling and Blue-green all shipped it to everyone, with 18%, 14% and 6% of requests failing during the rollout and 30% afterwards. Canary caught it at 10% traffic, lost about 0.5% of requests, and rolled back.",
          "Slow or crashing builds fail their health checks, so Rolling, Blue-green and Canary all reject them. Recreate has nothing left to fall back on.",
          "The lesson: health checks prove a build starts. Only watching real traffic proves it works.",
        ],
      },
      {
        heading: "Go live with a new service",
        items: [
          "Create a service with a name, a domain and a starting number of instances. It provisions, boots, and goes live; you get a notification when it does.",
          "A new service has no traffic yet. Select it in the Cluster tab and set its traffic. You can run up to 4 services, and shut one down with its button.",
        ],
      },
      {
        heading: "Known limits",
        items: [
          "Build quality (healthy, sneaky bug, slow, crashing) is simulated and chosen by you when you deploy.",
          "Blue-green retires the old fleet at cutover, so there is no standing rollback window. Use Revert to go back to the previous version.",
        ],
      },
    ],
    files: [
      { path: "components/tabs/Deployments.tsx", what: "this tab" },
      { path: "lib/engine/deploy.ts", what: "the four strategies, the health gate, rollback" },
      { path: "lib/engine/tick.ts", what: "runs the rollout each tick and routes canary traffic" },
    ],
  },
  {
    slug: "events",
    title: "Events & Alerts",
    tagline: "Decide when a human should be told, and measure whether you are keeping your promise to users.",
    tryIt: [
      "In the Cluster config set Max instances to 2, then push traffic to 160 req/s. Watch Slow responses and Capacity nearly full go pending, then firing, then High error rate. Acknowledge one.",
      "Set Capacity nearly full to 'for 1 tick' and it fires at once; set it back to 5 and it takes longer. That is the 'for' clause.",
      "Raise the SLO target to 99.9 and watch the error budget shrink.",
    ],
    sections: [
      {
        heading: "Alert rules",
        items: [
          "A rule watches one number (p95 latency, error rate, utilisation, queue depth, healthy instances, crash-looping instances or error-budget burn rate), compares it with a threshold, and has a severity.",
          "A rule must hold for its 'for' time before it fires. Until then the alert is pending. This is why one unlucky slow tick never pages anyone.",
          "When the condition clears, the alert resolves and moves to the history. Each change of state writes one event.",
          "Acknowledge a firing alert to say 'I'm on it'. It keeps firing, but it is marked as seen.",
          "Rules can apply to every service or just one. Six sensible rules are built in, and you can edit, add or remove them.",
        ],
      },
      {
        heading: "SLO and error budget",
        items: [
          "An SLO is a promise such as '99.5% of requests succeed'. The error budget is the failures you can afford: 0.5% of requests.",
          "Availability is measured over the last 600 ticks. The budget bar shows how much of the allowed failures is left.",
          "Burn rate is how fast the budget is being spent. 1x is exactly on budget; at 3x it runs out three times too soon. The page also estimates how many ticks are left at the current rate.",
          "Alerting on burn rate means you act when users are being hurt faster than you can afford, not on every blip.",
        ],
      },
      {
        heading: "The event stream",
        items: [
          "Every event the platform writes is here: scaling, health checks, deployments, alerts, schedule windows. The log keeps the latest 120.",
          "Filter by service, level, category or text. The filters are kept in the page address, so a refresh keeps them and a link shares them.",
          "Export JSON downloads exactly the events you are looking at.",
        ],
      },
      {
        heading: "Known limits",
        items: [
          "Alerts are silent in the sense that they do not pop up or play a sound; the traffic-light notifications (red, yellow, green) are separate and still do. The tab shows a count of firing alerts.",
          "The request counts behind the SLO are simulated from the traffic model, not measured from real requests.",
        ],
      },
    ],
    files: [
      { path: "components/tabs/Events.tsx", what: "this tab" },
      { path: "lib/engine/alerts.ts", what: "rules, the pending/firing lifecycle, SLO maths" },
      { path: "lib/engine/tick.ts", what: "records requests and evaluates the rules each tick" },
    ],
  },
  {
    slug: "config",
    title: "Config",
    tagline: "Every setting of a service in one place, with defaults, presets, and a file you can save and load.",
    tryIt: [
      "Apply the High availability preset and watch the Changed settings count. Then use each section's Reset button.",
      "Export the configuration, change a few settings, then import the file to put them back.",
      "Edit the cost per instance-hour and watch the cost in the Cluster tab change.",
    ],
    sections: [
      {
        heading: "One place for everything",
        items: [
          "Autoscaling and the load balancer, the queue, reliability and health checks, the SLO target, schedules and the service's name, domain and cost are all here for the selected service.",
          "Each section shows 'defaults' or how many settings differ ('3 changed'), and lists exactly which, such as 'min 2 -> 4'. Its Reset button puts that section back to the built-in values and keeps what is running: queued requests and live breaker state are not lost.",
        ],
      },
      {
        heading: "Presets",
        items: [
          "Cost saver: few instances that scale up late and down early, a small queue and a looser promise. Cheapest, but slower to absorb a spike.",
          "High availability: a larger always-on fleet that scales early, fast health checks, a deep queue and a strict promise. Rides out spikes and failures, at a much higher bill.",
          "A preset is just a list of ordinary changes, so it can only do what the individual controls can do. Back to defaults resets every section.",
        ],
      },
      {
        heading: "Export and import",
        items: [
          "Export downloads the settings as JSON: the services' settings, schedules, alert rules and the simulation speed. It never contains running instances, queues, events or metrics.",
          "Import reads such a file back. It is checked field by field with the same limits as the controls, and applied all-or-nothing: if anything in the file is invalid, nothing changes and you see the reason.",
          "Services in the file are matched by id. A service that does not exist here is skipped and counted. Numbers must be real numbers; text where a number belongs is rejected.",
        ],
      },
      {
        heading: "Why this is safe",
        items: [
          "Every command, including import, rejects non-numeric values for numeric settings with a clear message. This also protects the public site: a typo or a hostile request cannot put the simulation into a broken state.",
          "A configuration file larger than about 60 KB is refused outright.",
        ],
      },
    ],
    files: [
      { path: "components/tabs/Config.tsx", what: "this tab" },
      { path: "lib/engine/config.ts", what: "the exportable settings, defaults and presets" },
      { path: "lib/engine/commands.ts", what: "updateService, reset, the validated import" },
    ],
  },
];

export function getDoc(slug: string): TabDoc | undefined {
  return DOCS.find((d) => d.slug === slug);
}
