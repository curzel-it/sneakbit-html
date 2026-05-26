// Drives tickOnce() directly with simulated input intents and verifies
// the player position advances exactly the way the shared movement model
// expects when fed through the server's connection input queue. Pure unit
// test — no WebSocket, no timers, no http.

import { test } from "node:test";
import assert from "node:assert/strict";

import { STARTING_SPAWN, STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData } from "../shared/species.js";
import { createConnection, applyInputIntent, makePlayerId } from "../server/connection.js";
import { loadSpecies, loadZone } from "../server/data.js";
import { installMemoryBackend } from "../server/memoryBackend.js";
import { tickOnce, TICK_MS } from "../server/tick.js";
import { addConnection, createZoneInstance, spawnAtStarting } from "../server/zoneInstance.js";

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

test("an idle instance with no connections does no work", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  tickOnce(instance);
  assert.equal(instance.tick, 0);
});

test("input intent advances player position over multiple ticks", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance, "00000000-0000-0000-0000-000000000010");
  assert.equal(conn.player.tileX, STARTING_SPAWN.x);
  assert.equal(conn.player.tileY, STARTING_SPAWN.y);

  // Press right; movement.js rotates first then commits after a hold timer.
  // Subsequent ticks with the key held keep stepping; one step takes a few
  // ticks at TICK_MS dt because step duration is ~220ms.
  applyInputIntent(conn, "moveRight");
  // Run enough ticks for at least one full tile of movement.
  const ticksToRun = Math.ceil((0.22 + 0.06) / (TICK_MS / 1000)) + 1;
  for (let i = 0; i < ticksToRun; i++) tickOnce(instance);

  assert.equal(conn.player.direction, "right");
  assert.ok(
    conn.player.tileX > STARTING_SPAWN.x,
    `expected tileX > ${STARTING_SPAWN.x}, got ${conn.player.tileX}`,
  );
});

test("each tick broadcasts a delta to every connection in the instance", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const a = attach(instance, "00000000-0000-0000-0000-00000000aaaa");
  const b = attach(instance, "00000000-0000-0000-0000-00000000bbbb");

  tickOnce(instance);

  assert.equal(a.ws._sent.length, 1);
  assert.equal(b.ws._sent.length, 1);
  const frame = a.ws._sent[0];
  assert.equal(frame.op, "delta");
  assert.equal(frame.tick, 1);
  assert.equal(frame.players.length, 2);
  const ids = frame.players.map((p) => p.playerId).sort();
  assert.deepEqual(ids, [a.playerId, b.playerId].sort());
});

test("stopMove clears the held set so chaining halts after the in-flight step", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance, "00000000-0000-0000-0000-00000000ccc1");

  applyInputIntent(conn, "moveRight");
  for (let i = 0; i < 5; i++) tickOnce(instance);
  applyInputIntent(conn, "stopMove");

  // Run plenty of ticks; player must eventually become idle (step null, no
  // queued direction).
  for (let i = 0; i < 20; i++) tickOnce(instance);

  assert.equal(conn.input.held.size, 0);
  assert.equal(conn.player.step, null);
});
