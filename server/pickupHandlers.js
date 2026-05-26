// Server pickup handlers — installed at boot to neutralise the offline
// side-effects (audio, toast, dialogue lookup) and to surface per-pickup
// and per-auto-equip events to the tick driver.
//
// The tick reads `instance._pendingPickupEvents` after `checkPickup` and
// broadcasts an `event:pickup` per (player, species, amount) and an
// `event:equip` per (player, slot, species). It also resets the queue at
// the top of every tickOnce so the queue can't outlive one tick's
// broadcast.

import { setPickupHandlers } from "../shared/pickups.js";
import { setEquipped } from "../shared/equipment.js";

let currentInstance = null;

function connFromPlayer(instance, player) {
  if (!instance || !player) return null;
  for (const conn of instance.connections.values()) {
    if (conn.player === player) return conn;
  }
  return null;
}

function queueOn(instance, event) {
  const queue = instance._pendingPickupEvents
    ?? (instance._pendingPickupEvents = []);
  queue.push(event);
}

export function installServerPickupHandlers() {
  setPickupHandlers({
    // Sfx + toast: no-ops server-side. Clients render their own SFX +
    // toast from the `event:pickup` and `event:equip` frames the tick
    // broadcasts after the pickup check.
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
      queueOn(currentInstance, {
        op: "event",
        kind: "pickup",
        playerId: conn.playerId,
        speciesId: speciesId | 0,
        amount: amount | 0,
      });
    },
    // Server-side auto-equip: write the weapon into the per-player slot
    // via the equipment backend (= mutate conn.player.equipment) and
    // queue an event:equip so the client mirror updates.
    onAutoEquip: (picker, slot, weaponSp /*, hint */) => {
      if (!currentInstance || !weaponSp) return;
      const conn = connFromPlayer(currentInstance, picker);
      if (!conn) return;
      setEquipped(slot, weaponSp.id, picker);
      queueOn(currentInstance, {
        op: "event",
        kind: "equip",
        playerId: conn.playerId,
        slot,
        speciesId: weaponSp.id,
      });
    },
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
