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
          "Red when error rate is above 5%. Yellow when p95 is above 500 ms or utilisation is above the scale-up line. Green when calm again.",
          "Scale-ups and instance changes go to the event log only, never to a pop-up.",
        ],
      },
      {
        heading: "Known limit",
        items: [
          "The load balancer setting (round-robin, least-conn, weighted) changes nginx.conf, but traffic is still split evenly across instances. The real balancer logic is the next piece to build.",
        ],
      },
    ],
    files: [
      { path: "components/tabs/Cluster.tsx", what: "this tab's layout" },
      { path: "lib/engine/autoscaler.ts", what: "the scaling decision" },
      { path: "lib/engine/tick.ts", what: "one simulation step, and the health status" },
      { path: "lib/engine/traffic.ts", what: "the traffic patterns" },
      { path: "lib/engine/metrics.ts", what: "utilisation, latency, errors, cost" },
      { path: "lib/engine/nginx.ts", what: "generates nginx.conf" },
    ],
  },
];

export function getDoc(slug: string): TabDoc | undefined {
  return DOCS.find((d) => d.slug === slug);
}
