// Phase 4 step 4 — server-authoritative per-player equipment + auto-equip
// on weapon pickup + bullet spawn on shoot intent. Uses the
// createZoneInstance + tickOnce pattern (same as serverCombat /
// serverPickups) so the test can plant entities under exact tiles and
// observe the resulting state without WS overhead.

import { test } from "node:test";
import assert from "node:assert/strict";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData, getSpecies } from "../shared/species.js";
import { SLOT_RANGED, SLOT_MELEE, DEFAULT_RANGED_WEAPON_ID, getEquipped } from "../shared/equipment.js";
import { createConnection, makePlayerId } from "../server/connection.js";
import { loadSpecies, loadZone } from "../server/data.js";
import { installMemoryBackend } from "../server/memoryBackend.js";
import { installServerCombatHealth } from "../server/combatHealthBackend.js";
import { installServerInventoryBackend } from "../server/inventoryBackend.js";
import { installServerEquipmentBackend } from "../server/equipmentBackend.js";
import { installServerPickupHandlers } from "../server/pickupHandlers.js";
import { tickOnce } from "../server/tick.js";
import { addConnection, createZoneInstance, snapshotZone } from "../server/zoneInstance.js";

installMemoryBackend();
installServerCombatHealth();
installServerInventoryBackend();
installServerEquipmentBackend();
installServerPickupHandlers();
loadSpeciesData(await loadSpecies());
const rawZone = await loadZone(STARTING_ZONE_ID);

const fakeParty = { id: "pty_eq", code: "EQP01", members: new Set(), instances: new Map() };

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
  const uuid = `00000000-0000-0000-0000-equipme${String(++connSeq).padStart(2, "0")}`;
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

test("new connection starts with the default ranged weapon equipped", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  assert.equal(getEquipped(SLOT_RANGED, conn.player), DEFAULT_RANGED_WEAPON_ID,
    "default ranged = kunai launcher");
  assert.equal(getEquipped(SLOT_MELEE, conn.player), null, "no melee until pickup");
  assert.equal(conn.player.equipment[SLOT_RANGED], DEFAULT_RANGED_WEAPON_ID);
  assert.equal(conn.player.equipment[SLOT_MELEE], null);
});

test("two connections keep independent equipment slots", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const a = attach(instance);
  const b = attach(instance);
  // A grabs an AR15 (species 1154) directly via the equipment backend;
  // B stays on the default. The backends should not collide via
  // shared storage (legacy backend would write to player.0.equipped.ranged
  // and both conns would see the same value).
  a.player.equipment[SLOT_RANGED] = 1154;
  assert.equal(getEquipped(SLOT_RANGED, a.player), 1154);
  assert.equal(getEquipped(SLOT_RANGED, b.player), DEFAULT_RANGED_WEAPON_ID);
});

test("weapon pickup auto-equips into the right slot and emits event:equip", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  placeAt(conn, 30, 30);
  // 1164 = sword pickup (associated_weapon = 1159 sword melee).
  instance.zone.entities.push({
    id: -55_001,
    species_id: 1164,
    frame: { x: 30, y: 30, w: 1, h: 2 },
    is_consumable: false,
    dialogues: [],
    direction: "Down",
  });

  tickOnce(instance);

  assert.equal(conn.player.equipment[SLOT_MELEE], 1159, "sword equipped into melee slot");
  // Pickup event also fired.
  const pickupEvents = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "pickup");
  const equipEvents = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "equip");
  assert.equal(pickupEvents.length, 1);
  assert.equal(pickupEvents[0].speciesId, 1164);
  assert.equal(equipEvents.length, 1);
  assert.equal(equipEvents[0].slot, SLOT_MELEE);
  assert.equal(equipEvents[0].speciesId, 1159);
  assert.equal(equipEvents[0].playerId, conn.playerId);
});

test("snapshot serializes player equipment", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  conn.player.equipment[SLOT_MELEE] = 1159;
  const snap = snapshotZone(instance);
  const me = snap.players.find((p) => p.playerId === conn.playerId);
  assert.equal(me.equipment[SLOT_RANGED], DEFAULT_RANGED_WEAPON_ID);
  assert.equal(me.equipment[SLOT_MELEE], 1159);
  // Defensive copy: mutating the snapshot doesn't bleed back into the
  // live player.
  me.equipment[SLOT_RANGED] = 99999;
  assert.equal(conn.player.equipment[SLOT_RANGED], DEFAULT_RANGED_WEAPON_ID);
});

test("shoot intent spawns a bullet pointed in the player's direction", async () => {
  // Drive shoot() directly with a controlled mini-zone (avoiding the live
  // zone-1001 tile layout where the bullet might happen to spawn on a
  // forest tile and get culled inside the same tick by tickCombat).
  const { shoot } = await import("../shared/shooting.js");
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  conn.player.direction = "right";
  conn.player.inventory[7000] = 1;

  const before = instance.zone.entities.length;
  shoot({ zone: instance.zone, player: conn.player }, conn.player);
  const after = instance.zone.entities.length;
  assert.equal(after, before + 1, "exactly one new entity (the bullet)");

  const spawned = instance.zone.entities.filter((e) => e._spawned);
  const myBullet = spawned.find((e) => e._playerOwner === conn.player);
  assert.ok(myBullet, "spawned bullet carries _playerOwner = shooter for catcher routing");
  assert.equal(myBullet.species_id, 7000, "default ranged weapon fires kunai bullets");
  assert.equal(myBullet.direction, "Right");
  assert.equal(conn.player.inventory[7000], 0, "ammo decremented");
});

test("equipped shield halves continuous damage taken on the server", async () => {
  // Shield (1171) carries received_damage_reduction = 0.5. With it equipped
  // on A only, A and B standing next to the same melee monster should bleed
  // out at different rates — A's HP should be strictly higher than B's
  // after a few damage ticks.
  const { tickCombat } = await import("../shared/combat.js");
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const a = attach(instance);
  const b = attach(instance);
  a.player.equipment[SLOT_MELEE] = 1171;

  // Find a real CloseCombatMonster in the zone and put both players on it
  // so tickCombat's resolveMeleeMonsters lands continuous damage on each.
  const mob = instance.zone.entities.find((e) => {
    const sp = getSpecies(e.species_id);
    return sp && sp.entity_type === "CloseCombatMonster";
  });
  assert.ok(mob, "starting zone has a CloseCombatMonster");
  const msp = getSpecies(mob.species_id);
  const px = Math.floor(mob.frame.x);
  const py = Math.floor(mob.frame.y) + (msp.height ? msp.height - 1 : 0);
  for (const p of [a.player, b.player]) {
    p.x = px; p.y = py; p.tileX = px; p.tileY = py;
  }
  // Mark the mob visible so resolveMeleeMonsters processes it (the live
  // zone's visibility pass isn't run server-side).
  mob._visible = true;

  // Drive a few combat ticks directly (10 Hz dt).
  for (let i = 0; i < 3; i++) {
    tickCombat(instance.zone, [a.player, b.player], 0.1);
  }

  assert.ok(a.player.hp > b.player.hp,
    `A (shielded ${a.player.hp}) should take less damage than B (${b.player.hp})`);
  assert.ok(b.player.hp < 100, "B definitely took damage");
});
