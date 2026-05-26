// Teleporter resolution + spawn placement. The pure half of the zone
// transition feature: pick the destination tile and reposition the
// player(s), without touching DOM or asset loading. The orchestration
// (fade overlay, loadZone fetch, IndexedDB buffer, SFX) lives in
// client/transitions.js. A server-side travelTo will reuse the same
// resolveSpawn / movePlayerTo / repositionCoopP2 helpers.

import { isWalkable, isEntityBlocked } from "./zone.js";

export const TELEPORTER_SPECIES_ID = 1019;

const DIR_OFFSET = {
  up:    [ 0, -1],
  down:  [ 0,  1],
  left:  [-1,  0],
  right: [ 1,  0],
};

export function findTeleporterAt(zone, tileX, tileY) {
  if (!zone.entities) return null;
  for (const e of zone.entities) {
    if (e.species_id !== TELEPORTER_SPECIES_ID) continue;
    if (!e.destination) continue;
    const f = e.frame;
    if (!f) continue;
    if (
      tileX >= f.x && tileX < f.x + f.w &&
      tileY >= f.y && tileY < f.y + f.h
    ) {
      return e;
    }
  }
  return null;
}

// Mirrors world_setup.rs::destination_x_y. When the source teleporter
// stores (0, 0) the engine looks up the destination zone's teleporter
// that points back at us; we then step the player one tile *out* of
// that teleporter (typically down) so they don't immediately retrigger
// it and so they stand visually in front of the door, not on it.
//
// Convention: destination.x, destination.y are in the feet/tile space —
// same as player.tileX/tileY. Callers reading from zone data (where Y
// is the Rust frame.y, i.e. the TOP of the 1×2 sprite) must add 1
// before calling — main.js::maybeTeleport does this for the in-zone
// teleporter path. The death-respawn path passes zone.spawnPoint, which
// is already feet-tile.
export function resolveSpawn(zone, destination, sourceZoneId) {
  const ox = destination.x ?? 0;
  const oy = destination.y ?? 0;
  if (ox === 0 && oy === 0) {
    const back = findTeleporterBack(zone, sourceZoneId) ?? findAnyTeleporter(zone);
    if (back) return stepOutOf(zone, back, destination.direction);
    return [Math.floor(zone.cols / 2), Math.floor(zone.rows / 2)];
  }
  return [
    clamp(ox, 0, zone.cols - 1),
    clamp(oy, 0, zone.rows - 1),
  ];
}

// Pick a tile adjacent to the back teleporter's frame that the player
// can stand on. Tries the destination's stated direction first (or down
// as the natural "out of the door" default), then falls back to other
// directions, finally to the teleporter tile itself.
function stepOutOf(zone, frame, direction) {
  const preferred = direction && direction !== "None"
    ? direction.toLowerCase()
    : "down";
  const order = [preferred, "down", "up", "left", "right"];
  const seen = new Set();
  for (const dir of order) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const off = DIR_OFFSET[dir];
    if (!off) continue;
    const tx = (off[0] >= 0 ? frame.x + frame.w - 1 : frame.x) + off[0];
    const ty = (off[1] >= 0 ? frame.y + frame.h - 1 : frame.y) + off[1];
    if (tx < 0 || ty < 0 || tx >= zone.cols || ty >= zone.rows) continue;
    if (!isWalkable(zone, tx, ty)) continue;
    if (isEntityBlocked(zone, tx, ty)) continue;
    return [tx, ty];
  }
  return [frame.x, frame.y];
}

function findTeleporterBack(zone, sourceZoneId) {
  if (!zone.entities || !sourceZoneId) return null;
  for (const e of zone.entities) {
    if (e.species_id !== TELEPORTER_SPECIES_ID) continue;
    if (e.destination?.zone !== sourceZoneId) continue;
    if (e.frame) return e.frame;
  }
  return null;
}

function findAnyTeleporter(zone) {
  if (!zone.entities) return null;
  for (const e of zone.entities) {
    if (e.species_id === TELEPORTER_SPECIES_ID && e.frame) return e.frame;
  }
  return null;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Place P2 one tile in P1's facing direction, falling back to the same
// tile as P1 if the offset is blocked / out of bounds. Matches Rust
// world_setup::spawn_coop_players_around_hero.
export function repositionCoopP2(p2, p1, zone) {
  const off = DIR_OFFSET[p1.direction] ?? DIR_OFFSET.down;
  const candX = p1.tileX + off[0];
  const candY = p1.tileY + off[1];
  const inBounds = candX >= 0 && candY >= 0
    && candX < zone.cols && candY < zone.rows;
  const free = inBounds
    && isWalkable(zone, candX, candY)
    && !isEntityBlocked(zone, candX, candY);
  movePlayerTo(p2, free ? candX : p1.tileX, free ? candY : p1.tileY, p1.direction);
}

export function movePlayerTo(player, tileX, tileY, direction) {
  player.tileX = tileX;
  player.tileY = tileY;
  player.x = tileX;
  player.y = tileY;
  player.step = null;
  player.queuedDir = null;
  player.pendingDir = null;
  player.pendingTimer = 0;
  // Strip any in-flight slide momentum from ice — keeps the respawned
  // player from immediately stepping off in whatever direction they
  // were sliding when they died.
  player._sliding = false;
  if (direction && direction !== "None") {
    player.direction = direction.toLowerCase();
  }
}
