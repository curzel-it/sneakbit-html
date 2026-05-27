// Client-side prediction state machine. Tests cover the input
// synthesis, the per-frame updatePlayer pass, the reconciliation snap
// threshold, and the dead-snap special case. The real shared/player.js
// updatePlayer is invoked end-to-end here — the prediction module is a
// thin shell around it, so coupling the test to the real implementation
// catches input-shape regressions in both modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPredictionState,
  setIntent,
  tickPrediction,
  applyAuth,
  snapToAuth,
  RECONCILE_TILE_THRESHOLD,
} from "../client/prediction.js";
import { createPlayer } from "../shared/player.js";

// A tiny walkable zone: 10×10 grass biome, no entities, no construction.
// Shape matches what shared/zone.js's isWalkable / isTileSlippery /
// isEntityBlocked actually read — `collision[y][x]` and `biome[y][x]`.
function makeOpenZone() {
  const rows = 10, cols = 10;
  const collision = [], biome = [];
  for (let r = 0; r < rows; r++) {
    collision.push(Array(cols).fill(false));
    biome.push(Array(cols).fill(0));
  }
  return { id: 1, rows, cols, entities: [], collision, biome };
}

test("setIntent pushes an event and stamps held with a single direction", () => {
  const pred = createPredictionState();
  setIntent(pred, "right");
  assert.deepEqual([...pred.input.events], ["right"]);
  assert.equal(pred.input.held.size, 1);
  assert.ok(pred.input.held.has("right"));
  assert.equal(pred.lastDir, "right");
});

test("setIntent(null) clears held without adding an event", () => {
  const pred = createPredictionState();
  setIntent(pred, "up");
  pred.input.events.length = 0; // simulate a previous tick draining
  setIntent(pred, null);
  assert.equal(pred.input.events.length, 0);
  assert.equal(pred.input.held.size, 0);
  assert.equal(pred.lastDir, null);
});

test("tickPrediction advances the player one tile per ~step duration of dt", () => {
  const pred = createPredictionState();
  const player = createPlayer();
  player.x = 5; player.y = 5; player.tileX = 5; player.tileY = 5;
  player.direction = "right";
  const zone = makeOpenZone();
  setIntent(pred, "right");

  // 0.30 s of dt total at 60 fps ≈ 18 frames. Step duration is 0.22 s,
  // so this should land at least one tile to the right (commit-delay
  // collapses to zero because we're already facing right).
  for (let i = 0; i < 18; i++) tickPrediction(pred, player, 1 / 60, zone);
  assert.ok(player.tileX >= 6, `expected tileX >= 6, got ${player.tileX}`);
});

test("tickPrediction drains the events queue after each call", () => {
  const pred = createPredictionState();
  const player = createPlayer();
  player.x = 5; player.y = 5; player.tileX = 5; player.tileY = 5;
  setIntent(pred, "down");
  tickPrediction(pred, player, 1 / 60, makeOpenZone());
  // The press event must not re-fire on every frame after the first.
  assert.equal(pred.input.events.length, 0);
});

test("tickPrediction freezes when auth.dead is true", () => {
  const pred = createPredictionState();
  const player = createPlayer();
  player.x = 5; player.y = 5; player.tileX = 5; player.tileY = 5;
  pred.auth = { dead: true, x: 5, y: 5, tileX: 5, tileY: 5 };
  setIntent(pred, "right");
  for (let i = 0; i < 30; i++) tickPrediction(pred, player, 1 / 60, makeOpenZone());
  assert.equal(player.x, 5);
  assert.equal(player.tileX, 5);
});

test("applyAuth leaves the predicted position alone within the threshold", () => {
  const pred = createPredictionState();
  const player = createPlayer();
  player.x = 5.5; player.y = 5.0; // 0.5 tiles ahead of auth (normal lag)
  player.tileX = 5; player.tileY = 5;
  applyAuth(pred, player, {
    x: 5.0, y: 5.0, tileX: 5, tileY: 5, direction: "right", dead: false,
  });
  assert.equal(player.x, 5.5);
  assert.equal(player.y, 5.0);
  assert.ok(pred.auth);
  assert.equal(pred.auth.tileX, 5);
});

test("applyAuth snaps back when divergence exceeds threshold", () => {
  const pred = createPredictionState();
  const player = createPlayer();
  player.x = 8.0; player.y = 5.0; // 3 tiles ahead — server rejected the move
  player.tileX = 8; player.tileY = 5;
  player.step = { fromX: 7, fromY: 5, toX: 8, toY: 5, progress: 0.9 };
  applyAuth(pred, player, {
    x: 5.0, y: 5.0, tileX: 5, tileY: 5, direction: "right", dead: false,
  });
  assert.equal(player.x, 5.0);
  assert.equal(player.y, 5.0);
  assert.equal(player.tileX, 5);
  assert.equal(player.step, null);
});

test("applyAuth snaps unconditionally when server reports dead", () => {
  const pred = createPredictionState();
  const player = createPlayer();
  player.x = 5.05; player.y = 5.0; // well within threshold
  player.tileX = 5; player.tileY = 5;
  player.step = { fromX: 5, fromY: 5, toX: 6, toY: 5, progress: 0.1 };
  applyAuth(pred, player, {
    x: 5.0, y: 5.0, tileX: 5, tileY: 5, direction: "right", dead: true,
  });
  // Snapped regardless of distance.
  assert.equal(player.x, 5.0);
  assert.equal(player.step, null);
  assert.equal(pred.auth.dead, true);
});

test("snapToAuth resets all the step-state fields so prediction restarts cleanly", () => {
  const player = createPlayer();
  player.x = 9.7; player.y = 3.4;
  player.tileX = 9; player.tileY = 3;
  player.step = { fromX: 9, fromY: 3, toX: 10, toY: 3, progress: 0.7 };
  player.queuedDir = "down";
  player.pendingDir = "left";
  player.pendingTimer = 0.04;
  player.moving = true;
  player._sliding = true;
  snapToAuth(player, { x: 2, y: 4, tileX: 2, tileY: 4, direction: "down" });
  assert.equal(player.x, 2);
  assert.equal(player.tileX, 2);
  assert.equal(player.direction, "down");
  assert.equal(player.step, null);
  assert.equal(player.queuedDir, null);
  assert.equal(player.pendingDir, null);
  assert.equal(player.moving, false);
  assert.equal(player._sliding, false);
});

test("RECONCILE_TILE_THRESHOLD is conservative enough for typical lag", () => {
  // The auth lags one server tick (~100 ms) behind the predicted
  // position. Max move speed is ~4.5 tiles/s in normal mode → ~0.45
  // tiles of distance per tick. Threshold has to be comfortably above
  // that or normal walking would constantly trigger snaps.
  assert.ok(RECONCILE_TILE_THRESHOLD > 1.0,
    `threshold ${RECONCILE_TILE_THRESHOLD} would snap during normal walking`);
});
