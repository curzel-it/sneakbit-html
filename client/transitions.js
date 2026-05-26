// Browser-side zone transition orchestration. Owns the fade-overlay
// DOM element, the asset reload (loadZone fetch, biome-sheet bake,
// IndexedDB buffer write on the way out), and the SFX. Pure spawn
// resolution lives in shared/transitions.js.

import { loadZone } from "./data.js";
import { buildZone } from "../shared/zone.js";
import { playSfx } from "./audio.js";
import { playTrack } from "./music.js";
import { getZoneCache } from "./zoneCache.js";
import { setupPuzzles } from "../shared/puzzles.js";
import { setupCutscenes } from "../shared/cutscenes.js";
import { isCreativeMode } from "../shared/creativeMode.js";
import { putBufferedZone } from "./zoneBuffer.js";
import { resetPlayerHealth, isPlayerDead } from "../shared/playerHealth.js";
import {
  findTeleporterAt as sharedFindTeleporterAt,
  resolveSpawn,
  movePlayerTo,
  repositionCoopP2,
} from "../shared/transitions.js";

const FADE_DURATION_MS = 220;

let fadeEl = null;
let busy = false;

export function installTransitions() {
  if (fadeEl) return fadeEl;
  fadeEl = document.createElement("div");
  fadeEl.id = "fade";
  Object.assign(fadeEl.style, {
    position: "fixed",
    inset: "0",
    background: "#000",
    opacity: "0",
    pointerEvents: "none",
    transition: `opacity ${FADE_DURATION_MS}ms ease`,
    zIndex: "10",
  });
  document.body.appendChild(fadeEl);
  return fadeEl;
}

// Re-export so main.js keeps a single import surface for transitions.
export const findTeleporterAt = sharedFindTeleporterAt;

// `state` is the game-state container from main.js — at minimum
// `{ zone, player }`. We mutate `state.zone` and the player position.
export async function travelTo(state, destination) {
  if (busy) return;
  busy = true;
  try {
    const sourceZoneId = state.zone?.id ?? 0;
    // Creative mode persists the source zone's raw JSON to the
    // IndexedDB override buffer before we tear down, so map-editor
    // mutations made on the way out survive the zone transition (Rust
    // engine.save() runs on every teleport in creative). Awaited so the
    // write actually flushes before we lose the source reference.
    if (isCreativeMode() && sourceZoneId && state.rawZone) {
      try { await putBufferedZone(sourceZoneId, state.rawZone); }
      catch (e) { console.warn("creative: failed to buffer zone on teleport", e); }
    }
    playSfx("zoneChange");
    await fadeOut();
    const raw = await loadZone(destination.zone);
    const zone = buildZone(raw);
    setupPuzzles(zone);
    setupCutscenes(zone);
    // Bake the static tile layers during the black-screen window so the
    // first rendered frame is already cheap.
    getZoneCache(zone);
    state.zone = zone;
    // Keep the raw JSON next to the built zone so the creative editor
    // can mutate it in place and re-run buildZone() to refresh derived
    // state. Non-creative play also keeps it around — cheap, and the
    // save-on-teleport path above is the only consumer.
    state.rawZone = raw;
    state.lastTile = { x: state.player.tileX, y: state.player.tileY };
    if (state.player2) {
      state.lastTile2 = { x: state.player2.tileX, y: state.player2.tileY };
    }
    if (zone.soundtrack) playTrack(zone.soundtrack);
    const [spawnX, spawnY] = resolveSpawn(zone, destination, sourceZoneId);
    // Mirror Rust zone.spawn_point: remember the entry tile so that death
    // respawn can drop the player back at the door they came in through,
    // instead of teleporting them all the way to the starting zone.
    zone.spawnPoint = { x: spawnX, y: spawnY };
    movePlayerTo(state.player, spawnX, spawnY, destination.direction);
    // Co-op: respawn P2 next to P1 in P1's facing direction (Rust's
    // spawn_coop_players_around_hero runs on every zone entry). Falls
    // back to stacking on P1 if the offset tile is blocked. A dead P2
    // is brought back to life by the zone reload — matches Rust's
    // dead_players being cleared on every zone entry.
    if (state.player2) {
      const wasDead = isPlayerDead(state.player2.index | 0);
      repositionCoopP2(state.player2, state.player, zone);
      if (wasDead) resetPlayerHealth(state.player2.index | 0);
    }
    await fadeIn();
  } finally {
    busy = false;
  }
}

function fadeOut() { return setFade(1); }
function fadeIn() { return setFade(0); }

function setFade(target) {
  return new Promise((resolve) => {
    if (!fadeEl) return resolve();
    fadeEl.style.opacity = String(target);
    setTimeout(resolve, FADE_DURATION_MS);
  });
}
