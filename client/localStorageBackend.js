// Browser-side persistence layer for shared/storage.js. Importing this
// module installs a localStorage-backed implementation: every setValue
// roundtrips to localStorage under a single PREFIX, every getValue still
// reads the in-memory cache (hydrated on install).
//
// Stays browser-only on purpose — Phase 6 swaps in a SQLite backend on
// the server side without touching shared/storage.js.
//
// Online and offline modes use distinct prefixes so switching modes is
// switching characters (per authoritative-server.md agreement 2), not
// reconnecting on top of the offline save.

import { installStorageBackend } from "../shared/storage.js";
import { isOnlineMode } from "./onlineMode.js";

const OFFLINE_PREFIX = "sneakbit.kv.v1.";
const ONLINE_PREFIX  = "sneakbit.online.kv.v1.";

export const STORAGE_PREFIX = isOnlineMode() ? ONLINE_PREFIX : OFFLINE_PREFIX;

function readInitial() {
  const initial = new Map();
  if (typeof localStorage === "undefined") return initial;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(STORAGE_PREFIX)) continue;
      const raw = localStorage.getItem(k);
      if (raw == null) continue;
      const n = Number(raw);
      if (Number.isFinite(n)) initial.set(k.slice(STORAGE_PREFIX.length), n | 0);
    }
  } catch {}
  return initial;
}

installStorageBackend({
  initial: readInitial(),
  set(key, value) {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem(STORAGE_PREFIX + key, String(value)); } catch {}
  },
  remove(key) {
    if (typeof localStorage === "undefined") return;
    try { localStorage.removeItem(STORAGE_PREFIX + key); } catch {}
  },
});
