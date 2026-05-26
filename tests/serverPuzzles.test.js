// Phase 4 step 5 — server-authoritative puzzles + pushables + gate
// unlocks. Tests run against synthetic mini-zones so the assertions
// pin behavior rather than depending on whichever exact puzzle is
// placed in zone 1001.

import { test } from "node:test";
import assert from "node:assert/strict";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData, getSpecies } from "../shared/species.js";
import { createConnection, makePlayerId } from "../server/connection.js";
import { loadSpecies, loadZone } from "../server/data.js";
import { installMemoryBackend } from "../server/memoryBackend.js";
import { installServerCombatHealth } from "../server/combatHealthBackend.js";
import { installServerInventoryBackend } from "../server/inventoryBackend.js";
import { installServerEquipmentBackend } from "../server/equipmentBackend.js";
import { installServerPickupHandlers } from "../server/pickupHandlers.js";
import { installServerPuzzleBackend, withPuzzleContext } from "../server/puzzleBackend.js";
import { installServerGateUnlockHandlers } from "../server/gateUnlockHandlers.js";
import { tickOnce } from "../server/tick.js";
import { addConnection, createZoneInstance } from "../server/zoneInstance.js";
import { isPressurePlateDown } from "../shared/locks.js";

installMemoryBackend();
installServerCombatHealth();
installServerInventoryBackend();
installServerEquipmentBackend();
installServerPickupHandlers();
installServerPuzzleBackend();
installServerGateUnlockHandlers();
loadSpeciesData(await loadSpecies());
const rawZone = await loadZone(STARTING_ZONE_ID);

const fakeParty = { id: "pty_puzzle", code: "PUZ01", members: new Set(), instances: new Map() };

function makeFakeWs() {
  const sent = [];
  return { readyState: 1, OPEN: 1,
    send(d) { sent.push(JSON.parse(d)); },
    close() { this.readyState = 3; }, _sent: sent };
}

let connSeq = 0;
function attach(instance) {
  const ws = makeFakeWs();
  const conn = createConnection({ ws });
  const uuid = `00000000-0000-0000-0000-puzzles${String(++connSeq).padStart(2, "0")}`;
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

// Find a yellow gate species (entity_type = Gate) and a yellow plate
// (PressurePlate). Live zone 1001 doesn't include a colored pressure
// plate, so we plant our own using the species table.
function plantPlate(instance, tx, ty, lockColor = "Yellow") {
  const sp = [...rawZone.entities, ...instance.zone.entities].map(e => getSpecies(e.species_id))
    .find(s => s?.entity_type === "PressurePlate");
  if (!sp) throw new Error("no PressurePlate species in loaded data");
  const e = {
    id: -77_000 - Math.floor(Math.random() * 1000),
    species_id: sp.id,
    frame: { x: tx, y: ty, w: 1, h: 1 },
    is_consumable: false,
    is_rigid: false,
    lock_type: lockColor,
    dialogues: [],
    direction: "Down",
  };
  instance.zone.entities.push(e);
  return e;
}

function plantGate(instance, tx, ty, lockColor = "Yellow", inverse = false) {
  const sp = [...rawZone.entities, ...instance.zone.entities]
    .map(e => getSpecies(e.species_id))
    .find(s => s?.entity_type === (inverse ? "InverseGate" : "Gate"));
  if (!sp) throw new Error(`no ${inverse ? "InverseGate" : "Gate"} species in loaded data`);
  const e = {
    id: -78_000 - Math.floor(Math.random() * 1000),
    species_id: sp.id,
    frame: { x: tx, y: ty, w: 1, h: 2 },
    is_consumable: false,
    lock_type: lockColor,
    dialogues: [],
    direction: "Down",
  };
  instance.zone.entities.push(e);
  return e;
}

test("pressure plate goes down when player stands on it, back up when they leave", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  const plate = plantPlate(instance, 20, 20, "Yellow");
  placeAt(conn, 50, 50);

  tickOnce(instance);
  assert.equal(plate._frameOffsetX, 0, "plate up when nobody stands on it");
  // Read inside the context so the per-instance backend resolves.
  let down1 = false;
  withPuzzleContext(instance, () => { down1 = isPressurePlateDown("Yellow"); });
  assert.equal(down1, false);

  placeAt(conn, 20, 20);
  tickOnce(instance);
  assert.equal(plate._frameOffsetX, 1, "plate down once player stands on it");
  let down2 = false;
  withPuzzleContext(instance, () => { down2 = isPressurePlateDown("Yellow"); });
  assert.equal(down2, true);

  placeAt(conn, 50, 50);
  tickOnce(instance);
  assert.equal(plate._frameOffsetX, 0, "plate pops up when the player leaves");
});

