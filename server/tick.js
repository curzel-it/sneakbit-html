// 10 Hz tick driver. For each non-idle zone instance: feed each connected
// player's input queue to shared/player.updatePlayer, then broadcast a
// `delta` op with every player's current state. Idle instances (no
// connected members) are skipped so they cost zero CPU.

import { updatePlayer } from "../shared/player.js";
import { sendJson } from "./connection.js";

export const TICK_HZ = 10;
export const TICK_MS = 1000 / TICK_HZ;
const DT = TICK_MS / 1000;

export function startTick(instance) {
  const handle = setInterval(() => tickOnce(instance), TICK_MS);
  // Don't keep the event loop alive solely for the tick — letting Ctrl-C
  // shut down promptly matters more than guaranteeing one last tick.
  handle.unref?.();
  return () => clearInterval(handle);
}

export function tickOnce(instance) {
  if (instance.connections.size === 0) return;

  for (const conn of instance.connections.values()) {
    updatePlayer(conn.player, conn.input, DT, instance.zone);
    // `events` is edge-triggered: per-tick presses. `held` is sticky and
    // is cleared only by an explicit stopMove (or a future per-direction
    // release op).
    conn.input.events.length = 0;
  }

  instance.tick += 1;

  // Phase 2 broadcasts the full player array every tick (no diffing yet).
  // Entities don't move because no mobs are wired up server-side; clients
  // already have the static entity list from `welcome`. Mob deltas land
  // in Phase 4 step 1.
  const frame = JSON.stringify({
    op: "delta",
    tick: instance.tick,
    players: [...instance.connections.values()].map(serializePlayerDelta),
  });
  for (const conn of instance.connections.values()) {
    if (conn.ws.readyState !== conn.ws.OPEN) continue;
    conn.ws.send(frame);
  }
}

function serializePlayerDelta(conn) {
  const p = conn.player;
  return {
    playerId: conn.playerId,
    x: p.x,
    y: p.y,
    tileX: p.tileX,
    tileY: p.tileY,
    direction: p.direction,
    moving: p.moving,
    frameIndex: p.frameIndex,
    step: p.step,
  };
}
