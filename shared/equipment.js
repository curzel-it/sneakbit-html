// Per-player equipped weapons. Mirrors Rust equipment/basics.rs: one
// slot for ranged and one for melee, identified by species id.
//
// Two backends share the same public API. The default (legacy) backend
// keeps the per-player-index storage that mirrors Rust
// `player.{p}.equipped.{slot}` — single-player code calls
// `setEquipped(slot, sid)` against player index 0; co-op threads an
// explicit numeric index. The authoritative server installs a backend
// that mutates the per-player equipment object on the live connection's
// player so each online player keeps independent slots without colliding
// on the shared per-index store.
//
// `setEquipmentBackend(backend)` swaps the implementation. Callers pass
// either a numeric index (legacy single/co-op) or a player object (server
// + renderers that already have the mirror player to hand). The backend
// extracts whichever it needs.

import { getValue, setValue } from "./storage.js";

export const SLOT_RANGED = "ranged";
export const SLOT_MELEE  = "melee";

export const DEFAULT_RANGED_WEAPON_ID = 1160; // kunai launcher

const listeners = new Set();

function keyFor(slot, index) {
  const i = (index | 0);
  return `player.${i}.equipped.${slot}`;
}

function indexOf(playerOrIndex) {
  if (typeof playerOrIndex === "number") return playerOrIndex | 0;
  return (playerOrIndex?.index | 0);
}

// When the caller hands in a player object that already has a populated
// `equipment` field (online mirror players seeded from server snapshots),
// we read from that directly. Otherwise we fall back to the legacy
// per-index storage — single-player and local-co-op continue to work
// identically.
function playerEquipmentDirect(playerOrIndex) {
  if (playerOrIndex && typeof playerOrIndex === "object" && playerOrIndex.equipment) {
    return playerOrIndex.equipment;
  }
  return null;
}

const legacyBackend = {
  get(playerOrIndex, slot) {
    const direct = playerEquipmentDirect(playerOrIndex);
    if (direct) {
      if (slot === SLOT_RANGED) {
        return direct[SLOT_RANGED] ?? DEFAULT_RANGED_WEAPON_ID;
      }
      if (slot === SLOT_MELEE) {
        return direct[SLOT_MELEE] ?? null;
      }
      return null;
    }
    const idx = indexOf(playerOrIndex);
    if (slot === SLOT_RANGED) {
      const v = getValue(keyFor(SLOT_RANGED, idx));
      return v == null ? DEFAULT_RANGED_WEAPON_ID : v;
    }
    if (slot === SLOT_MELEE) {
      const v = getValue(keyFor(SLOT_MELEE, idx));
      return v == null ? null : v;
    }
    return null;
  },
  set(playerOrIndex, slot, speciesId) {
    if (slot !== SLOT_RANGED && slot !== SLOT_MELEE) return;
    const idx = indexOf(playerOrIndex);
    setValue(keyFor(slot, idx), speciesId);
    for (const fn of listeners) fn(slot, speciesId, idx);
  },
  clear(playerOrIndex, slot) {
    if (slot !== SLOT_RANGED && slot !== SLOT_MELEE) return;
    const idx = indexOf(playerOrIndex);
    setValue(keyFor(slot, idx), null);
    for (const fn of listeners) fn(slot, null, idx);
  },
};

let backend = legacyBackend;

export function setEquipmentBackend(b) {
  backend = b || legacyBackend;
}

export function getEquipped(slot, playerOrIndex = 0) {
  return backend.get(playerOrIndex, slot);
}

export function setEquipped(slot, speciesId, playerOrIndex = 0) {
  backend.set(playerOrIndex, slot, speciesId);
}

export function clearEquipped(slot, playerOrIndex = 0) {
  if (backend.clear) backend.clear(playerOrIndex, slot);
  else backend.set(playerOrIndex, slot, null);
}

export function onEquipmentChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Test / boot hook: emit a synthetic change to wake subscribers after the
// backend swap. The legacy backend fires listeners on every write; the
// server backend skips listeners (clients learn via event:equip).
export function _notifyEquipmentChange(slot, speciesId, playerOrIndex) {
  for (const fn of listeners) fn(slot, speciesId, indexOf(playerOrIndex));
}
