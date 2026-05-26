// Key-consuming unlocks for colored gates. Walking into a closed gate
// while holding a matching key spends the key, marks the gate's lock as
// None (so it stays open across zone reloads), and lets the player pass.
// Mirrors Rust's `lock_override` storage.
//
// Sfx + toast handlers are injected so this module loads under node
// without pulling client/audio.js or client/toast.js. The default
// is no-op; the offline client wires real handlers via
// client/gateUnlockBoot.js. Server installs no toast/sfx but listens to
// `onUnlock` so it can emit an event:gateUnlocked frame to the party.

import { getSpecies } from "./species.js";
import {
  canonicaliseLock,
  keySpeciesIdForLock,
  LOCK_NONE,
  LOCK_PERMANENT,
  saveLockOverride,
} from "./locks.js";
import { getAmmo, removeAmmo } from "./inventory.js";

const handlers = {
  sfx: null,
  toast: null,
  onUnlock: null,
};

export function setGateUnlockHandlers(h) {
  if (!h || typeof h !== "object") return;
  for (const k of Object.keys(h)) {
    if (h[k] !== undefined) handlers[k] = h[k];
  }
}

export function findGateAt(zone, tx, ty) {
  if (!zone?.entities) return null;
  for (const e of zone.entities) {
    const sp = getSpecies(e.species_id);
    if (!sp) continue;
    if (sp.entity_type !== "Gate" && sp.entity_type !== "InverseGate") continue;
    const f = e.frame; if (!f) continue;
    if (tx < f.x || tx >= f.x + f.w) continue;
    if (ty < f.y || ty >= f.y + f.h) continue;
    return e;
  }
  return null;
}

// Returns true if the gate is now open (either was already open, or was
// keyed and the player held a matching key). `unlocker` is the player
// object spending the key — it routes through the inventory backend so
// the right per-player bag (offline) or per-conn inventory (server) is
// decremented. Defaults to legacy global index-0 when unspecified, so
// older offline call sites continue to compile and behave as today.
export function tryUnlockGate(gate, unlocker = 0) {
  if (!gate) return false;
  if (gate._open) return true;
  const lock = canonicaliseLock(gate.lock_type);
  if (lock === LOCK_NONE) {
    gate._open = true;
    gate._frameOffsetX = 1;
    return true;
  }
  if (lock === LOCK_PERMANENT) return false;
  const keyId = keySpeciesIdForLock(lock);
  if (keyId == null) return false;
  if (getAmmo(keyId, unlocker) <= 0) return false;
  removeAmmo(keyId, 1, unlocker);
  gate.lock_type = LOCK_NONE;
  gate._open = true;
  gate._frameOffsetX = 1;
  if (gate.id != null) saveLockOverride(gate.id, LOCK_NONE);
  if (handlers.sfx) handlers.sfx("keyCollected");
  if (handlers.toast) handlers.toast(`Unlocked ${lock.toLowerCase()} gate`, "hint");
  if (handlers.onUnlock) handlers.onUnlock(gate, unlocker, lock);
  return true;
}