test("gate opens when its matching plate is pressed (and only then)", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  const plate = plantPlate(instance, 21, 21, "Red");
  const gate  = plantGate(instance, 25, 25, "Red");

  placeAt(conn, 50, 50);
  tickOnce(instance);
  assert.equal(gate._open, false, "gate closed when plate is up");

  placeAt(conn, 21, 21);
  tickOnce(instance);
  assert.equal(gate._open, true, "gate opens when matching-color plate is pressed");
  assert.equal(gate._frameOffsetX, 1, "gate sprite shifts right");
});

test("two parties keep independent plate state in the same zone", () => {
  const partyB = { id: "pty_puz_b", code: "PUZ02", members: new Set(), instances: new Map() };
  const aInst = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const bInst = createZoneInstance({ rawZone, zoneId: rawZone.id, party: partyB });
  const aConn = attach(aInst);
  const bConn = attach(bInst);
  const aPlate = plantPlate(aInst, 30, 30, "Blue");
  const bPlate = plantPlate(bInst, 30, 30, "Blue");

  placeAt(aConn, 30, 30);
  placeAt(bConn, 50, 50);
  tickOnce(aInst);
  tickOnce(bInst);

  assert.equal(aPlate._frameOffsetX, 1, "A's plate is down (A on it)");
  assert.equal(bPlate._frameOffsetX, 0, "B's plate is up — not bled from A's instance");
});

test("walking into a yellow gate with a yellow key spends the key, opens, and emits event:gateUnlocked", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  // Place player just east of a gate so a moveLeft intent will try to
  // step onto the gate's tile and trigger the unlock path.
  placeAt(conn, 26, 25);
  const gate = plantGate(instance, 25, 25, "Yellow");
  // Yellow key species = 2000.
  conn.player.inventory[2000] = 1;
  // Issue a moveLeft intent and tick once — updatePlayer's pendingDir
  // model needs the held set + commit delay, so we tick a few times.
  conn.input.events.push("left");
  conn.input.held.add("left");
  for (let i = 0; i < 5; i++) tickOnce(instance);

  assert.equal(gate._open, true, "gate is now open");
  assert.equal(conn.player.inventory[2000] ?? 0, 0, "key consumed");

  const unlockEvents = conn.ws._sent.filter(m => m.op === "event" && m.kind === "gateUnlocked");
  assert.equal(unlockEvents.length, 1, "one event:gateUnlocked broadcast");
  assert.equal(unlockEvents[0].playerId, conn.playerId);
  assert.equal(unlockEvents[0].lock, "Yellow");
  assert.equal(unlockEvents[0].gateId, gate.id);
});

test("pushable slide animation decays across ticks", async () => {
  const { startSlide } = await import("../shared/pushables.js");
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  attach(instance);
  // Plant a pushable-like entity carrying _slide; tickPushables decays
  // it. We don't shove it through player movement — that's a player.js
  // path tested elsewhere.
  const rock = {
    id: -99_001,
    species_id: getSpecies(1003)?.id ?? 1003, // pushable species id; if missing the slide-only assertion still works
    frame: { x: 5, y: 5, w: 1, h: 1 },
    is_consumable: false,
    dialogues: [],
    direction: "Down",
  };
  instance.zone.entities.push(rock);
  startSlide(rock, 1, 0);
  assert.ok(rock._slide, "_slide assigned");
  // Run a handful of ticks; with DT=0.1 and SLIDE_DURATION=0.22 the slide
  // wraps in ~3 ticks.
  for (let i = 0; i < 4; i++) tickOnce(instance);
  assert.ok(!rock._slide, "_slide cleared after the duration");
});
