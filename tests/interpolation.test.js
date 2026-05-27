// Snapshot interpolator: render-side smoothing for 10 Hz server deltas.
// Pure math + buffer behavior; no DOM, no time source — the caller passes
// the timestamp in so tests can drive virtual time deterministically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInterpolator, INTERP_DELAY_MS } from "../client/interpolation.js";

test("sample returns null when no data has been recorded", () => {
  const interp = createInterpolator();
  assert.equal(interp.sample("a", 1000), null);
});

test("single recording is returned verbatim (no bracket → no lerp)", () => {
  const interp = createInterpolator();
  interp.record("a", 5, 7, 1000);
  assert.deepEqual(interp.sample("a", 1500), { x: 5, y: 7 });
});

test("lerps halfway between two snapshots bracketing renderT", () => {
  const interp = createInterpolator();
  // Per-tick movement at ~4.5 tiles/s and 10 Hz is ~0.45 tiles — well
  // under the snap threshold, so consecutive recordings stay in buffer.
  interp.record("a", 0, 0, 1000);
  interp.record("a", 0.4, 0.2, 1100);
  // now=1150 → renderT = 1150 - 100 = 1050 → halfway between recordings
  const s = interp.sample("a", 1150);
  assert.equal(s.x, 0.2);
  assert.equal(s.y, 0.1);
});

test("clamps to oldest when renderT is before the buffer", () => {
  const interp = createInterpolator();
  interp.record("a", 1, 2, 5000);
  interp.record("a", 1.4, 2, 5100);
  // now=5050 → renderT=4950, before buf[0].t=5000 → return buf[0]
  assert.deepEqual(interp.sample("a", 5050), { x: 1, y: 2 });
});

test("clamps to newest when renderT is past the buffer", () => {
  const interp = createInterpolator();
  interp.record("a", 0, 0, 1000);
  interp.record("a", 4, 4, 1100);
  // now=1300 → renderT=1200, past buf[last].t=1100 → return buf[last]
  assert.deepEqual(interp.sample("a", 1300), { x: 4, y: 4 });
});

test("large position jump snaps the buffer (respawn / teleport)", () => {
  const interp = createInterpolator();
  interp.record("a", 0, 0, 1000);
  interp.record("a", 0.3, 0.0, 1100);
  // Big jump (respawn across the map): buffer resets to just the new entry,
  // so sample at any time after returns the post-jump position with no
  // sliding through space.
  interp.record("a", 50, 50, 1200);
  assert.deepEqual(interp.sample("a", 1250), { x: 50, y: 50 });
  // After another recording lerp resumes normally.
  interp.record("a", 50.4, 50, 1300);
  const s = interp.sample("a", 1350); // renderT=1250 → midpoint
  assert.equal(s.x, 50.2);
  assert.equal(s.y, 50);
});

test("large time gap snaps the buffer (entity went idle then moved)", () => {
  const interp = createInterpolator();
  interp.record("a", 0, 0, 1000);
  interp.record("a", 0.4, 0, 1100);
  // 1-second gap (mob stopped sending deltas because it was idle). Next
  // recording resets — we don't want a 1 s slow slide to the new position.
  interp.record("a", 0.8, 0, 2100);
  assert.deepEqual(interp.sample("a", 2150), { x: 0.8, y: 0 });
});

test("buffer is bounded — old entries fall off after BUFFER_LEN", () => {
  const interp = createInterpolator();
  for (let i = 0; i < 10; i++) {
    // Spacing 100 ms apart so the gap-snap heuristic doesn't fire.
    interp.record("a", i * 0.4, 0, 1000 + i * 100);
  }
  // Even after a flood of recordings, sample() should still bracket two
  // recent entries and lerp cleanly between them.
  const s = interp.sample("a", 1000 + 9 * 100 + 50);
  // renderT = 1000 + 9*100 + 50 - 100 = 1850. That's halfway between
  // i=8 (t=1800, x=3.2) and i=9 (t=1900, x=3.6) → x=3.4
  assert.ok(Math.abs(s.x - 3.4) < 1e-9, `expected ~3.4, got ${s.x}`);
});

test("forget removes a single id; clear drops all", () => {
  const interp = createInterpolator();
  interp.record("a", 1, 1, 1000);
  interp.record("b", 2, 2, 1000);
  interp.forget("a");
  assert.equal(interp.sample("a", 1100), null);
  assert.deepEqual(interp.sample("b", 1100), { x: 2, y: 2 });
  interp.clear();
  assert.equal(interp.sample("b", 1100), null);
});

test("INTERP_DELAY_MS is exported and matches the 10 Hz server tick", () => {
  // The whole point of 100 ms delay is that one server tick (100 ms at
  // 10 Hz) brackets the render time. Lock it down so a stray edit can't
  // silently break the smoothness invariant.
  assert.equal(INTERP_DELAY_MS, 100);
});
