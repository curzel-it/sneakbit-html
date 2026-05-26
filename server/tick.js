// 10 Hz tick driver. One setInterval iterates every live zone instance
// in the registry and ticks the ones with at least one connected member.
// Idle instances (no connected members) are skipped so they cost zero CPU.
// Empty instances stay in the registry for IDLE_DROP_MS — the registry
// drops them when their timer expires.
//
// Phase 4 step 1 added mob AI, monster fusion, and minion spawning to the
// per-instance tick alongside the existing player update. Entity deltas
// are diffed against the last broadcast so the wire payload stays small
// when nothing moved.

import { updatePlayer } from "../shared/player.js";
import { tickMobs } from "../shared/mobs.js";
import { tickMonsterFusion } from "../shared/monsters.js";
import { tickMinionSpawning } from "../shared/minions.js";
import { tickEntities } from "../shared/entities.js";

export const TICK_HZ = 10;
export const TICK_MS = 1000 / TICK_HZ;
const DT = TICK_MS / 1000;

export function startTick(registry) {
  const handle = setInterval(() => tickAll(registry), TICK_MS);
  // Don't keep the event loop alive solely for the tick — letting Ctrl-C
  // shut down promptly matters more than guaranteeing one last tick.
  handle.unref?.();
  return () => clearInterval(handle);
}

export function tickAll(registry) {
  for (const instance of registry.liveInstances()) {
    if (instance.connections.size === 0) continue;
    tickOnce(instance);
  }
}

export function tickOnce(instance) {
  if (instance.connections.size === 0) return;

  for (const conn of instance.connections.values()) {
    updatePlayer(conn.player, conn.input, DT, instance.zone);
    // `events` is edge-triggered: per-tick presses. `held` is sticky and
    // is cleared only by an explicit stopMove (or a future per-direction
    // release op).
    conn.input.events.length = 0;
  }

  // For mob AI / minion spawning we need a single "aggro target." v0 picks
  // the first connected player; a real picker (nearest member, threat
  // table, etc.) is a Phase 4.x concern. With one connection this is
  // exactly the offline behaviour.
  const primary = firstPlayer(instance);
  if (primary) {
    tickMobs(instance.zone, primary, DT);
    tickMonsterFusion(instance.zone);
    tickMinionSpawning(instance.zone, primary, DT);
  }
  tickEntities(DT);

  instance.tick += 1;

  const entityDelta = computeEntityDelta(instance);
  const payload = {
    op: "delta",
    tick: instance.tick,
    players: [...instance.connections.values()].map(serializePlayerDelta),
  };
  if (entityDelta.changed.length > 0) payload.entities = entityDelta.changed;
  if (entityDelta.removed.length > 0) payload.removed = { entities: entityDelta.removed };

  const frame = JSON.stringify(payload);
  for (const conn of instance.connections.values()) {
    if (conn.ws.readyState !== conn.ws.OPEN) continue;
    conn.ws.send(frame);
  }
}

function firstPlayer(instance) {
  for (const conn of instance.connections.values()) return conn.player;
  return null;
}

function serializePlayerDelta(conn) {
  const p = conn.player;
  return {
    playerId: conn.playerId,
    x: p.x,
    y: p.y,
    tileX: p.tileX,
    tileY: p.tileY,
    direction: p.direction,
    moving: p.moving,
    frameIndex: p.frameIndex,
    step: p.step,
  };
}

// Per-entity wire shape. Render-only fields (frame, direction, _open,
// _spawned, _dying, _invisible, _frameOffsetX) plus species_id (fusion
// may promote a mob mid-tick) and _hp (combat lands in step 2 — wire it
// now so the shape doesn't change between steps).
export function serializeEntityForDelta(e) {
  const out = { id: e.id, species_id: e.species_id };
  if (e.frame) out.frame = { x: e.frame.x, y: e.frame.y, w: e.frame.w, h: e.frame.h };
  if (e.direction !== undefined && e.direction !== null) out.direction = e.direction;
  if (e._open) out._open = true;
  if (e._spawned) out._spawned = true;
  if (e._dying) out._dying = true;
  if (e._invisible) out._invisible = true;
  if (typeof e._frameOffsetX === "number" && e._frameOffsetX !== 0) {
    out._frameOffsetX = e._frameOffsetX;
  }
  if (typeof e._hp === "number") out._hp = e._hp;
  return out;
}

// Diff the current entity state against the instance's last broadcast.
// First call seeds the cache; everything is "changed" then. Subsequent
// calls return only entries whose serialized form differs, plus ids that
// disappeared from zone.entities (fusion removes the partner; future
// combat tick will mark dying mobs for removal).
export function computeEntityDelta(instance) {
  const prev = instance._lastEntitiesByJson ?? new Map();
  const next = new Map();
  const changed = [];

  for (const e of instance.zone.entities) {
    if (e.id == null) continue;
    const ser = serializeEntityForDelta(e);
    const json = JSON.stringify(ser);
    next.set(e.id, json);
    if (prev.get(e.id) !== json) changed.push(ser);
  }

  const removed = [];
  for (const id of prev.keys()) {
    if (!next.has(id)) removed.push(id);
  }

  instance._lastEntitiesByJson = next;
  return { changed, removed };
}
