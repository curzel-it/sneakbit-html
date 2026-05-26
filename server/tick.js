// 10 Hz tick driver. One setInterval iterates every live zone instance
// in the registry and ticks the ones with at least one connected member.
// Idle instances (no connected members) are skipped so they cost zero CPU.
// Empty instances stay in the registry for IDLE_DROP_MS — the registry
// drops them when their timer expires.

import { updatePlayer } from "../shared/player.js";

export const TICK_HZ = 10;
export const TICK_MS = 1000 / TICK_HZ;
const DT = TICK_MS / 1000;

export function startTick(registry) {
  const handle = setInterval(() => tickAll(registry), TICK_MS);
  // Don't keep the event loop alive solely for the tick — letting Ctrl-C
  // shut down promptly matters more than guaranteeing one last tick.
  handle.unref?.();
  return () => clearInterval(handle);
}

export function tickAll(registry) {
  for (const instance of registry.liveInstances()) {
    if (instance.connections.size === 0) continue;
    tickOnce(instance);
  }
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
