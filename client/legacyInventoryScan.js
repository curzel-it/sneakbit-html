// Browser-only v2 migration step: walks the legacy
// `sneakbit.inventory.v1` blob, fans counts into the per-player kv keys
// the shared inventory module expects, then drops the old key.
//
// Registers itself with shared/migrations.js on import. Server-side
// callers never import this file, so the v2 step there is a no-op.

import { setLegacyInventoryScan } from "../shared/migrations.js";
import { setValue } from "../shared/storage.js";

const LEGACY_INVENTORY_KEY = "sneakbit.inventory.v1";

setLegacyInventoryScan(() => {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(LEGACY_INVENTORY_KEY);
    if (!raw) return;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    if (parsed && typeof parsed === "object") {
      for (const [sid, n] of Object.entries(parsed)) {
        const sidNum = Number(sid);
        const count = Number(n) | 0;
        if (!Number.isFinite(sidNum) || count <= 0) continue;
        setValue(`player.0.inventory.amount.${sidNum}`, count);
      }
    }
    localStorage.removeItem(LEGACY_INVENTORY_KEY);
  } catch {}
});
