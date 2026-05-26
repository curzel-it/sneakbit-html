// Server gate-unlock handlers — installed at boot to neutralise the
// offline audio/toast side-effects and to emit `event:gateUnlocked` to
// the party when a player spends a key on a colored gate. Entity
// deltas already carry the gate's `_open` flag (set inside
// `tryUnlockGate`), so the client renders the new state via the normal
// delta path; this event is just a UX hook (toast + sfx on the player
// who actually unlocked the gate).
//
// The tick wraps `updatePlayer` calls in `withGateUnlockContext` so the
// onUnlock handler can find the current instance to queue events into.

import { setGateUnlockHandlers } from "../shared/gateUnlock.js";

let currentInstance = null;

function connFromPlayer(instance, player) {
  if (!instance || !player) return null;
  for (const conn of instance.connections.values()) {
    if (conn.player === player) return conn;
  }
  return null;
}

export function installServerGateUnlockHandlers() {
  setGateUnlockHandlers({
    sfx: () => {},
    toast: () => {},
    onUnlock: (gate, unlocker, lock) => {
      if (!currentInstance) return;
      const conn = connFromPlayer(currentInstance, unlocker);
      if (!conn) return;
      const queue = currentInstance._pendingPickupEvents
        ?? (currentInstance._pendingPickupEvents = []);
      queue.push({
        op: "event",
        kind: "gateUnlocked",
        playerId: conn.playerId,
        gateId: gate.id ?? null,
        lock,
      });
    },
  });
}

export function withGateUnlockContext(instance, fn) {
  const prev = currentInstance;
  currentInstance = instance;
  try { return fn(); }
  finally { currentInstance = prev; }
}
