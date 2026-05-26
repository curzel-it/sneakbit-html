// Browser-side keyboard wiring for shared/shooting.js. Translates a
// keydown into the right player's shot via matchesAction (single
// player) or COOP_KEYMAPS (co-op), then defers to shoot().

import {
  setShootingStateRef,
  getShootingState,
  shoot,
} from "../shared/shooting.js";
import { matchesAction } from "./keyBindings.js";
import { isCoopMode, COOP_KEYMAPS } from "../shared/coopMode.js";

export function installShooting(getState) {
  setShootingStateRef(getState);
  window.addEventListener("keydown", onKey);
}

function onKey(e) {
  if (e.repeat) return;
  const state = getShootingState();
  if (!state) return;
  const shooter = pickShooter(state, e.code);
  if (!shooter) return;
  e.preventDefault();
  shoot(state, shooter);
}

function pickShooter(state, code) {
  if (isCoopMode()) {
    if (code === COOP_KEYMAPS[1].shoot) return state.player;
    if (code === COOP_KEYMAPS[2].shoot) return state.player2 || state.player;
    return null;
  }
  return matchesAction("shoot", code) ? state.player : null;
}
