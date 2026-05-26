// Browser-side wiring for the interact feature: a keydown listener,
// the on-screen "Press E to talk" hint, and the bridge into
// client/dialogue.js. Pure entity-search lives in shared/interact.js.

import { showDialogue, resolveEntityDialogue, isDialogueOpen } from "./dialogue.js";
import { handleAfterDialogue } from "../shared/afterDialogue.js";
import { matchesAction } from "./keyBindings.js";
import { isCoopMode, COOP_KEYMAPS } from "../shared/coopMode.js";
import { findFacingEntity } from "../shared/interact.js";

let stateRef = null;
let hintEl = null;

export function installInteract(getState) {
  stateRef = getState;
  hintEl = makeHint();
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (isDialogueOpen()) return;
    const state = stateRef();
    if (!state) return;
    const initiator = pickInitiator(state, e.code);
    if (!initiator) return;
    const target = findFacingEntity(state.zone, initiator);
    if (!target) return;
    const dialogue = resolveEntityDialogue(target);
    if (!dialogue) return;
    e.preventDefault();
    showDialogue(dialogue, initiator.index | 0).then(() => handleAfterDialogue(state.zone, target));
  });
}

// Maps a keydown to the player who should act on it. In co-op the two
// players have their own interact keys (KeyZ / KeyB); in single-player
// the rebindable interact action drives P1.
function pickInitiator(state, code) {
  if (isCoopMode()) {
    if (code === COOP_KEYMAPS[1].interact) return state.player;
    if (code === COOP_KEYMAPS[2].interact) return state.player2 || state.player;
    return null;
  }
  return matchesAction("interact", code) ? state.player : null;
}

export function tickInteract() {
  if (!stateRef || !hintEl) return;
  if (isDialogueOpen()) { hintEl.style.display = "none"; return; }
  const state = stateRef();
  const target = state ? findFacingEntity(state.zone, state.player) : null;
  hintEl.style.display = target ? "block" : "none";
}

function makeHint() {
  const el = document.createElement("div");
  el.id = "interact-hint";
  el.textContent = "Press E to talk";
  // Styled to match toast.js exactly so the in-zone interact prompt and
  // pickup/hint toasts are visually consistent (top: 6% band, same
  // background, radius, padding, fontSize). Persistent while a
  // dialogue-bearing entity is in front of the player — main.js calls
  // tickInteract() once per frame to toggle the visibility.
  Object.assign(el.style, {
    position: "fixed",
    top: "6%",
    left: "50%",
    transform: "translateX(-50%)",
    maxWidth: "min(640px, 86vw)",
    padding: "10px 16px",
    background: "rgba(10, 10, 10, 0.92)",
    border: "1px solid #444",
    borderRadius: "6px",
    color: "#eee",
    fontFamily: "monospace",
    fontSize: "14px",
    lineHeight: "1.4",
    textAlign: "center",
    display: "none",
    pointerEvents: "none",
    zIndex: "13",
    boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
  });
  document.body.appendChild(el);
  return el;
}
