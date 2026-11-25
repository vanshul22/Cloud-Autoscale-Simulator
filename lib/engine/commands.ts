// =============================================================================
// commands.ts  —  Every way the UI is allowed to change the world.
//
// The browser never edits the Platform directly. It POSTs a `Command` to
// /api/control; the server calls `applyCommand`, which validates the input,
// mutates the world, and logs an event. One chokepoint = one place to validate,
// one place to log, and a clear list of "what can a user do" for the UI to bind.
//
// Add a new variant to `Command` + a case in `applyCommand` for every new
// control (chaos, deploy, schedule ...). TypeScript's exhaustiveness check at the
// bottom of the switch will tell you if you forget one.
// =============================================================================

import { makeInstance } from "../defaults";
import { clamp } from "./ids";
import { normalizeQueue } from "./queue";
import { log } from "./tick";
import type { AutoscaleConfig, LbAlgo, Pattern, Platform, QueueState, Service } from "./types";

export type Command =
  | { type: "setTraffic"; serviceId: string; rps: number } // move the base-load slider
  | { type: "adjustTraffic"; serviceId: string; delta: number } // +/- buttons
  | { type: "stopTraffic"; serviceId: string } // base load -> 0, pattern -> flat
  | { type: "setPattern"; serviceId: string; pattern: Pattern }
  | { type: "setSpeed"; speed: 1 | 5 | 60 }
  | {
      type: "updateAutoscale";
      serviceId: string;
      patch: Partial<Omit<AutoscaleConfig, "lb">> & { lb?: LbAlgo };
    }
  | {
      type: "updateQueue";
      serviceId: string;
      patch: Partial<Pick<QueueState, "capacity" | "maxWaitTicks" | "maxRetries" | "retryBackoffTicks">>;
    }
  | { type: "addInstance"; serviceId: string; size: number } // size 1 = standard, 2 = large...
  | { type: "removeInstance"; serviceId: string; instanceId: string } // graceful drain
  | { type: "replayDlq"; serviceId: string } // put dead-lettered requests back in line
  | { type: "purgeDlq"; serviceId: string } // discard dead-lettered requests
  | { type: "reset" };

export const MAX_RPS = 5000; // hard ceiling so a slider typo can't produce 1e9 RPS
export const MAX_INSTANCES = 30; // hard ceiling on instances per service

function find(p: Platform, id: string): Service {
  const svc = p.services.find((s) => s.id === id);
  if (!svc) throw new Error(`Unknown service: ${id}`);
  return svc;
}

