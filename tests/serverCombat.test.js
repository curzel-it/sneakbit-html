// Phase 4 step 2 — server-authoritative combat + death + respawn + ghost
// grace. Mixes the two server-test patterns:
//   * createApp({autoTick:false}) + tickOnce() — for combat/death/respawn
//     against a controlled in-zone setup (no WS overhead).
//   * real createApp + real WebSocket — for the ghost-grace reconnect
//     flow, which depends on actual WS close events.

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData, getSpecies } from "../shared/species.js";
import { setFriendlyFireGetter } from "../shared/combat.js";
import { createApp } from "../server/app.js";
import { createConnection, makePlayerId } from "../server/connection.js";
import { loadSpecies, loadZone } from "../server/data.js";
import { installMemoryBackend } from "../server/memoryBackend.js";
import { installServerCombatHealth } from "../server/combatHealthBackend.js";
import { tickOnce } from "../server/tick.js";
import { addConnection, createZoneInstance } from "../server/zoneInstance.js";

installMemoryBackend();
installServerCombatHealth();
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

const fakeParty = { id: "pty_combat", code: "CMB01", members: new Set(), instances: new Map() };

function attach(instance, uuid) {
  const ws = makeFakeWs();
  const conn = createConnection({ ws });
  conn.uuid = uuid;
  conn.playerId = makePlayerId(uuid);
  conn.name = "test";
  conn.helloDone = true;
  addConnection(instance, conn);
  return conn;
}

function findCloseCombatMob(instance) {
  for (const e of instance.zone.entities) {
    const sp = getSpecies(e.species_id);
    if (sp && sp.entity_type === "CloseCombatMonster") return e;
  }
  return null;
}

test("bullet damages and kills a CloseCombatMonster entity", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance, "00000000-0000-0000-0000-0000-combat01");
  const mob = findCloseCombatMob(instance);
  assert.ok(mob, "starting zone has at least one CloseCombatMonster");

  // Plant a high-dps stationary bullet centered on the mob's hittable rect.
  // Using the kunai species (7000, dps=1800) and _dpsOverride for a quick
  // kill irrespective of species balancing.
  const bullet = {
    id: -777,
    species_id: 7000,
    _spawned: true,
    _vx: 0, _vy: 0,
    _lifespan: 5,
    _playerIndex: 0,
    _dpsOverride: 5000,
    frame: { x: mob.frame.x, y: mob.frame.y + 0.5, w: 1, h: 1 },
    direction: "Down",
    dialogues: [],
  };
  instance.zone.entities.push(bullet);
  const startCount = instance.zone.entities.length;

  // Run enough ticks: 5000 dps * 0.1 s = 500 hp/tick. Mob has 200 hp →
  // dies in tick 1. Run a few extras for safety.
  for (let i = 0; i < 5; i++) tickOnce(instance);

  const mobStillThere = instance.zone.entities.some((e) => e === mob);
  assert.ok(!mobStillThere, "mob should have been removed from zone.entities");
  assert.ok(instance.zone.entities.length < startCount, "entity count dropped");
  assert.ok(conn.player.hp > 99, "shooter never took damage from its own bullet");
});

test("mob adjacent to player kills the player and broadcasts event:death", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance, "00000000-0000-0000-0000-0000-combat02");
  const mob = findCloseCombatMob(instance);
  const msp = getSpecies(mob.species_id);
  conn.player.x = Math.floor(mob.frame.x);
  conn.player.y = Math.floor(mob.frame.y) + (msp.height ? msp.height - 1 : 0);
  conn.player.tileX = conn.player.x;
  conn.player.tileY = conn.player.y;

  for (let i = 0; i < 60; i++) {
    tickOnce(instance);
    if (conn.dead) break;
  }
  assert.equal(conn.dead, true, "player should be dead after continuous mob damage");
  assert.equal(conn.player.hp, 0, "HP clamped to 0");
  const deathFrames = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "death");
  assert.equal(deathFrames.length, 1, "exactly one event:death broadcast");
  assert.equal(deathFrames[0].playerId, conn.playerId);
});

test("respawn intent restores HP and resets position; event:respawn fires", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance, "00000000-0000-0000-0000-0000-combat03");
  // Force-death without combat (faster).
  conn.dead = true;
  conn.player.hp = 0;
  conn.player.x = 10; conn.player.y = 10;
  conn.player.tileX = 10; conn.player.tileY = 10;

  conn.input.respawnRequested = true;
  tickOnce(instance);

  assert.equal(conn.dead, false);
  assert.equal(conn.player.hp, 100);
  assert.equal(conn.player.tileX, instance.zone.spawnPoint.x);
  assert.equal(conn.player.tileY, instance.zone.spawnPoint.y);
  const respawnFrames = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "respawn");
  assert.equal(respawnFrames.length, 1);
  assert.equal(respawnFrames[0].zoneId, instance.zone.id);
});

