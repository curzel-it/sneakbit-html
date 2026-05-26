// Per-WebSocket state and helpers. Owns the player object (the same shape
// shared/player.js produces), the input queue consumed by the tick, and
// the JSON-frame send helper. The connection also tracks which party and
// zone instance it's currently inside — both are set after hello and
// mutate as the player travels or switches parties.

import { createPlayer } from "../shared/player.js";
import { initPlayerHealth } from "./combatHealthBackend.js";
import { initPlayerInventory } from "./inventoryBackend.js";
import { initPlayerEquipment } from "./equipmentBackend.js";
import { handleInteractIntent, handleDialogueCloseIntent } from "./dialogueHandlers.js";

let nextConnId = 1;

export function createConnection({ ws }) {
  const id = nextConnId++;
  const player = createPlayer();
  initPlayerHealth(player);
  initPlayerInventory(player);
  initPlayerEquipment(player);
  return {
    id,
    ws,
    uuid: null,
    playerId: null,
    name: null,
    player,
    // events:    directional press queue (one-shot per tick)
    // held:      sticky direction set
    // actions:   queue of one-shot action intents ("shoot", "melee")
    // respawnRequested: one-shot flag set by the "respawn" intent
    input: { events: [], held: new Set(), actions: [], respawnRequested: false },
    helloDone: false,
    party: null,         // set by partyRegistry.add()
    zoneInstance: null,  // set by addConnection()
    dead: false,         // true once HP hits 0; cleared on respawn
  };
}

export function sendJson(conn, obj) {
  if (conn.ws.readyState !== conn.ws.OPEN) return;
  conn.ws.send(JSON.stringify(obj));
}

// Translate a wire intent into shared/player.js's input shape. Phase 2 keeps
// it simple: at most one held direction at a time (tile-locked movement
// can't go diagonal anyway). `stopMove` clears the held set.
const INTENT_TO_DIR = {
  moveUp: "up",
  moveDown: "down",
  moveLeft: "left",
  moveRight: "right",
};

export function applyInputIntent(conn, intent) {
  const dir = INTENT_TO_DIR[intent];
  if (dir) {
    if (conn.dead) return;
    conn.input.events.push(dir);
    conn.input.held.clear();
    conn.input.held.add(dir);
    return;
  }
  if (intent === "stopMove") {
    conn.input.held.clear();
    return;
  }
  if (intent === "shoot" || intent === "melee") {
    if (conn.dead) return;
    conn.input.actions.push(intent);
    return;
  }
  if (intent === "respawn") {
    if (conn.dead) conn.input.respawnRequested = true;
    return;
  }
  if (intent === "interact") {
    handleInteractIntent(conn);
    return;
  }
  if (intent === "dialogueClose") {
    handleDialogueCloseIntent(conn);
    return;
  }
}

// The protocol identifies players by a short, human-displayable id derived
// from the UUID. Six hex chars is plenty to disambiguate the handful of
// players a v0 instance will ever hold.
export function makePlayerId(uuid) {
  const hex = (uuid || "").replace(/-/g, "");
  return "p_" + (hex.slice(0, 6) || "anon00");
}

export function makeDisplayName(playerId) {
  return "Player-" + playerId.slice(2);
}
