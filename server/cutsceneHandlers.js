// Server cutscene event handlers — installed at boot. Queues
// event:cutsceneStart and event:cutsceneEnd onto the per-instance
// event queue so every party member sees the same cutscene start/end
// boundary. The actual animation runs on each client off the entity
// state in the next snapshot/delta.
//
// The tick wraps tickCutscenes in `withCutsceneContext(instance, fn)`
// so the handlers can find the current instance to queue events into.

import { setCutsceneHandlers } from "../shared/cutscenes.js";

let currentInstance = null;

function queue(instance, ev) {
  const q = instance._pendingPickupEvents
    ?? (instance._pendingPickupEvents = []);
  q.push(ev);
}

export function installServerCutsceneHandlers() {
  setCutsceneHandlers({
    onStart: (zone, c) => {
      if (!currentInstance) return;
      queue(currentInstance, {
        op: "event",
        kind: "cutsceneStart",
        zoneId: zone.id,
        id: c.key || null,
      });
    },
    onEnd: (zone, c) => {
      if (!currentInstance) return;
      queue(currentInstance, {
        op: "event",
        kind: "cutsceneEnd",
        zoneId: zone.id,
        id: c.key || null,
      });
    },
  });
}

export function withCutsceneContext(instance, fn) {
  const prev = currentInstance;
  currentInstance = instance;
  try { return fn(); }
  finally { currentInstance = prev; }
}
