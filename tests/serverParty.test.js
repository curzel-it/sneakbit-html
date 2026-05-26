// End-to-end party + travel + UUID-conflict (4003) coverage. Same shape as
// serverHandshake.test.js: real createApp(), real WS, but every test opens
// 1–3 sockets to exercise the multi-connection flows Phase 3 introduces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData } from "../shared/species.js";
import { createApp } from "../server/app.js";
import { loadSpecies, loadZone } from "../server/data.js";
import { installMemoryBackend } from "../server/memoryBackend.js";

installMemoryBackend();
loadSpeciesData(await loadSpecies());
await loadZone(STARTING_ZONE_ID);

async function withServer(fn) {
  const { httpServer, parties, instances, stopTick } = createApp({
    loadRawZone: (zoneId) => loadZone(zoneId),
    startingZoneId: STARTING_ZONE_ID,
    autoTick: false,
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = httpServer.address();
  try {
    await fn({ port, parties, instances });
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

function collectMessages(ws) {
  const queue = [];
  const waiters = [];
  ws.addEventListener("message", (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    untilOp(op, kind) {
      return new Promise(async (resolve) => {
        // drain any already-queued matching messages first
        for (let i = 0; i < queue.length; i++) {
          const m = queue[i];
          if (m.op !== op) continue;
          if (kind && m.kind !== kind) continue;
          queue.splice(i, 1);
          return resolve(m);
        }
        while (true) {
          const m = await new Promise((r) => waiters.push(r));
          if (m.op !== op) continue;
          if (kind && m.kind !== kind) continue;
          return resolve(m);
        }
      });
    },
  };
}

async function hello(ws, uuid, joinCode = null) {
  ws.send(JSON.stringify({ op: "hello", protocol: 1, uuid, joinCode, client: "test" }));
}

function closeCode(ws) {
  return new Promise((resolve) => {
    ws.addEventListener("close", (evt) => resolve(evt.code), { once: true });
  });
}

test("solo connection lands in a fresh party of one", async () => {
  await withServer(async ({ port, parties }) => {
    const ws = await openWs(port);
    const mq = collectMessages(ws);
    await hello(ws, "00000000-0000-0000-0000-0000000000a1");
    const welcome = await mq.untilOp("welcome");
    assert.equal(welcome.members.length, 1);
    assert.equal(welcome.members[0].self, true);
    assert.equal(parties._byId.size, 1);
    ws.close();
  });
});

test("joinCode on hello puts the second player into the first's party + same instance", async () => {
  await withServer(async ({ port, instances }) => {
    const wsA = await openWs(port);
    const mqA = collectMessages(wsA);
    await hello(wsA, "00000000-0000-0000-0000-0000000000a2");
    const welcomeA = await mqA.untilOp("welcome");

    const wsB = await openWs(port);
    const mqB = collectMessages(wsB);
    await hello(wsB, "00000000-0000-0000-0000-0000000000b2", welcomeA.partyCode);
    const welcomeB = await mqB.untilOp("welcome");

    assert.equal(welcomeB.partyId, welcomeA.partyId);
    assert.equal(welcomeB.partyCode, welcomeA.partyCode);
    assert.equal(welcomeB.members.length, 2);

    // A receives a partyUpdate broadcast when B joins.
    const update = await mqA.untilOp("event", "partyUpdate");
    assert.equal(update.partyId, welcomeA.partyId);
    assert.equal(update.members.length, 2);

    // One instance shared by both.
    assert.equal(instances.size(), 1);
    wsA.close();
    wsB.close();
  });
});

test("party.join with a wrong code returns partyJoinFailed:not_found", async () => {
  await withServer(async ({ port }) => {
    const ws = await openWs(port);
    const mq = collectMessages(ws);
    await hello(ws, "00000000-0000-0000-0000-0000000000c3");
    await mq.untilOp("welcome");

    ws.send(JSON.stringify({ op: "party.join", code: "ZZZZZ" }));
    const ev = await mq.untilOp("event", "partyJoinFailed");
    assert.equal(ev.reason, "not_found");
    ws.close();
  });
});

test("party.leave moves the leaver into a fresh party-of-one, broadcasts to old", async () => {
  await withServer(async ({ port, parties }) => {
    const wsA = await openWs(port);
    const mqA = collectMessages(wsA);
    await hello(wsA, "00000000-0000-0000-0000-0000000000a4");
    const wA = await mqA.untilOp("welcome");

    const wsB = await openWs(port);
    const mqB = collectMessages(wsB);
    await hello(wsB, "00000000-0000-0000-0000-0000000000b4", wA.partyCode);
    const wB = await mqB.untilOp("welcome");
    await mqA.untilOp("event", "partyUpdate"); // drain join broadcast

    wsB.send(JSON.stringify({ op: "party.leave" }));
    // B gets a zoneChange (new party-of-one instance) + a partyUpdate.
    const zc = await mqB.untilOp("event", "zoneChange");
    assert.equal(zc.zoneId, STARTING_ZONE_ID);
    const pu = await mqB.untilOp("event", "partyUpdate");
    assert.notEqual(pu.partyId, wA.partyId);
    assert.equal(pu.members.length, 1);

    // A also gets a partyUpdate (B left).
    const aUpd = await mqA.untilOp("event", "partyUpdate");
    assert.equal(aUpd.members.length, 1);

    assert.equal(parties._byId.size, 2);
    wsA.close();
    wsB.close();
  });
});

test("second hello with the same UUID is closed with 4003", async () => {
  await withServer(async ({ port }) => {
    const wsA = await openWs(port);
    const mqA = collectMessages(wsA);
    const uuid = "00000000-0000-0000-0000-0000000000d5";
    await hello(wsA, uuid);
    await mqA.untilOp("welcome");

    const wsB = await openWs(port);
    const closed = closeCode(wsB);
    await hello(wsB, uuid);
    const code = await closed;
    assert.equal(code, 4003);
    // wsA stays alive: ping → pong proves it.
    wsA.send(JSON.stringify({ op: "ping" }));
    const pong = await mqA.untilOp("pong");
    assert.equal(pong.op, "pong");
    wsA.close();
  });
});

test("travel onto a teleporter moves the player to the destination zone instance", async () => {
  await withServer(async ({ port, instances }) => {
    const ws = await openWs(port);
    const mq = collectMessages(ws);
    await hello(ws, "00000000-0000-0000-0000-0000000000e6");
    const welcome = await mq.untilOp("welcome");

    // Find a teleporter in the starting zone snapshot and warp by faking
    // the player's tile position on the server: the easier path is to
    // place a fake teleporter at the spawn tile via the instance handle.
    // Instead, walk through the registry to access conn.player directly.
    const [inst] = [...instances.liveInstances()];
    const [conn] = [...inst.connections.values()];
    const tele = welcome.zone.state.entities.find((e) => e.species_id === 1019 && e.destination);
    assert.ok(tele, "starting zone should contain a teleporter");
    // Move the server-side player onto the teleporter's tile.
    conn.player.tileX = tele.frame.x;
    conn.player.tileY = tele.frame.y;
    conn.player.x = tele.frame.x;
    conn.player.y = tele.frame.y;

    ws.send(JSON.stringify({ op: "travel", viaEntityId: tele.id }));
    const zc = await mq.untilOp("event", "zoneChange");
    assert.equal(zc.zoneId, tele.destination.world ?? tele.destination.zone);
    assert.ok(zc.snapshot);
    assert.equal(zc.snapshot.id, zc.zoneId);
    // The conn now belongs to the destination instance.
    const destInst = [...instances.liveInstances()].find((i) => i.zone.id === zc.zoneId);
    assert.ok(destInst);
    assert.ok(destInst.connections.has(conn.id));
    ws.close();
  });
});
