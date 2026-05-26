// Phase 4 step 7 — server-side dialogue progression. Interact intent
// resolves the facing entity, emits event:dialogueOpen with localized
// lines. Client-driven dialogueClose intent runs the reward + after-
// dialogue side-effects, emits event:dialogueClose. Per-conn state
// tracked on conn._activeDialogue so a stale interact doesn't double-
// open.

import { test } from "node:test";
import assert from "node:assert/strict";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData } from "../shared/species.js";
import { loadStringsData } from "../shared/strings.js";
import { createConnection, makePlayerId, applyInputIntent } from "../server/connection.js";
import { loadSpecies, loadZone, loadStrings } from "../server/data.js";
import { installMemoryBackend } from "../server/memoryBackend.js";
import { installServerCombatHealth } from "../server/combatHealthBackend.js";
import { installServerInventoryBackend } from "../server/inventoryBackend.js";
import { installServerEquipmentBackend } from "../server/equipmentBackend.js";
import { installServerPickupHandlers } from "../server/pickupHandlers.js";
import { installServerPuzzleBackend } from "../server/puzzleBackend.js";
import { installServerGateUnlockHandlers } from "../server/gateUnlockHandlers.js";
import { installServerCutsceneHandlers } from "../server/cutsceneHandlers.js";
import { tickOnce } from "../server/tick.js";
import { addConnection, createZoneInstance } from "../server/zoneInstance.js";

installMemoryBackend();
installServerCombatHealth();
installServerInventoryBackend();
installServerEquipmentBackend();
installServerPickupHandlers();
installServerPuzzleBackend();
installServerGateUnlockHandlers();
installServerCutsceneHandlers();
loadSpeciesData(await loadSpecies());
loadStringsData(await loadStrings("en"));
const rawZone = await loadZone(STARTING_ZONE_ID);

const fakeParty = { id: "pty_dlg", code: "DLG01", members: new Set(), instances: new Map() };

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
  const uuid = `00000000-0000-0000-0000-dialogue${String(++connSeq).padStart(2, "0")}`;
  conn.uuid = uuid;
  conn.playerId = makePlayerId(uuid);
  conn.name = "test";
  conn.helloDone = true;
  addConnection(instance, conn);
  return conn;
}

function plantNpc(instance, tx, ty, opts = {}) {
  const e = {
    id: opts.id ?? -88_000 - Math.floor(Math.random() * 1000),
    species_id: opts.species_id ?? 1500, // arbitrary; what matters is dialogues
    frame: { x: tx, y: ty, w: 1, h: 1 },
    is_consumable: false,
    is_rigid: false,
    dialogues: opts.dialogues ?? [
      { key: "always", expected_value: 0, text: "Hello, friend." },
    ],
    direction: "Down",
    after_dialogue: opts.after_dialogue ?? "Nothing",
    ...opts.overrides,
  };
  instance.zone.entities.push(e);
  return e;
}

test("interact in front of a dialogue NPC emits event:dialogueOpen with lines", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  conn.player.x = 30; conn.player.y = 30; conn.player.tileX = 30; conn.player.tileY = 30;
  conn.player.direction = "down";
  plantNpc(instance, 30, 31);

  applyInputIntent(conn, "interact");
  // The handler queued the event; it broadcasts on the next tick.
  tickOnce(instance);
  const opens = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "dialogueOpen");
  assert.equal(opens.length, 1);
  assert.equal(opens[0].forPlayerId, conn.playerId);
  assert.ok(Array.isArray(opens[0].lines) && opens[0].lines.length > 0,
    "lines included in the open event");
  assert.equal(opens[0].lines[0], "Hello, friend.");
  assert.ok(conn._activeDialogue, "conn marked as in-dialogue");
});

test("dialogueClose intent fires event:dialogueClose and runs after-dialogue Disappear", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  conn.player.x = 32; conn.player.y = 30; conn.player.tileX = 32; conn.player.tileY = 30;
  conn.player.direction = "down";
  const npc = plantNpc(instance, 32, 31, { after_dialogue: "Disappear" });

  applyInputIntent(conn, "interact");
  applyInputIntent(conn, "dialogueClose");
  tickOnce(instance);
  const closes = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "dialogueClose");
  assert.equal(closes.length, 1, "exactly one dialogueClose broadcast");
  assert.equal(closes[0].forPlayerId, conn.playerId);
  assert.equal(conn._activeDialogue, null, "conn cleared");
  // Disappear after-dialogue spliced the NPC out.
  assert.equal(instance.zone.entities.includes(npc), false, "NPC removed by Disappear");
});

test("dialogue reward grants inventory + emits event:toast", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  conn.player.x = 34; conn.player.y = 30; conn.player.tileX = 34; conn.player.tileY = 30;
  conn.player.direction = "down";
  plantNpc(instance, 34, 31, {
    dialogues: [{ key: "always", expected_value: 0, text: "Take this kunai!", reward: 7000 }],
  });

  applyInputIntent(conn, "interact");
  applyInputIntent(conn, "dialogueClose");
  tickOnce(instance);
  assert.equal(conn.player.inventory[7000], 1, "reward landed in per-player inventory");
  const toasts = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "toast");
  assert.equal(toasts.length, 1, "one reward toast emitted");
  assert.equal(toasts[0].textKey, "dialogue.reward_received");
  assert.ok(toasts[0].args?.name, "toast args carry the reward name");
});

test("interact is ignored while a dialogue is already open", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  conn.player.x = 36; conn.player.y = 30; conn.player.tileX = 36; conn.player.tileY = 30;
  conn.player.direction = "down";
  plantNpc(instance, 36, 31);

  applyInputIntent(conn, "interact");
  applyInputIntent(conn, "interact"); // duplicate — must no-op
  tickOnce(instance);
  const opens = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "dialogueOpen");
  assert.equal(opens.length, 1, "second interact didn't fire another dialogueOpen");
});

test("death while mid-dialogue clears _activeDialogue", async () => {
  const { tickCombat } = await import("../shared/combat.js");
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  conn.player.x = 38; conn.player.y = 30; conn.player.tileX = 38; conn.player.tileY = 30;
  conn.player.direction = "down";
  plantNpc(instance, 38, 31);
  applyInputIntent(conn, "interact");
  assert.ok(conn._activeDialogue, "dialogue opened");
  // Kill the player directly: combat tick detects HP 0 and flips conn.dead.
  conn.player.hp = 0;
  tickOnce(instance);
  assert.equal(conn.dead, true, "conn dead after HP 0 tick");
  assert.equal(conn._activeDialogue, null, "active dialogue cleared on death");
});

test("interact with nothing in front no-ops silently", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  // Park player in open space, no NPC ahead.
  conn.player.x = 40; conn.player.y = 40; conn.player.tileX = 40; conn.player.tileY = 40;
  conn.player.direction = "down";

  applyInputIntent(conn, "interact");
  tickOnce(instance);
  const opens = conn.ws._sent.filter((m) => m.op === "event" && m.kind === "dialogueOpen");
  assert.equal(opens.length, 0);
  assert.equal(conn._activeDialogue, undefined);
});
