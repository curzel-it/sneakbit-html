// A single live (zoneId, partyId) instance. Phase 2 has exactly one — the
// starting zone, shared by every connected socket since parties don't exist
// yet. Phase 3 introduces party scoping and the registry that creates these
// lazily per (zoneId, partyId).

import { STARTING_SPAWN } from "../shared/constants.js";
import { buildZone } from "../shared/zone.js";

export function createZoneInstance({ rawZone }) {
  return {
    rawZone,
    zone: buildZone(rawZone),
    tick: 0,
    connections: new Map(),
  };
}

export function addConnection(instance, conn) {
  // Spawn every joiner at the hard-coded starting tile for now. Phase 4
  // restores per-player state, including their last known position.
  conn.player.x = STARTING_SPAWN.x;
  conn.player.y = STARTING_SPAWN.y;
  conn.player.tileX = STARTING_SPAWN.x;
  conn.player.tileY = STARTING_SPAWN.y;
  instance.connections.set(conn.id, conn);
}

export function removeConnection(instance, conn) {
  instance.connections.delete(conn.id);
}

// Build the zone-snapshot payload referenced by the wire protocol. Tile
// grids are passed through unchanged from the raw JSON so the client's
// existing buildZone() rehydrates them with no special-casing.
export function snapshotZone(instance) {
  return {
    id: instance.zone.id,
    tick: instance.tick,
    zoneType: instance.zone.zoneType,
    rows: instance.zone.rows,
    cols: instance.zone.cols,
    biomeTiles: instance.rawZone.biome_tiles,
    constructionTiles: instance.rawZone.construction_tiles,
    lightConditions: instance.zone.lightConditions,
    soundtrack: instance.zone.soundtrack,
    players: [...instance.connections.values()].map(serializePlayer),
    entities: instance.rawZone.entities ?? [],
    spawnPoint: { x: STARTING_SPAWN.x, y: STARTING_SPAWN.y },
  };
}

// Phase 2 sends the live player object verbatim — the renderer reads x/y,
// direction, frameIndex etc. directly. `step` lets the client interpolate
// between snapshots; without it, 10 Hz updates would visibly stairstep.
// Inventory / equipment / HP land in Phase 4.
function serializePlayer(conn) {
  const p = conn.player;
  return {
    playerId: conn.playerId,
    name: conn.name,
    index: p.index,
    x: p.x,
    y: p.y,
    tileX: p.tileX,
    tileY: p.tileY,
    direction: p.direction,
    moving: p.moving,
    sheetId: p.sheetId,
    baseFrame: p.baseFrame,
    frameCount: p.frameCount,
    frameIndex: p.frameIndex,
    step: p.step,
  };
}
