// A live (zoneId, partyId) instance. Each party owns at most one instance
// per zone they've entered. Lazily created when the first member enters
// the zone; kept warm for IDLE_DROP_MS after the last member leaves so
// brief detours (open a door, look around, come back) don't reset state.
//
// The instance registry (createInstanceRegistry below) routes lookups by
// (zoneId, partyId) and drives the warm-idle drop timer. The tick driver
// (tick.js) iterates the registry's live instances.

import { STARTING_SPAWN } from "../shared/constants.js";
import { buildZone } from "../shared/zone.js";
import { findTeleporterAt, resolveSpawn, movePlayerTo } from "../shared/transitions.js";

export const IDLE_DROP_MS = 60_000;

export function createInstanceRegistry({ loadRawZone }) {
  // Map<`${zoneId}|${partyId}`, ZoneInstance>
  const live = new Map();
  // Map<key, Promise<ZoneInstance>> — in-flight creates so two concurrent
  // travels from the same party don't each build their own instance and
  // diverge. Phase 2 didn't hit this; Phase 3's two-traveler flow does.
  const pending = new Map();

  function key(zoneId, partyId) { return `${zoneId}|${partyId}`; }

  function getOrCreate(zoneId, party) {
    const k = key(zoneId, party.id);
    const existing = live.get(k);
    if (existing) {
      if (existing._dropTimer) {
        clearTimeout(existing._dropTimer);
        existing._dropTimer = null;
      }
      return Promise.resolve(existing);
    }
    if (pending.has(k)) return pending.get(k);
    const promise = (async () => {
      const rawZone = await loadRawZone(zoneId);
      const instance = createZoneInstance({ rawZone, zoneId, party });
      live.set(k, instance);
      party.instances.set(zoneId, instance);
      pending.delete(k);
      return instance;
    })();
    pending.set(k, promise);
    return promise;
  }

  function scheduleDrop(instance) {
    if (instance.connections.size > 0) return;
    if (instance._dropTimer) return;
    instance._dropTimer = setTimeout(() => {
      live.delete(key(instance.zone.id, instance.party.id));
      instance.party.instances.delete(instance.zone.id);
      instance._dropTimer = null;
      instance._dropped = true;
    }, IDLE_DROP_MS);
    instance._dropTimer.unref?.();
  }

  function liveInstances() { return live.values(); }

  function size() { return live.size; }

  return { getOrCreate, scheduleDrop, liveInstances, size, _live: live };
}

export function createZoneInstance({ rawZone, zoneId, party }) {
  const zone = buildZone(rawZone);
  return {
    rawZone,
    zone,
    party,
    tick: 0,
    connections: new Map(),
    _dropTimer: null,
    _dropped: false,
    partyGone: false,
  };
}

export function addConnection(instance, conn) {
  instance.connections.set(conn.id, conn);
  if (instance._dropTimer) {
    clearTimeout(instance._dropTimer);
    instance._dropTimer = null;
  }
  conn.zoneInstance = instance;
}

export function removeConnection(instance, conn) {
  instance.connections.delete(conn.id);
  if (conn.zoneInstance === instance) conn.zoneInstance = null;
}

// Place a player at a known tile in this instance. The fresh-spawn case
// (Phase 2's only path) uses STARTING_SPAWN; travel paths pass an
// explicit tile resolved by resolveSpawn().
export function placePlayer(conn, tileX, tileY, direction) {
  movePlayerTo(conn.player, tileX, tileY, direction);
}

export function spawnAtStarting(conn) {
  placePlayer(conn, STARTING_SPAWN.x, STARTING_SPAWN.y, "down");
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

// Resolve the destination tile in a target zone for a player coming from
// a teleporter in `sourceInstance`. Mirrors client/transitions.js's logic:
// destinations stored as (0, 0) trigger the "find the back-teleporter"
// fallback in shared/transitions.resolveSpawn; explicit destinations are
// bumped by one tile in Y so the player lands in front of the door
// instead of on top of it.
export function resolveTravelSpawn(destZone, destination, sourceZoneId) {
  const dx = destination?.x ?? 0;
  const dy = destination?.y ?? 0;
  const bumped = (dx === 0 && dy === 0)
    ? { ...destination }
    : { ...destination, y: dy + 1 };
  return resolveSpawn(destZone, bumped, sourceZoneId);
}

// Look up the teleporter at a player's current tile. Returns the entity
// object (with `id`, `destination`, etc.) or null.
export function teleporterUnderFoot(instance, conn) {
  return findTeleporterAt(instance.zone, conn.player.tileX, conn.player.tileY);
}
