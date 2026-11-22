// =============================================================================
// nginx.ts  —  Renders the nginx.conf that WOULD be running for this service.
//
// Real nginx reads an `upstream` block listing backend servers. When the
// autoscaler adds or removes an instance, a config-management step regenerates
// this block and reloads nginx. We do the same: the config is derived from the
// current healthy instances, so you can literally watch it change as you scale.
//
// This is a pure function (Service in, string out), so the UI can call it on any
// snapshot, including old ones, to diff "before vs after".
// =============================================================================

import { servingInstances } from "./metrics";
import type { LbAlgo, Service } from "./types";

/** nginx directive for each algorithm ("" = nginx's default, round-robin). */
const LB_DIRECTIVE: Record<LbAlgo, string> = {
  "round-robin": "", // nginx default: no directive needed
  "least-conn": "    least_conn;\n",
  weighted: "", // weights are per-server below
};

/** A stable fake address for an instance, derived from its id (e.g. 10.0.1.x). */
export function instanceAddr(id: string): string {
  let n = 0;
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) % 250;
  return `10.0.1.${n + 2}:8080`;
}

export function renderNginxConf(svc: Service): string {
  const live = servingInstances(svc.instances);
  const servers =
    live.length === 0
      ? "    # no healthy upstreams: nginx will return 502 Bad Gateway\n"
      : live
          .map((i) => {
            const w = svc.autoscale.lb === "weighted" ? ` weight=${i.weight}` : "";
            return `    server ${instanceAddr(i.id)}${w}; # ${i.id} (${i.version})\n`;
          })
          .join("");

  return [
    `# generated for ${svc.name} (${svc.domain})`,
    `upstream ${svc.id}_backend {`,
    `${LB_DIRECTIVE[svc.autoscale.lb]}${servers}}`,
    ``,
    `server {`,
    `    listen 80;`,
    `    server_name ${svc.domain};`,
    ``,
    `    location / {`,
    `        proxy_pass http://${svc.id}_backend;`,
    `        proxy_next_upstream error timeout http_502;`,
    `    }`,
    `}`,
    ``,
  ].join("\n");
}
