// Client-side prediction for self movement.
//
// The server is authoritative at 10 Hz; "press key → next server tick →
// broadcast → render at -100 ms (interp delay)" adds ~200–250 ms of
// perceived input latency, which is what makes online still feel clunky
// once snapshot interpolation has smoothed the visuals.
//
// To kill that latency, the client runs the same shared/player.js
// updatePlayer locally against the mirror player + local zone every
// frame. Server snapshots become a *reconciliation anchor* rather than
// the rendered position: if the prediction drifts too far from the
// auth, snap; otherwise trust local. Tile-locked movement keeps this
// boring — the server's `canEnter` is deterministic against the same
// zone state the client has, so most predictions match byte-for-byte.
//
// When prediction is wrong (server rejected a push, gate locked from
// the server's perspective, player died), the local avatar continues
// optimistically for a few frames and then snaps back when reality
// arrives. Threshold below picks the snap point.

import { updatePlayer } from "../shared/player.js";

// The auth position lags ~50–150 ms behind the local prediction
// (network RTT + tick alignment), so 0–1 tile of distance is normal
// during a continuous walk. Beyond this we treat it as a real
// divergence and snap.
export const RECONCILE_TILE_THRESHOLD = 1.5;

export function createPredictionState() {
  return {
    // Synthesized to match the input shape shared/player.js expects.
    // setIntent is called from the same place we send to the server,
    // so the local input mirrors the wire intents one-to-one.
    input: { events: [], held: new Set() },
    lastDir: null,
    // Most recent server-authoritative position for self. Used by
    // teleporter detection (which can't trust the predicted tile —
    // the server wouldn't yet see the foot on the teleporter) and
    // by reconciliation.
    auth: null,
  };
}

// Called on the same edge that fires the network intent (held-direction
// change, or stop). null = stop.
export function setIntent(pred, dir) {
  pred.input.held.clear();
  if (dir) {
    pred.input.events.push(dir);
    pred.input.held.add(dir);
  }
  pred.lastDir = dir;
}

// One render-frame of local simulation. Drains `events` after the call
// so the next frame only sees `held` (mirroring the server tick which
// also clears events after processing).
export function tickPrediction(pred, player, dt, zone) {
  if (pred.auth?.dead) return;
  updatePlayer(player, pred.input, dt, zone);
  pred.input.events.length = 0;
}

// Apply a server snapshot for self. Updates the auth anchor and snaps
// the predicted position back if it drifted too far (or if the server
// reports we died — frozen corpse must match the auth position so the
// GameOver modal's "Continue → respawn" round-trip lands cleanly).
export function applyAuth(pred, player, sp) {
  pred.auth = {
    x: sp.x, y: sp.y,
    tileX: sp.tileX, tileY: sp.tileY,
    direction: sp.direction,
    dead: !!sp.dead,
  };
  const dx = player.x - sp.x;
  const dy = player.y - sp.y;
  const dist2 = dx * dx + dy * dy;
  const tooFar = dist2 > RECONCILE_TILE_THRESHOLD * RECONCILE_TILE_THRESHOLD;
  if (pred.auth.dead || tooFar) snapToAuth(player, sp);
}

// Force the predicted state to match auth. Used by reconciliation and
// also exposed for the welcome / zoneChange paths (which call clear-and-
// reseed and want the predicted state to start exactly at the spawn
// point reported by the server).
export function snapToAuth(player, sp) {
  player.x = sp.x;
  player.y = sp.y;
  player.tileX = sp.tileX;
  player.tileY = sp.tileY;
  if (sp.direction) player.direction = sp.direction;
  player.step = null;
  player.queuedDir = null;
  player.pendingDir = null;
  player.pendingTimer = 0;
  player.moving = false;
  player.frameIndex = 0;
  player.frameTimer = 0;
  player._sliding = false;
}
