// Zone-instance registry: lazy creation, 60s warm-idle drop, cancel on
// reentry. Uses fake timers via setTimeout/clearTimeout and a hand-rolled
// fake party (the registry only reads party.id + party.instances).

import { test } from "node:test";
import assert from "node:assert/strict";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData } from "../shared/species.js";
import { loadSpecies, loadZone } from "../server/data.js";
import { installMemoryBackend } from "../server/memoryBackend.js";
import {
  IDLE_DROP_MS,
  addConnection,
  createInstanceRegistry,
  removeConnection,
} from "../server/zoneInstance.js";

installMemoryBackend();
loadSpeciesData(await loadSpecies());
const rawZone = await loadZone(STARTING_ZONE_ID);

function fakeParty(id = "pty_test") {
  return { id, code: "TEST1", members: new Set(), instances: new Map() };
}

function fakeConn(id) {
  return {
    id,
    ws: { readyState: 1, OPEN: 1, send() {}, close() {} },
    player: { x: 0, y: 0, tileX: 0, tileY: 0, direction: "down" },
    input: { events: [], held: new Set() },
  };
}

const loader = async (zoneId) => loadZone(zoneId);

test("getOrCreate is lazy and reuses existing (zoneId, partyId) instances", async () => {
  const reg = createInstanceRegistry({ loadRawZone: loader });
  const p = fakeParty();
  const a = await reg.getOrCreate(STARTING_ZONE_ID, p);
  const b = await reg.getOrCreate(STARTING_ZONE_ID, p);
  assert.equal(a, b);
  assert.equal(p.instances.get(STARTING_ZONE_ID), a);
});

test("two parties get separate instances of the same zone", async () => {
  const reg = createInstanceRegistry({ loadRawZone: loader });
  const p1 = fakeParty("pty_1");
  const p2 = fakeParty("pty_2");
  const a = await reg.getOrCreate(STARTING_ZONE_ID, p1);
  const b = await reg.getOrCreate(STARTING_ZONE_ID, p2);
  assert.notEqual(a, b);
  assert.equal(reg.size(), 2);
});

test("scheduleDrop is a no-op while connections are present", async () => {
  const reg = createInstanceRegistry({ loadRawZone: loader });
  const p = fakeParty();
  const inst = await reg.getOrCreate(STARTING_ZONE_ID, p);
  const conn = fakeConn(1);
  addConnection(inst, conn);
  reg.scheduleDrop(inst);
  assert.equal(inst._dropTimer, null);
});

test("scheduleDrop fires after IDLE_DROP_MS when empty", async () => {
  // Hack: monkey-patch setTimeout to advance immediately. Node's built-in
  // test runner has no fake-timer helper; this is the lightest approach.
  const realSetTimeout = globalThis.setTimeout;
  const queued = [];
  globalThis.setTimeout = (fn, ms) => {
    const h = realSetTimeout(() => {}, 0);
    queued.push({ fn, ms, h });
    return h;
  };
  try {
    const reg = createInstanceRegistry({ loadRawZone: loader });
    const p = fakeParty();
    const inst = await reg.getOrCreate(STARTING_ZONE_ID, p);
    reg.scheduleDrop(inst);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].ms, IDLE_DROP_MS);
    queued[0].fn(); // simulate the timer firing
    assert.equal(reg.size(), 0);
    assert.equal(inst._dropped, true);
    assert.equal(p.instances.size, 0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("re-entering during the warm window cancels the drop", async () => {
  // Same fake-timer trick.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let queued = null;
  globalThis.setTimeout = (fn) => { queued = { fn, cleared: false }; return queued; };
  globalThis.clearTimeout = (h) => { if (h) h.cleared = true; };
  try {
    const reg = createInstanceRegistry({ loadRawZone: loader });
    const p = fakeParty();
    const inst = await reg.getOrCreate(STARTING_ZONE_ID, p);
    reg.scheduleDrop(inst);
    assert.ok(queued);
    // Re-entry should cancel.
    const reentered = await reg.getOrCreate(STARTING_ZONE_ID, p);
    assert.equal(reentered, inst);
    assert.equal(queued.cleared, true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

test("removeConnection clears the instance ref on the conn", async () => {
  const reg = createInstanceRegistry({ loadRawZone: loader });
  const p = fakeParty();
  const inst = await reg.getOrCreate(STARTING_ZONE_ID, p);
  const conn = fakeConn(1);
  addConnection(inst, conn);
  assert.equal(conn.zoneInstance, inst);
  removeConnection(inst, conn);
  assert.equal(conn.zoneInstance, null);
});
