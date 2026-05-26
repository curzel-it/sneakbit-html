// Generic numeric key/value store. Mirrors the Rust game_core storage
// module: arbitrary string keys hold u32 values, and keyMatches(key,
// expected) is the gate used by dialogue conditions (and by equipment,
// after-dialogue tracking, etc.). Values are coerced to integers on
// read/write; null (and absent) is the "unset" state — distinct from 0.
//
// Backend-agnostic by design. The default is an in-memory Map, so this
// module loads cleanly under node with no shims. Browser entry points
// install client/localStorageBackend.js to persist writes; the Phase 6
// server will install a SQLite-backed equivalent.

const cache = new Map();
let onSet = null;
let onRemove = null;

export function installStorageBackend({ initial, set, remove } = {}) {
  cache.clear();
  if (initial instanceof Map) {
    for (const [k, v] of initial) cache.set(k, v | 0);
  } else if (initial && typeof initial === "object") {
    for (const k of Object.keys(initial)) cache.set(k, initial[k] | 0);
  }
  onSet = typeof set === "function" ? set : null;
  onRemove = typeof remove === "function" ? remove : null;
}

export function getValue(key) {
  return cache.has(key) ? cache.get(key) : null;
}

export function setValue(key, value) {
  if (value == null) {
    cache.delete(key);
    if (onRemove) onRemove(key);
    return;
  }
  const v = value | 0;
  cache.set(key, v);
  if (onSet) onSet(key, v);
}

export function keyMatches(key, expectedValue) {
  if (!key || key === "always") return true;
  const stored = getValue(key);
  const ev = expectedValue | 0;
  if (stored === ev) return true;
  if (ev === 0 && stored === null) return true;
  return false;
}

export function _resetStorageForTesting() {
  cache.clear();
  onSet = null;
  onRemove = null;
}
