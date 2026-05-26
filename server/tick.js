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
import { tickCombat } from "../shared/combat.js";
import { shoot, tickShooting } from "../shared/shooting.js";
import { performMeleeSwing, tickMelee } from "../shared/melee.js";
import { checkPickup } from "../shared/pickups.js";
import { tickPushables } from "../shared/pushables.js";
import { tickPuzzles } from "../shared/puzzles.js";
import { tickServerPlayerHealth, resetPlayerHealth } from "./combatHealthBackend.js";
import { withPickupContext } from "./pickupHandlers.js";
import { withPuzzleContext } from "./puzzleBackend.js";
import { withGateUnlockContext } from "./gateUnlockHandlers.js";
import { placePlayer } from "./zoneInstance.js";

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

  const allConns = [...instance.connections.values()];
  // "Live" = not dead and not ghosted. Dead/ghosted player entities stay
  // visible (frozen) in the broadcast but skip movement, combat, and
  // action drains. Ghost grace lands in commit D — until then
  // ghostExpiresAt is always falsy so the filter just gates on `dead`.
  const liveConns = allConns.filter(c => !c.dead && !c.ghostExpiresAt);
  const livePlayers = liveConns.map(c => c.player);

  // Per-tick event queue. Pickup, equip, and gate-unlock handlers all
  // append here while their `with*Context` wraps are active; the drain
  // at the end of the tick collects them. Reset *before* any movement
  // happens so events queued mid-tick survive to the broadcast.
  instance._pendingPickupEvents = [];

  // 1. Movement. Wrapped in withGateUnlockContext so that if a player
  // walks into a colored gate while holding a matching key, the unlock
  // event lands on this instance's queue (and through that on the right
  // party member's WS).
  withGateUnlockContext(instance, () => {
    for (const conn of liveConns) {
      updatePlayer(conn.player, conn.input, DT, instance.zone);
      conn.input.events.length = 0;
    }
  });

  // 2. Drain shoot / melee actions for each live conn against its instance
  // zone. shoot() / performMeleeSwing() spawn bullet entities into
  // instance.zone.entities; combat resolves the hits two steps later.
  for (const conn of liveConns) {
    if (!conn.input.actions.length) continue;
    const state = { zone: instance.zone, player: conn.player };
    while (conn.input.actions.length) {
      const action = conn.input.actions.shift();
      if (action === "shoot") shoot(state, conn.player);
      else if (action === "melee") performMeleeSwing(state, { swinger: conn.player });
    }
  }

  // 3. Cooldowns, bullet advance, regen / invuln decay.
  tickMelee(DT, livePlayers);
  tickShooting(DT, { zone: instance.zone, players: livePlayers });
  tickServerPlayerHealth(DT, livePlayers);

  // 4. Mob AI / fusion / minion spawning. Aggro target = first live player
  // (Phase 4 step 1 picked firstPlayer; same v0 compromise, just filtered
  // for live).
  const primary = livePlayers[0] ?? null;
  if (primary) {
    tickMobs(instance.zone, primary, DT);
    tickMonsterFusion(instance.zone);
    tickMinionSpawning(instance.zone, primary, DT);
  }
  tickEntities(DT);

  // 5. Combat — bullets vs entities, bullets vs players, melee monsters
  // vs all live players.
  tickCombat(instance.zone, livePlayers, DT);

  // 6. Pickups: live players standing on auto-collect entities collect
  // them. `withPickupContext` makes the per-instance pickup queue visible
  // to the shared module's onPickup handler — that handler appends one
  // entry per (player, species, amount) write, which we drain into the
  // event broadcast below.
  withPickupContext(instance, () => {
    checkPickup({ zone: instance.zone, players: livePlayers });
  });

  // 6b. Puzzles + pushables. Pressure plates compute their `down` flag
  // from any live player or pushable on the plate; gates derive from the
  // matching plate's state. Pushables advance their slide animation
  // (frame.x/y already committed at push-time, this only ticks the
  // visual offset). withPuzzleContext routes pressure-plate reads/writes
  // through the per-instance backend so two parties don't see each
  // other's plate state.
  withPuzzleContext(instance, () => {
    const primary = livePlayers[0] ?? null;
    if (primary) tickPuzzles(instance.zone, primary);
  });
  tickPushables(instance.zone, DT);

  // 7. Detect newly-dead conns and process respawn requests. Events are
  // queued and broadcast after the delta so clients see the death/respawn
  // *with* the position state that caused it.
  const events = [];
  for (const conn of allConns) {
    if (conn.dead) continue;
    if (conn.player.hp != null && conn.player.hp <= 0) {
      conn.dead = true;
      conn.input.held.clear();
      conn.input.actions.length = 0;
      events.push({ op: "event", kind: "death", playerId: conn.playerId });
    }
  }
  for (const conn of allConns) {
    if (!conn.dead || !conn.input.respawnRequested) continue;
    conn.input.respawnRequested = false;
    resetPlayerHealth(conn.player);
    conn.dead = false;
    const sp = instance.zone.spawnPoint ?? { x: 0, y: 0 };
    placePlayer(conn, sp.x, sp.y, "down");
    events.push({
      op: "event",
      kind: "respawn",
      playerId: conn.playerId,
      zoneId: instance.zone.id,
      x: sp.x,
      y: sp.y,
    });
  }

  // Drain pickup + auto-equip events queued during checkPickup. Each
  // entry is already a full event frame (kind === "pickup" or "equip").
  for (const ev of instance._pendingPickupEvents) events.push(ev);
  instance._pendingPickupEvents.length = 0;

  instance.tick += 1;

  const entityDelta = computeEntityDelta(instance);
  const payload = {
    op: "delta",
    tick: instance.tick,
    players: allConns.map(serializePlayerDelta),
  };
  if (entityDelta.changed.length > 0) payload.entities = entityDelta.changed;
  if (entityDelta.removed.length > 0) payload.removed = { entities: entityDelta.removed };

  const frame = JSON.stringify(payload);
  for (const conn of allConns) {
    if (conn.ws.readyState !== conn.ws.OPEN) continue;
    conn.ws.send(frame);
  }
  for (const ev of events) {
    const evFrame = JSON.stringify(ev);
    for (const conn of allConns) {
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      conn.ws.send(evFrame);
    }
  }
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
    hp: p.hp,
    hpMax: p.hpMax,
    dead: !!conn.dead,
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
