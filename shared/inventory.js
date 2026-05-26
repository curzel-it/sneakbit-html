// Per-player inventory: count of each pickup-able species id.
//
// Two backends share the same public API. The default (legacy) keeps the
// per-player-index storage that mirrors Rust's `player.{p}.inventory.amount.{sid}`
// — single-player code still calls `addAmmo(sid, n)` and reads back with
// `getAmmo(sid)` against player index 0; co-op threads explicit indices.
// The authoritative server installs a backend that mutates the per-player
// inventory object on the live connection's player so each online player
// keeps independent counts without colliding on a shared per-index store.
//
// `setInventoryBackend(backend)` swaps the implementation. Callers pass
// either a numeric index (legacy single/co-op) or a player object (server);
// the backend extracts whichever it needs.

import { getValue, setValue, keys as storageKeys } from "./storage.js";

const PLAYER_KEY_PREFIX = "player.";
const KEY_SUFFIX = ".inventory.amount.";
const MAX_PLAYERS = 2;

// counts[playerIndex] = { speciesId: count }
const counts = Array.from({ length: MAX_PLAYERS }, () => ({}));
let hydrated = false;
const listeners = new Set();

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  for (const inner of storageKeys()) {
    const m = inner.match(/^player\.(\d+)\.inventory\.amount\.(\d+)$/);
    if (!m) continue;
    const idx = m[1] | 0;
    const sid = m[2] | 0;
    if (idx < 0 || idx >= MAX_PLAYERS) continue;
    const v = getValue(inner);
    if (typeof v === "number") counts[idx][sid] = v | 0;
  }
}

function key(playerIndex, speciesId) {
  return `${PLAYER_KEY_PREFIX}${playerIndex | 0}${KEY_SUFFIX}${speciesId | 0}`;
}

function indexOf(playerOrIndex) {
  if (typeof playerOrIndex === "number") return playerOrIndex | 0;
  return (playerOrIndex?.index | 0);
}

function persist(playerIndex, speciesId) {
  const idx = playerIndex | 0;
  const v = counts[idx][speciesId] | 0;
  setValue(key(idx, speciesId), v === 0 ? null : v);
  for (const fn of listeners) fn(counts[idx], idx);
}

const legacyBackend = {
  get(playerOrIndex, speciesId) {
    hydrate();
    const idx = indexOf(playerOrIndex);
    return (counts[idx] || counts[0])[speciesId] | 0;
  },
  add(playerOrIndex, speciesId, amount) {
    hydrate();
    const idx = indexOf(playerOrIndex);
    const bucket = counts[idx] || counts[0];
    bucket[speciesId] = (bucket[speciesId] | 0) + (amount | 0);
    persist(idx, speciesId);
  },
  remove(playerOrIndex, speciesId, amount) {
    hydrate();
    const idx = indexOf(playerOrIndex);
    const bucket = counts[idx] || counts[0];
    const have = bucket[speciesId] | 0;
    if (have < amount) return false;
    bucket[speciesId] = have - amount;
    persist(idx, speciesId);
    return true;
  },
  snapshot(playerOrIndex) {
    hydrate();
    const idx = indexOf(playerOrIndex);
    return { ...(counts[idx] || {}) };
  },
  clear(playerOrIndex) {
    hydrate();
    const targets = playerOrIndex == null
      ? [...counts.keys()]
      : [indexOf(playerOrIndex)];
    for (const idx of targets) {
      const bucket = counts[idx];
      if (!bucket) continue;
      const ids = Object.keys(bucket);
      counts[idx] = {};
      for (const sid of ids) setValue(key(idx, sid), null);
      for (const fn of listeners) fn(counts[idx], idx);
    }
  },
};

let backend = legacyBackend;

export function setInventoryBackend(b) {
  backend = b || legacyBackend;
}

export function getAmmo(speciesId, playerOrIndex = 0) {
  return backend.get(playerOrIndex, speciesId);
}

export function addAmmo(speciesId, amount = 1, playerOrIndex = 0) {
  if (!amount) return;
  backend.add(playerOrIndex, speciesId, amount | 0);
}

export function removeAmmo(speciesId, amount = 1, playerOrIndex = 0) {
  return backend.remove(playerOrIndex, speciesId, amount | 0);
}

export function onInventoryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearInventory(playerOrIndex) {
  if (backend.clear) backend.clear(playerOrIndex);
}

// Returns a shallow snapshot of a player's counts. Used by the inventory
// screen and by the authoritative server to expose per-player state in
// the wire snapshot.
export function snapshotInventory(playerOrIndex = 0) {
  return backend.snapshot(playerOrIndex);
}

// Test-only hook: listeners survive backend swaps; tests sometimes need a
// clean slate. The legacy backend's storage cache is wiped by
// `_resetStorageForTesting` already.
export function _emitInventoryChangeForTesting(playerIndex) {
  const idx = playerIndex | 0;
  for (const fn of listeners) fn(counts[idx], idx);
}
