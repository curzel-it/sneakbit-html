// End-to-end WS handshake against the real server app. Spins up createApp
// on port 0 with the real starting zone, opens a WebSocket (Node's built-in
// global, Web standard), exchanges hello → welcome, and asserts the wire
// shape matches the spec.

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData } from "../shared/species.js";
import { createApp } from "../server/app.js";
import { loadSpecies, loadZone } from "../server/data.js";
import { installMemoryBackend } from "../server/memoryBackend.js";
import { makePlayerId } from "../server/connection.js";

installMemoryBackend();
const speciesRaw = await loadSpecies();
loadSpeciesData(speciesRaw);
const rawZone = await loadZone(STARTING_ZONE_ID);

async function withServer(fn) {
  const { httpServer, instance } = createApp({ rawZone });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = httpServer.address();
  try {
    await fn({ port, instance });
  } finally {
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

function nextJson(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (evt) => {
      try {
        resolve(JSON.parse(evt.data));
      } catch (err) {
        reject(err);
      }
    }, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

function nextClose(ws) {
  return new Promise((resolve) => {
    ws.addEventListener("close", (evt) => resolve(evt.code), { once: true });
  });
}

test("hello → welcome carries playerId, party stub, and a full zone snapshot", async () => {
  await withServer(async ({ port, instance }) => {
    const ws = await openWs(port);
    const uuid = "8a1c1d2e-3b4f-4c5d-9e6f-7a8b9c0d1e2f";
    ws.send(JSON.stringify({
      op: "hello",
      protocol: 1,
      uuid,
      joinCode: null,
      client: "test",
    }));
    const welcome = await nextJson(ws);
    ws.close();

    assert.equal(welcome.op, "welcome");
    assert.equal(welcome.protocol, 1);
    assert.equal(welcome.playerId, makePlayerId(uuid));
    assert.ok(welcome.partyId.startsWith("pty_solo_"));
    assert.ok(welcome.partyCode.startsWith("SOLO"));
    assert.equal(welcome.members.length, 1);
    assert.equal(welcome.members[0].self, true);

    assert.equal(welcome.zone.id, STARTING_ZONE_ID);
    const state = welcome.zone.state;
    assert.equal(state.id, STARTING_ZONE_ID);
    assert.equal(state.rows, instance.zone.rows);
    assert.equal(state.cols, instance.zone.cols);
    assert.ok(state.biomeTiles?.tiles?.length > 0);
    assert.ok(state.constructionTiles?.tiles?.length > 0);
    assert.ok(Array.isArray(state.entities));
    assert.equal(state.players.length, 1);
    assert.equal(state.players[0].playerId, welcome.playerId);
    assert.equal(typeof state.players[0].x, "number");
    assert.equal(typeof state.players[0].y, "number");
  });
});

test("bad protocol → obsolete + close (4001)", async () => {
  await withServer(async ({ port }) => {
    const ws = await openWs(port);
    ws.send(JSON.stringify({ op: "hello", protocol: 0, uuid: "u" }));
    const obsolete = await nextJson(ws);
    assert.equal(obsolete.op, "obsolete");
    assert.equal(obsolete.minProtocol, 1);
    const code = await nextClose(ws);
    assert.equal(code, 4001);
  });
});

test("ping → pong (after hello)", async () => {
  await withServer(async ({ port }) => {
    const ws = await openWs(port);
    ws.send(JSON.stringify({
      op: "hello", protocol: 1, uuid: "00000000-0000-0000-0000-000000000001",
    }));
    await nextJson(ws); // drain welcome
    ws.send(JSON.stringify({ op: "ping" }));
    const pong = await nextJson(ws);
    assert.equal(pong.op, "pong");
    ws.close();
  });
});

test("input intents land in the connection's input queue", async () => {
  await withServer(async ({ port, instance }) => {
    const ws = await openWs(port);
    ws.send(JSON.stringify({
      op: "hello", protocol: 1, uuid: "00000000-0000-0000-0000-000000000002",
    }));
    await nextJson(ws); // drain welcome
    ws.send(JSON.stringify({ op: "input", intent: "moveRight" }));

    // Let the server's message handler run.
    await new Promise((r) => setTimeout(r, 50));
    const [conn] = [...instance.connections.values()];
    assert.ok(conn.input.held.has("right"));
    assert.ok(conn.input.events.includes("right"));

    ws.send(JSON.stringify({ op: "input", intent: "stopMove" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(conn.input.held.size, 0);

    ws.close();
  });
});

test("unknown ops are dropped silently (connection stays open)", async () => {
  await withServer(async ({ port }) => {
    const ws = await openWs(port);
    ws.send(JSON.stringify({
      op: "hello", protocol: 1, uuid: "00000000-0000-0000-0000-000000000003",
    }));
    await nextJson(ws);
    ws.send(JSON.stringify({ op: "nonsense", whatever: true }));
    // No error, no close. A subsequent ping still gets pong.
    ws.send(JSON.stringify({ op: "ping" }));
    const pong = await nextJson(ws);
    assert.equal(pong.op, "pong");
    ws.close();
  });
});
