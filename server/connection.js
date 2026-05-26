// Per-WebSocket state and helpers. Owns the player object (the same shape
// shared/player.js produces), the input queue consumed by the tick, and
// the JSON-frame send helper.

import { createPlayer } from "../shared/player.js";

let nextConnId = 1;

export function createConnection({ ws, instance }) {
  const id = nextConnId++;
  return {
    id,
    ws,
    instance,
    uuid: null,
    playerId: null,
    name: null,
    player: createPlayer(),
    input: { events: [], held: new Set() },
    helloDone: false,
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
    conn.input.events.push(dir);
    conn.input.held.clear();
    conn.input.held.add(dir);
    return;
  }
  if (intent === "stopMove") {
    conn.input.held.clear();
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
