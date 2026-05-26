// Per-player inventory backend for the authoritative server. Installed at
// boot via setInventoryBackend; the shared inventory API then mutates the
// per-connection player object directly instead of routing through
// shared/inventory.js's per-index records (which would collide across
// online conns all running at index 0).
//
// The wire snapshot + delta read `player.inventory` straight off the conn,
// so any pickup write is visible to the client on the very next broadcast.

import { setInventoryBackend } from "../shared/inventory.js";

function ensure(player) {
  if (!player.inventory) player.inventory = {};
  return player.inventory;
}

function asPlayer(playerOrIndex) {
  return (playerOrIndex && typeof playerOrIndex === "object") ? playerOrIndex : null;
}

const serverBackend = {
  get(playerOrIndex, speciesId) {
    const p = asPlayer(playerOrIndex);
    if (!p) return 0;
    return ensure(p)[speciesId | 0] | 0;
  },
  add(playerOrIndex, speciesId, amount) {
    const p = asPlayer(playerOrIndex);
    if (!p) return;
    const bag = ensure(p);
    const sid = speciesId | 0;
    bag[sid] = (bag[sid] | 0) + (amount | 0);
  },
  remove(playerOrIndex, speciesId, amount) {
    const p = asPlayer(playerOrIndex);
    if (!p) return false;
    const bag = ensure(p);
    const sid = speciesId | 0;
    const have = bag[sid] | 0;
    if (have < amount) return false;
    bag[sid] = have - amount;
    return true;
  },
  snapshot(playerOrIndex) {
    const p = asPlayer(playerOrIndex);
    if (!p) return {};
    return { ...ensure(p) };
  },
  clear(playerOrIndex) {
    const p = asPlayer(playerOrIndex);
    if (!p) return;
    p.inventory = {};
  },
};

export function installServerInventoryBackend() {
  setInventoryBackend(serverBackend);
}

export function initPlayerInventory(player) {
  if (!player) return;
  player.inventory = {};
}
