// Snapshot interpolation for online mode.
//
// The server ticks at 10 Hz, so per-object positions on the wire only
// update every ~100 ms. Rendering those positions raw at 60 fps gives a
// visible stairstep — the player snaps 0.4-0.5 tiles each tick instead
// of sliding. This module buffers the last few server positions per id
// and, at sample time, returns the position interpolated between the
// two buffered snapshots that bracket `now - INTERP_DELAY_MS`.
//
// Trade-off: we render every object ~100 ms in the past. In a co-op PvE
// game with tile-locked movement that lag is invisible; it's the price
// for smoothness without prediction.
//
// Snap (don't lerp) when:
//   - the new position is more than SNAP_THRESHOLD_TILES from the last
//     buffered one (respawn / teleport / zoneChange already cleared us);
//   - the gap since the last recording exceeds LARGE_GAP_MS (the server
//     stopped updating this entity for a while; lerping across the gap
//     would produce a long slow slide that doesn't match reality).

export const INTERP_DELAY_MS = 100;
const BUFFER_LEN = 4;
const SNAP_THRESHOLD_TILES = 2;
const LARGE_GAP_MS = 250;

export function createInterpolator() {
  // id -> [{ t, x, y }, ...] oldest first, newest last
  const buffers = new Map();

  function record(id, x, y, t) {
    let buf = buffers.get(id);
    if (!buf) { buf = []; buffers.set(id, buf); }
    const last = buf[buf.length - 1];
    if (last) {
      const dx = x - last.x;
      const dy = y - last.y;
      const tooFar = dx * dx + dy * dy > SNAP_THRESHOLD_TILES * SNAP_THRESHOLD_TILES;
      const tooLate = t - last.t > LARGE_GAP_MS;
      if (tooFar || tooLate) buf.length = 0;
    }
    buf.push({ t, x, y });
    if (buf.length > BUFFER_LEN) buf.shift();
  }

  function sample(id, now) {
    const buf = buffers.get(id);
    if (!buf || buf.length === 0) return null;
    if (buf.length === 1) return { x: buf[0].x, y: buf[0].y };
    const renderT = now - INTERP_DELAY_MS;
    if (renderT <= buf[0].t) return { x: buf[0].x, y: buf[0].y };
    const last = buf[buf.length - 1];
    if (renderT >= last.t) return { x: last.x, y: last.y };
    for (let i = 0; i < buf.length - 1; i++) {
      const a = buf[i], b = buf[i + 1];
      if (renderT >= a.t && renderT <= b.t) {
        const span = b.t - a.t;
        const u = span > 0 ? (renderT - a.t) / span : 0;
        return {
          x: a.x + (b.x - a.x) * u,
          y: a.y + (b.y - a.y) * u,
        };
      }
    }
    return { x: last.x, y: last.y };
  }

  function forget(id) { buffers.delete(id); }
  function clear() { buffers.clear(); }

  return { record, sample, forget, clear };
}

export const _internals = { SNAP_THRESHOLD_TILES, LARGE_GAP_MS, BUFFER_LEN };
