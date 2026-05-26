// Save migrations. Mirrors Rust features/migrations.rs.
//
// Versioned localStorage prefixes (sneakbit.kv.v1, sneakbit.inventory.v1,
// sneakbit.settings.v1) protect against silent breakage when the schema
// changes — but only if there's actual migration code to walk old saves
// up to the current shape. This module owns that ladder.
//
// Schema version is stored under `build_number` in the regular kv store.
// `runMigrations()` runs once at startup before any feature touches its
// own slice of storage, walks every migration ≥ stored version, then
// stamps the current BUILD_NUMBER. Modules that introduce a breaking
// storage change must:
//   1. Bump BUILD_NUMBER below.
//   2. Push a `{ to, run }` entry to MIGRATIONS describing the upgrade.
//
// Browser-only one-shot rewrites (e.g. scanning a legacy localStorage
// key whose name doesn't fit the shared kv prefix) plug in via
// setLegacyInventoryScan — see client/legacyInventoryScan.js. On Node
// the hook stays null and the v2 entry only stamps the equipment
// passthrough.

import { getValue, setValue } from "./storage.js";

export const BUILD_NUMBER = 3;

const KEY_BUILD = "build_number";
const LEGACY_LATEST_WORLD_KEY = "latest_world";
const CURRENT_LATEST_ZONE_KEY = "latest_zone";

let legacyInventoryScan = null;

export function setLegacyInventoryScan(fn) {
  legacyInventoryScan = typeof fn === "function" ? fn : null;
}

const MIGRATIONS = [
  {
    // v2: split global inventory + extend equipment to per-player keys.
    // Old layout: one JSON blob at sneakbit.inventory.v1, plus
    // `player.0.equipped.ranged|melee` in the kv store.
    // New layout: `player.{p}.inventory.amount.{species_id}` in the kv
    // store, per-player equipment slots, and the old blob is dropped.
    //
    // The legacy-blob scan lives in client/legacyInventoryScan.js
    // because it reads a non-prefixed localStorage key directly.
    to: 2,
    run() {
      if (legacyInventoryScan) legacyInventoryScan();
      // Equipment: legacy keys (player.0.equipped.ranged / .melee) keep
      // the same shape under the new code, so no rewrite is needed for
      // P1. P2 starts with no overrides — the default kunai launcher
      // fallback kicks in via getEquipped(SLOT_RANGED, 1) on first read.
    },
  },
  {
    // v3: rename the "world" terminology to "zone". The on-disk progress
    // key moved from `latest_world` to `latest_zone`. Copy the old value
    // forward if present, then drop the old key.
    to: 3,
    run() {
      const legacy = getValue(LEGACY_LATEST_WORLD_KEY);
      if (legacy != null && getValue(CURRENT_LATEST_ZONE_KEY) == null) {
        setValue(CURRENT_LATEST_ZONE_KEY, legacy);
      }
      setValue(LEGACY_LATEST_WORLD_KEY, null);
    },
  },
];

export function runMigrations() {
  const current = getValue(KEY_BUILD);
  if (current === BUILD_NUMBER) return { applied: 0, from: current, to: BUILD_NUMBER };
  if (current == null) {
    setValue(KEY_BUILD, BUILD_NUMBER);
    return { applied: 0, from: null, to: BUILD_NUMBER };
  }
  let applied = 0;
  for (const m of MIGRATIONS) {
    if (m.to > current && m.to <= BUILD_NUMBER) {
      try { m.run(); applied++; }
      catch (e) { console.error(`Migration to v${m.to} failed:`, e); }
    }
  }
  setValue(KEY_BUILD, BUILD_NUMBER);
  return { applied, from: current, to: BUILD_NUMBER };
}
