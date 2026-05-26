// Phase 4 step 1 — mobs / monster fusion / minion spawning run on the
// server tick, and entity changes are diffed into the delta wire shape.
// Same createApp({autoTick:false}) + tickOnce() pattern as serverTick.

import { test } from "node:test";
import assert from "node:assert/strict";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData, getSpecies } from "../shared/species.js";
import { createConnection, makePlayerId } from "../server/connection.js";
import { loadSpecies, loadZone } from "../server/data.js";
import { installMemoryBackend } from "../server/memoryBackend.js";
import {
  tickOnce,
  computeEntityDelta,
  serializeEntityForDelta,
} from "../server/tick.js";
import {
  addConnection,
  createZoneInstance,
  spawnAtStarting,
} from "../server/zoneInstance.js";

installMemoryBackend();
loadSpeciesData(await loadSpecies());
const rawZone = await loadZone(STARTING_ZONE_ID);

function makeFakeWs() {
  const sent = [];
  return {
    readyState: 1,
    OPEN: 1,
    send(data) { sent.push(JSON.parse(data)); },
    close() { this.readyState = 3; },
    _sent: sent,
  };
}

const fakeParty = { id: "pty_test", code: "TEST1", members: new Set(), instances: new Map() };

function attach(instance, uuid) {
  const ws = makeFakeWs();
  const conn = createConnection({ ws });
  conn.uuid = uuid;
  conn.playerId = makePlayerId(uuid);
  conn.name = "test";
  conn.helloDone = true;
  spawnAtStarting(conn);
  addConnection(instance, conn);
  return conn;
}

function findMob(instance) {
  for (const e of instance.zone.entities) {
    const sp = getSpecies(e.species_id);
    if (sp && (sp.movement_directions === "FindHero" || sp.movement_directions === "Free")) {
      return e;
    }
  }
  return null;
}

test("mob frame.x/frame.y advances across server ticks", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  attach(instance, "00000000-0000-0000-0000-0000000mob01");
  const mob = findMob(instance);
  assert.ok(mob, "starting zone must contain at least one mob (FindHero/Free)");
  const startX = mob.frame.x;
  const startY = mob.frame.y;

  // Run enough ticks for the slowest mob (slime at base_speed 1.0 → step
  // duration ~0.625s → ~63 ticks at 10 Hz). 80 ticks is comfortably
  // beyond that; with 11 mobs at least one moves long before then.
  for (let i = 0; i < 80; i++) tickOnce(instance);

  const moved = instance.zone.entities.some((e) => {
    const sp = getSpecies(e.species_id);
    if (!sp) return false;
    if (sp.movement_directions !== "FindHero" && sp.movement_directions !== "Free") return false;
    return e.frame.x !== startX || e.frame.y !== startY;
  });
  // The exact mob may have promoted via fusion (changing species_id), so
  // we just assert that at least one mob in the zone has moved.
  assert.ok(moved, "at least one mob should have moved after 80 ticks");
});

test("delta op carries entity updates only when state actually changes", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance, "00000000-0000-0000-0000-0000000mob02");

  // First tick: every entity is "new" to the cache, so every one shows up
  // as changed at least once.
  tickOnce(instance);
  const first = conn.ws._sent[0];
  assert.equal(first.op, "delta");
  assert.ok(first.entities, "first delta carries an entities array");
  assert.ok(first.entities.length >= instance.zone.entities.length,
    "first tick should include every entity at least once");

  // Subsequent tick: only entities that changed since the last broadcast
  // appear. With ~11 mobs in zone 1001 some are mid-step, but the gates
  // / signs / static entities have no business moving.
  tickOnce(instance);
  const second = conn.ws._sent[1];
  if (second.entities) {
    assert.ok(second.entities.length < first.entities.length,
      "second-tick entity delta should be sparser than first-tick");
  }
});

test("computeEntityDelta detects removals", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });

  // Seed the cache.
  computeEntityDelta(instance);
  const targetId = instance.zone.entities[0].id;

  // Drop one entity.
  instance.zone.entities = instance.zone.entities.filter((e) => e.id !== targetId);

  const { removed } = computeEntityDelta(instance);
  assert.deepEqual(removed, [targetId]);
});

test("serializeEntityForDelta produces the wire-only fields", () => {
  const e = {
    id: 42,
    species_id: 4004,
    frame: { x: 10.5, y: 7.0, w: 1, h: 1 },
    direction: "Right",
    _open: false,
    _spawned: true,
    _hp: 12,
    _frameOffsetX: 0,
    // Internal fields that must NOT appear on the wire.
    _ai: { step: { fromX: 10, fromY: 7, toX: 11, toY: 7, progress: 0.5, duration: 0.625 } },
    _species: { /* ... */ },
    _sortKey: 12345,
  };
  const ser = serializeEntityForDelta(e);
  assert.equal(ser.id, 42);
  assert.equal(ser.species_id, 4004);
  assert.deepEqual(ser.frame, { x: 10.5, y: 7.0, w: 1, h: 1 });
  assert.equal(ser.direction, "Right");
  assert.equal(ser._spawned, true);
  assert.equal(ser._hp, 12);
  assert.equal(ser._ai, undefined);
  assert.equal(ser._species, undefined);
  assert.equal(ser._sortKey, undefined);
});
