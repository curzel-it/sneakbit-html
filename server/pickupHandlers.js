// Server pickup handlers — installed at boot to neutralise the offline
// side-effects (audio, toast, dialogue lookup) and to surface per-pickup
// events to the tick driver.
//
// The tick reads `instance._pendingPickupEvents` after `checkPickup` and
// broadcasts an `event:pickup` per (player, species, amount) pair. It also
// resets the queue at the top of every tickOnce so the queue can't outlive
// one tick's broadcast.
//
// Auto-equip is deliberately a no-op until Phase 4 step 4 lands per-player
// equipment slots on the server. Inventory still records the pickup so when
// equipment lands the player will have something to equip.

import { setPickupHandlers } from "../shared/pickups.js";

let currentInstance = null;

function connFromPlayer(instance, player) {
  if (!instance || !player) return null;
  for (const conn of instance.connections.values()) {
    if (conn.player === player) return conn;
  }
  return null;
}

export function installServerPickupHandlers() {
  setPickupHandlers({
    // Sfx + toast: no-ops server-side. Clients render their own SFX +
    // toast from the `event:pickup` frames the tick broadcasts after
    // the pickup check.
    sfx: () => {},
    toast: () => {},
    // Hint resolution would normally read i18n strings + the saved
    // hint-read flag. No hints fire server-side; the entity stays in
    // the zone, and the wire surface for hints lands with dialogue in
    // step 7.
    resolveDialogue: () => null,
    dialogueLines: () => [],
    onPickup: (picker, speciesId, amount) => {
      if (!currentInstance) return;
      const conn = connFromPlayer(currentInstance, picker);
      if (!conn) return;
      const queue = currentInstance._pendingPickupEvents
        ?? (currentInstance._pendingPickupEvents = []);
      queue.push({
        playerId: conn.playerId,
        speciesId: speciesId | 0,
        amount: amount | 0,
      });
    },
    // Auto-equip is a step 4 concern (per-player equipment slots).
    onAutoEquip: () => {},
  });
}

// The tick wraps its `checkPickup` call with `withPickupContext(instance, fn)`
// so the handlers above know which instance to push events onto. Without a
// per-call context the handlers can't tell whose queue to write to (multiple
// instances tick from the same process).
export function withPickupContext(instance, fn) {
  const prev = currentInstance;
  currentInstance = instance;
  try { return fn(); }
  finally { currentInstance = prev; }
}
