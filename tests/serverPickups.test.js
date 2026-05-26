// Phase 4 step 3 — server-authoritative pickups + per-player inventory.
// Uses the createZoneInstance + tickOnce pattern (same as serverCombat/
// serverMobs) so the test can plant a pickup entity exactly under a
// player tile and observe the mutation without WS overhead.

import { test } from "node:test";
import assert from "node:assert/strict";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData } from "../shared/species.js";
import { createConnection, makePlayerId } from "../server/connection.js";
import { loadSpecies, loadZone } from "../server/data.js";
import { installMemoryBackend } from "../server/memoryBackend.js";
import { installServerCombatHealth } from "../server/combatHealthBackend.js";
import { installServerInventoryBackend } from "../server/inventoryBackend.js";
import { installServerPickupHandlers } from "../server/pickupHandlers.js";
import { tickOnce } from "../server/tick.js";
import { addConnection, createZoneInstance } from "../server/zoneInstance.js";

installMemoryBackend();
installServerCombatHealth();
installServerInventoryBackend();
installServerPickupHandlers();
loadSpeciesData(await loadSpecies());
const rawZone = await loadZone(STARTING_ZONE_ID);

const fakeParty = { id: "pty_pick", code: "PCK01", members: new Set(), instances: new Map() };

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

let connSeq = 0;
function attach(instance) {
  const ws = makeFakeWs();
  const conn = createConnection({ ws });
  const uuid = `00000000-0000-0000-0000-pickups${String(++connSeq).padStart(2, "0")}`;
  conn.uuid = uuid;
  conn.playerId = makePlayerId(uuid);
  conn.name = "test";
  conn.helloDone = true;
  addConnection(instance, conn);
  return conn;
}

function placeAt(conn, tx, ty) {
  conn.player.x = tx;
  conn.player.y = ty;
  conn.player.tileX = tx;
  conn.player.tileY = ty;
}

function plantKeyAt(instance, tx, ty, opts = {}) {
  // 2000 is "objects.name.key_yellow" — a PickableObject (auto-collect).
  // Putting an id under -1_000_000 so we don't collide with the live
  // entity ids; ephemeralState=false so the collected flag would persist
  // via shared/storage (no-op on the server memory backend).
  const entity = {
    id: opts.id ?? -42_000 + Math.floor(Math.random() * 1000),
    species_id: 2000,
    frame: { x: tx, y: ty, w: 1, h: 2 },
    is_consumable: false,
    dialogues: [],
    direction: "Down",
    ...opts.overrides,
  };
  instance.zone.entities.push(entity);
  return entity;
}

function plantBundleAt(instance, tx, ty) {
  // 7001 = "kunai.x10" Bundle expanding into 10 × species 7000.
  const entity = {
    id: -43_000 - Math.floor(Math.random() * 1000),
    species_id: 7001,
    frame: { x: tx, y: ty, w: 1, h: 1 },
    is_consumable: false,
    dialogues: [],
    direction: "Down",
  };
  instance.zone.entities.push(entity);
  return entity;
}

test("PickableObject under a live player is collected; event:pickup fires", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  placeAt(conn, 30, 30);
  const key = plantKeyAt(instance, 30, 30);

  tickOnce(instance);

  const stillThere = instance.zone.entities.some((e) => e === key);
  assert.equal(stillThere, false, "pickup despawned from zone.entities");
  assert.equal(conn.player.inventory[2000], 1, "inventory[2000] incremented to 1");

  const pickups = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "pickup");
  assert.equal(pickups.length, 1, "exactly one event:pickup broadcast");
  assert.equal(pickups[0].playerId, conn.playerId);
  assert.equal(pickups[0].speciesId, 2000);
  assert.equal(pickups[0].amount, 1);
});

test("Bundle expands into per-species pickup events", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  placeAt(conn, 35, 35);
  plantBundleAt(instance, 35, 35);

  tickOnce(instance);

  assert.equal(conn.player.inventory[7000], 10, "10 kunai added");
  const pickups = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "pickup");
  assert.equal(pickups.length, 1, "bundle collapses to a single event with amount=10");
  assert.equal(pickups[0].speciesId, 7000);
  assert.equal(pickups[0].amount, 10);
});

test("two players in the same instance keep independent inventories", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const a = attach(instance);
  const b = attach(instance);
  placeAt(a, 40, 40);
  placeAt(b, 41, 40);
  plantKeyAt(instance, 40, 40);
  plantKeyAt(instance, 41, 40);

  // Two ticks: first picks one (the loop returns after the first hit),
  // second picks the other.
  tickOnce(instance);
  tickOnce(instance);

  assert.equal(a.player.inventory[2000], 1, "A picked exactly one key");
  assert.equal(b.player.inventory[2000], 1, "B picked exactly one key");
  assert.notStrictEqual(a.player.inventory, b.player.inventory,
    "inventories are distinct objects");
  const aEvents = a.ws._sent.filter((m) => m.op === "event" && m.kind === "pickup");
  const bEvents = b.ws._sent.filter((m) => m.op === "event" && m.kind === "pickup");
  // The tick broadcasts events to every conn in the instance (so the party
  // sees each other's pickups), so each conn sees BOTH events. Just assert
  // the count is 2 on each side.
  assert.equal(aEvents.length, 2);
  assert.equal(bEvents.length, 2);
});

test("dead conn does not auto-pickup", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  conn.dead = true;
  conn.player.hp = 0;
  placeAt(conn, 45, 45);
  const key = plantKeyAt(instance, 45, 45);

  tickOnce(instance);

  assert.ok(instance.zone.entities.includes(key), "key still on the floor");
  assert.equal((conn.player.inventory ?? {})[2000] ?? 0, 0, "dead player banked nothing");
  const pickups = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "pickup");
  assert.equal(pickups.length, 0, "no event:pickup broadcast");
});

test("ghost (disconnected but still in conn map) does not pickup either", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  conn.ghostExpiresAt = Date.now() + 30_000;
  placeAt(conn, 46, 46);
  plantKeyAt(instance, 46, 46);

  tickOnce(instance);

  assert.equal((conn.player.inventory ?? {})[2000] ?? 0, 0, "ghost banked nothing");
});

test("snapshot serializes player inventory", async () => {
  const { snapshotZone } = await import("../server/zoneInstance.js");
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  conn.player.inventory[2000] = 3;
  conn.player.inventory[7000] = 7;
  const snap = snapshotZone(instance);
  const me = snap.players.find((p) => p.playerId === conn.playerId);
  assert.deepEqual(me.inventory, { 2000: 3, 7000: 7 });
  // Mutating the snapshot copy doesn't bleed into the live player.
  me.inventory[2000] = 999;
  assert.equal(conn.player.inventory[2000], 3);
});