/** Mutates `p` in place. Throws Error(message) on invalid input (API maps to 400). */
export function applyCommand(p: Platform, cmd: Command): void {
  switch (cmd.type) {
    case "setTraffic": {
      const svc = find(p, cmd.serviceId);
      svc.targetRps = clamp(Math.round(cmd.rps), 0, MAX_RPS);
      log(p, svc.id, "info", `Traffic set to ${svc.targetRps} req/s.`);
      return;
    }
    case "adjustTraffic": {
      const svc = find(p, cmd.serviceId);
      svc.targetRps = clamp(Math.round(svc.targetRps + cmd.delta), 0, MAX_RPS);
      log(
        p,
        svc.id,
        "info",
        `Traffic ${cmd.delta >= 0 ? "increased" : "decreased"} to ${svc.targetRps} req/s.`,
      );
      return;
    }
    case "stopTraffic": {
      const svc = find(p, cmd.serviceId);
      svc.targetRps = 0;
      svc.pattern = "flat";
      svc.patternTick = 0;
      // "info", not "warn": this is the user's own action, and warnings become
      // pop-ups. Nobody needs a notification for a button they just pressed.
      log(p, svc.id, "info", "Traffic stopped.");
      return;
    }
    case "setPattern": {
      const svc = find(p, cmd.serviceId);
      svc.pattern = cmd.pattern;
      svc.patternTick = 0; // restart the pattern's local clock
      log(p, svc.id, "info", `Traffic pattern: ${cmd.pattern}.`);
      return;
    }
    case "setSpeed": {
      if (![1, 5, 60].includes(cmd.speed)) throw new Error("speed must be 1, 5 or 60");
      p.speed = cmd.speed;
      log(p, "platform", "info", `Simulation speed set to ${cmd.speed}x.`);
      return;
    }
    case "updateAutoscale": {
      const svc = find(p, cmd.serviceId);
      const a = svc.autoscale;
      const { patch } = cmd;
      if (patch.min !== undefined) a.min = clamp(Math.round(patch.min), 0, 100);
      if (patch.max !== undefined) a.max = clamp(Math.round(patch.max), 1, 100);
      if (patch.rpsPerInstance !== undefined)
        a.rpsPerInstance = clamp(Math.round(patch.rpsPerInstance), 1, 10000);
      if (patch.scaleUpAt !== undefined) a.scaleUpAt = clamp(patch.scaleUpAt, 1, 100);
      if (patch.scaleDownAt !== undefined) a.scaleDownAt = clamp(patch.scaleDownAt, 0, 99);
      if (patch.cooldownTicks !== undefined)
        a.cooldownTicks = clamp(Math.round(patch.cooldownTicks), 0, 120);
      if (patch.lb !== undefined) a.lb = patch.lb;
      if (patch.enabled !== undefined) a.enabled = Boolean(patch.enabled);
      // Keep the config self-consistent so the autoscaler never sees nonsense.
      if (a.min > a.max) a.min = a.max;
      if (a.scaleDownAt >= a.scaleUpAt) a.scaleDownAt = Math.max(0, a.scaleUpAt - 1);
      log(p, svc.id, "info", "Autoscaling configuration updated.");
      return;
    }
    case "addInstance": {
      const svc = find(p, cmd.serviceId);
      // A hard ceiling so nobody (or a public visitor) can grow the world forever.
      if (svc.instances.length >= MAX_INSTANCES) {
        throw new Error(`A service can have at most ${MAX_INSTANCES} instances.`);
      }
      const size = clamp(Math.round(cmd.size), 1, 4);
      const inst = makeInstance(svc.version, true); // boots for a few ticks, like any new instance
      inst.weight = size;
      svc.instances.push(inst);
      log(p, svc.id, "info", `Instance ${inst.id} added by hand (${size === 1 ? "standard" : `${size}x`} size, booting).`);
      return;
    }
    case "removeInstance": {
      const svc = find(p, cmd.serviceId);
      const inst = svc.instances.find((i) => i.id === cmd.instanceId);
      if (!inst) throw new Error(`Unknown instance: ${cmd.instanceId}`);
      if (inst.status === "draining") throw new Error("That instance is already draining.");
      inst.status = "draining"; // finishes its goodbye tick, then tick.ts removes it
      log(p, svc.id, "info", `Instance ${inst.id} draining (removed by hand).`);
      return;
    }
    case "updateQueue": {
      const svc = find(p, cmd.serviceId);
      const q = (svc.queue = normalizeQueue(svc.queue));
      const { patch } = cmd;
      if (patch.capacity !== undefined) q.capacity = clamp(Math.round(patch.capacity), 0, 100000);
      if (patch.maxWaitTicks !== undefined) q.maxWaitTicks = clamp(Math.round(patch.maxWaitTicks), 1, 120);
      if (patch.maxRetries !== undefined) q.maxRetries = clamp(Math.round(patch.maxRetries), 0, 10);
      if (patch.retryBackoffTicks !== undefined)
        q.retryBackoffTicks = clamp(Math.round(patch.retryBackoffTicks), 1, 60);
      log(p, svc.id, "info", "Queue configuration updated.");
      return;
    }
    case "replayDlq": {
      const svc = find(p, cmd.serviceId);
      const q = (svc.queue = normalizeQueue(svc.queue));
      if (q.dlq <= 0) throw new Error("The dead-letter queue is empty.");
      // Replay only what fits: the queue's capacity still applies.
      const room = Math.max(0, q.capacity - q.depth);
      const n = Math.min(q.dlq, room);
      if (n <= 0) throw new Error("The queue is full, so nothing can be replayed right now.");
      q.dlq -= n;
      q.depth += n;
      q.cohorts.push({ n, age: 0, attempts: 0, readyAt: p.tick }); // a fresh start: attempts reset
      log(p, svc.id, "info", `Replayed ${n} dead-lettered request(s) back into the queue.`);
      return;
    }
    case "purgeDlq": {
      const svc = find(p, cmd.serviceId);
      const q = (svc.queue = normalizeQueue(svc.queue));
      if (q.dlq <= 0) throw new Error("The dead-letter queue is empty.");
      log(p, svc.id, "info", `Purged ${q.dlq} dead-lettered request(s).`);
      q.dlq = 0;
      return;
    }
    case "reset":
      throw new Error("reset is handled by the route (it replaces the whole world)");
    default: {
      const _exhaustive: never = cmd;
      throw new Error(`Unhandled command: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
