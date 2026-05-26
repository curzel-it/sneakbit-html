// Phase 4 step 6 — server-side trails + cutscenes wired through the
// per-instance tick. Trails are a small, easily-driven path: stepping
// the player across a snow tile should spawn a footstep entry in
// zone._trails, which decays over time.

import { test } from "node:test";
import assert from "node:assert/strict";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData } from "../shared/species.js";
import { BIOME } from "../shared/biomes.js";
import { createConnection, makePlayerId } from "../server/connection.js";
import { loadSpecies, loadZone } from "../server/data.js";
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
const rawZone = await loadZone(STARTING_ZONE_ID);

const fakeParty = { id: "pty_trails", code: "TRL01", members: new Set(), instances: new Map() };

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
  const uuid = `00000000-0000-0000-0000-trailsxx${String(++connSeq).padStart(2, "0")}`;
  conn.uuid = uuid;
  conn.playerId = makePlayerId(uuid);
  conn.name = "test";
  conn.helloDone = true;
  addConnection(instance, conn);
  return conn;
}

// Force a 3x1 strip of snow into the zone's biome grid at the supplied
// row. tickTrails reads zone.biome[y][x] to decide whether to spawn.
function paintSnow(zone, y, xs) {
  for (const x of xs) zone.biome[y][x] = BIOME.SNOW;
}

test("walking across snow leaves a footstep in zone._trails", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  // Paint a snow line on row 40 from x=10..12.
  paintSnow(instance.zone, 40, [10, 11, 12]);
  conn.player.tileX = 10; conn.player.tileY = 40;
  conn.player.x = 10; conn.player.y = 40;

  // First tick: tickTrails sees the player but has no `last` recorded yet —
  // it stores (10, 40) and returns without spawning. The lastTileByZone
  // map is module-private; we can't probe it directly, but we can assert
  // the trail count after step 2.
  tickOnce(instance);
  assert.equal((instance.zone._trails ?? []).length, 0, "no trail spawned on the first observation");

  // Move to (11, 40): tickTrails should spawn a trail at the previous tile.
  conn.player.tileX = 11; conn.player.x = 11;
  tickOnce(instance);
  assert.ok(instance.zone._trails.length >= 1, "trail entry spawned when player moved across snow");
});

test("trail entries decay and despawn after their lifespan", () => {
  const instance = createZoneInstance({ rawZone, zoneId: rawZone.id, party: fakeParty });
  const conn = attach(instance);
  // Pre-populate a trail entry with a timer close to the lifespan limit.
  // TRAIL_LIFESPAN ≈ 15/8 = 1.875s. Set timer to 1.7 so a handful of
  // 0.1s ticks pushes it over.
  instance.zone._trails = [{ x: 5, y: 5, direction: "down", timer: 1.7 }];
  conn.player.tileX = 0; conn.player.tileY = 0;
  conn.player.x = 0; conn.player.y = 0;

  for (let i = 0; i < 3; i++) tickOnce(instance);
  assert.equal(instance.zone._trails.length, 0, "expired trail spliced out");
});
