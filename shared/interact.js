// Resolves "is there a dialogue-bearing entity directly in front of the
// player?" — the pure half of the interact feature. The keyboard wiring
// and DOM hint element live in client/interactInput.js so this module
// loads cleanly under node.

import { shouldBeVisible } from "./entityVisibility.js";

const DIR_DELTA = {
  up:    [ 0, -1],
  down:  [ 0,  1],
  left:  [-1,  0],
  right: [ 1,  0],
};

export function findFacingEntity(zone, player) {
  const [dx, dy] = DIR_DELTA[player.direction] ?? [0, 1];
  const tx = player.tileX + dx;
  const ty = player.tileY + dy;
  for (const e of zone.entities) {
    if (!e.frame) continue;
    if (!shouldBeVisible(e)) continue;
    const { x, y, w, h } = e.frame;
    if (tx >= x && tx < x + w && ty >= y && ty < y + h) {
      if ((e.dialogues || []).length > 0) return e;
    }
  }
  return null;
}
