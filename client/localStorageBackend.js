// Browser-side persistence layer for shared/storage.js. Importing this
// module installs a localStorage-backed implementation: every setValue
// roundtrips to localStorage under a single PREFIX, every getValue still
// reads the in-memory cache (hydrated on install).
//
// Stays browser-only on purpose — Phase 6 swaps in a SQLite backend on
// the server side without touching shared/storage.js.

import { installStorageBackend } from "../shared/storage.js";

const PREFIX = "sneakbit.kv.v1.";

function readInitial() {
  const initial = new Map();
  if (typeof localStorage === "undefined") return initial;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(k);
      if (raw == null) continue;
      const n = Number(raw);
      if (Number.isFinite(n)) initial.set(k.slice(PREFIX.length), n | 0);
    }
  } catch {}
  return initial;
}

installStorageBackend({
  initial: readInitial(),
  set(key, value) {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem(PREFIX + key, String(value)); } catch {}
  },
  remove(key) {
    if (typeof localStorage === "undefined") return;
    try { localStorage.removeItem(PREFIX + key); } catch {}
  },
});