test("friendly fire is OFF on server by default — a bullet from A doesn't damage B", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const a = attach(instance, "00000000-0000-0000-0000-0000-combat04");
  const b = attach(instance, "00000000-0000-0000-0000-0000-combat05");
  a.player.x = 5; a.player.y = 5; a.player.tileX = 5; a.player.tileY = 5;
  b.player.x = 6; b.player.y = 5; b.player.tileX = 6; b.player.tileY = 5;

  // Stationary bullet sitting on top of B, owned by A.
  instance.zone.entities.push({
    id: -888,
    species_id: 7000,
    _spawned: true,
    _vx: 0, _vy: 0,
    _lifespan: 2,
    _playerIndex: 0, // A's player.index
    _dpsOverride: 1000,
    frame: { x: 6, y: 5.2, w: 0.7, h: 0.7 },
    direction: "Right",
    dialogues: [],
  });

  for (let i = 0; i < 5; i++) tickOnce(instance);
  assert.equal(b.player.hp, 100, "B took no friendly-fire damage with default getter");
});

// --- Ghost grace tests use a real createApp + WebSocket. ---

async function withServer(ghostGraceMs, fn) {
  const { httpServer, parties, instances, ctx, stopTick } = createApp({
    loadRawZone: (zoneId) => loadZone(zoneId),
    startingZoneId: STARTING_ZONE_ID,
    autoTick: false,
    ghostGraceMs,
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = httpServer.address();
  try {
    await fn({ port, parties, instances, ctx });
  } finally {
    stopTick();
    await new Promise((r) => httpServer.close(r));
  }
}

function openWs(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

function nextMessage(ws, predicate = () => true) {
  return new Promise((resolve) => {
    const handler = (evt) => {
      let m;
      try { m = JSON.parse(evt.data); } catch { return; }
      if (!predicate(m)) return;
      ws.removeEventListener("message", handler);
      resolve(m);
    };
    ws.addEventListener("message", handler);
  });
}

function sendHello(ws, uuid) {
  ws.send(JSON.stringify({ op: "hello", protocol: 1, uuid, client: "test" }));
}

test("disconnect within ghost grace lets the same UUID reconnect without 4003", async () => {
  await withServer(2_000, async ({ port, ctx }) => {
    const uuid = "11111111-1111-1111-1111-1111-ghost001";
    const ws1 = await openWs(port);
    const welcome1 = nextMessage(ws1, (m) => m.op === "welcome");
    sendHello(ws1, uuid);
    const w1 = await welcome1;
    assert.equal(w1.op, "welcome");
    const existing = ctx.byUuid.get(uuid);
    assert.ok(existing, "conn registered in byUuid");
    const conn1Id = existing.id;

    await new Promise((r) => { ws1.addEventListener("close", () => r(), { once: true }); ws1.close(); });
    // Give the server a moment to process the close + set the ghost.
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(existing.ghostExpiresAt, "ghost timer is set after close");
    assert.ok(ctx.byUuid.has(uuid), "UUID still in byUuid during grace");

    const ws2 = await openWs(port);
    const welcome2 = nextMessage(ws2, (m) => m.op === "welcome");
    sendHello(ws2, uuid);
    const w2 = await welcome2;
    assert.equal(w2.op, "welcome", "reconnect got a fresh welcome (no 4003)");
    assert.equal(w2.playerId, w1.playerId, "same playerId on reconnect");
    const restored = ctx.byUuid.get(uuid);
    assert.equal(restored.id, conn1Id, "same conn object restored, not a fresh one");
    assert.equal(restored.ghostExpiresAt, null, "ghost cleared on reconnect");
    ws2.close();
    // Give close handler time to run before withServer tears down.
    await new Promise((r) => setTimeout(r, 30));
  });
});

test("ghost finalizes after the grace window; a later hello is a fresh login", async () => {
  await withServer(80, async ({ port, ctx }) => {
    const uuid = "22222222-2222-2222-2222-2222-ghost002";
    const ws1 = await openWs(port);
    const welcome1 = nextMessage(ws1, (m) => m.op === "welcome");
    sendHello(ws1, uuid);
    await welcome1;
    const conn1 = ctx.byUuid.get(uuid);
    const conn1Id = conn1.id;

    await new Promise((r) => { ws1.addEventListener("close", () => r(), { once: true }); ws1.close(); });
    // Wait past the grace window + a small buffer.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(ctx.byUuid.has(uuid), false, "UUID removed after finalize");

    const ws2 = await openWs(port);
    const welcome2 = nextMessage(ws2, (m) => m.op === "welcome");
    sendHello(ws2, uuid);
    const w2 = await welcome2;
    assert.equal(w2.op, "welcome", "post-finalize hello succeeds");
    const fresh = ctx.byUuid.get(uuid);
    assert.notEqual(fresh.id, conn1Id, "fresh login = new conn object");
    ws2.close();
    await new Promise((r) => setTimeout(r, 30));
  });
});
