// Per-player equipment backend for the authoritative server. Mutates
// `conn.player.equipment` directly so each online player keeps an
// independent pair of slots without colliding on shared per-index
// storage. Installed at boot by index.js; pickups + future inventory
// UI hooks then route through getEquipped / setEquipped without caring
// which backend is active.
//
// Default ranged weapon mirrors the offline default (kunai launcher) so
// `shoot()` works the moment a connection is established — no waiting
// on a pickup. Melee starts null until a sword pickup lands.

import { setEquipmentBackend, SLOT_RANGED, SLOT_MELEE, DEFAULT_RANGED_WEAPON_ID } from "../shared/equipment.js";

function ensure(player) {
  if (!player.equipment) {
    player.equipment = {
      [SLOT_RANGED]: DEFAULT_RANGED_WEAPON_ID,
      [SLOT_MELEE]: null,
    };
  }
  return player.equipment;
}

function asPlayer(playerOrIndex) {
  return (playerOrIndex && typeof playerOrIndex === "object") ? playerOrIndex : null;
}

const serverBackend = {
  get(playerOrIndex, slot) {
    const p = asPlayer(playerOrIndex);
    if (!p) {
      if (slot === SLOT_RANGED) return DEFAULT_RANGED_WEAPON_ID;
      return null;
    }
    const bag = ensure(p);
    if (slot === SLOT_RANGED) {
      return bag[SLOT_RANGED] ?? DEFAULT_RANGED_WEAPON_ID;
    }
    if (slot === SLOT_MELEE) {
      return bag[SLOT_MELEE] ?? null;
    }
    return null;
  },
  set(playerOrIndex, slot, speciesId) {
    const p = asPlayer(playerOrIndex);
    if (!p) return;
    if (slot !== SLOT_RANGED && slot !== SLOT_MELEE) return;
    const bag = ensure(p);
    bag[slot] = speciesId == null ? null : speciesId;
  },
  clear(playerOrIndex, slot) {
    const p = asPlayer(playerOrIndex);
    if (!p) return;
    if (slot !== SLOT_RANGED && slot !== SLOT_MELEE) return;
    const bag = ensure(p);
    bag[slot] = null;
  },
};

export function installServerEquipmentBackend() {
  setEquipmentBackend(serverBackend);
}

export function initPlayerEquipment(player) {
  if (!player) return;
  player.equipment = {
    [SLOT_RANGED]: DEFAULT_RANGED_WEAPON_ID,
    [SLOT_MELEE]: null,
  };
}
