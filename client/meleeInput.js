// Browser-side keyboard wiring for shared/melee.js. Translates a
// keydown into the right player's swing via matchesAction (single
// player) or COOP_KEYMAPS (co-op), then defers to performMeleeSwing.

import {
  setMeleeStateRef,
  getMeleeState,
  performMeleeSwing,
} from "../shared/melee.js";
import { matchesAction } from "./keyBindings.js";
import { isCoopMode, COOP_KEYMAPS } from "../shared/coopMode.js";

export function installMelee(getState) {
  setMeleeStateRef(getState);
  window.addEventListener("keydown", onKey);
}

function onKey(e) {
  if (e.repeat) return;
  const state = getMeleeState();
  if (!state) return;
  const swinger = pickSwinger(state, e.code);
  if (!swinger) return;
  e.preventDefault();
  performMeleeSwing(state, { swinger });
}

function pickSwinger(state, code) {
  if (isCoopMode()) {
    if (code === COOP_KEYMAPS[1].melee) return state.player;
    if (code === COOP_KEYMAPS[2].melee) return state.player2 || state.player;
    return null;
  }
  return matchesAction("melee", code) ? state.player : null;
}
