// Dialogue overlay. HTML element above the canvas with the current line.
// Advances on Space / Enter / Click. While open, the player is paused.
//
// Two payload shapes are supported:
//   - Legacy array of strings (already-resolved lines, no reward tracking)
//   - Rust-style Dialogue object: { text, key, expected_value, reward }.
//     On close, marks dialogue_read.<text>=1 and (if reward set + not yet
//     collected) adds the reward to inventory and shows a toast.

import { tr } from "../shared/strings.js";
import { playSfx } from "./audio.js";
import { keyMatches } from "../shared/storage.js";
import { showToast } from "./toast.js";
import { matchesAction } from "./keyBindings.js";
import {
  resolveEntityDialogue as sharedResolveEntityDialogue,
  dialogueLines as sharedDialogueLines,
  applyDialogueReward,
  splitOnSeparator,
} from "../shared/dialogue.js";

// Re-export the shared resolvers for back-compat with existing callers
// (interactInput.js, pickupBoot.js).
export const resolveEntityDialogue = sharedResolveEntityDialogue;
export const dialogueLines = sharedDialogueLines;

let root = null;
let active = null; // { lines, idx, resolve, dialogue }
let listener = null;

export function installDialogue() {
  if (root) return root;
  root = document.createElement("div");
  root.id = "dialogue";
  Object.assign(root.style, {
    position: "fixed",
    left: "50%",
    transform: "translateX(-50%)",
    bottom: "5%",
    maxWidth: "min(720px, 90vw)",
    minWidth: "min(400px, 80vw)",
    padding: "16px 20px",
    background: "rgba(10, 10, 10, 0.92)",
    border: "1px solid #444",
    borderRadius: "6px",
    color: "#eee",
    fontFamily: "monospace",
    fontSize: "14px",
    lineHeight: "1.4",
    whiteSpace: "pre-wrap",
    display: "none",
    zIndex: "15",
    boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
    cursor: "pointer",
  });
  root.innerHTML = `<div id="dialogue-text"></div><div id="dialogue-hint">▾ space / enter / click</div>`;
  document.body.appendChild(root);
  const style = document.createElement("style");
  style.textContent = `
    #dialogue-hint { color: #888; font-size: 11px; margin-top: 8px; text-align: right; }
    /* On touch devices the on-screen joystick sits at the bottom; flip
       the modal dialogue to the top so it doesn't cover the controls. */
    @media (pointer: coarse) {
      #dialogue { bottom: auto !important; top: 6% !important; }
    }
  `;
  document.head.appendChild(style);

  listener = (e) => {
    if (!active) return;
    // Always accept Space as a universal "advance" so the dialogue
    // remains dismissable even if the player rebinds interact onto an
    // unusual key. Otherwise the rebound interact key works too.
    if (e.code === "Space" || matchesAction("interact", e.code)) {
      e.preventDefault();
      advance();
    }
  };
  window.addEventListener("keydown", listener);
  root.addEventListener("click", () => advance());
  return root;
}

export function isDialogueOpen() { return active !== null; }

export function showDialogue(payload, playerIndex = 0) {
  return new Promise((resolve) => {
    const dialogue = isDialogueObject(payload) ? payload : null;
    const rawLines = dialogue ? [dialogue.text] : (Array.isArray(payload) ? payload : [payload]);
    const lines = rawLines.flatMap(splitOnSeparator).map((s) => tr(s));
    active = { lines, idx: 0, resolve, dialogue, playerIndex: playerIndex | 0 };
    paint();
    root.style.display = "block";
    playSfx("hintReceived", { volume: 0.5 });
  });
}

// Open the modal directly with already-resolved lines. Online mode uses
// this path: the server sends `event:dialogueOpen` with `lines` already
// localized + split, and the modal resolves with `null` on close so
// callers can react if needed.
export function showDialogueLines(lines, opts = {}) {
  return new Promise((resolve) => {
    active = {
      lines: Array.isArray(lines) ? lines : [String(lines)],
      idx: 0,
      resolve,
      dialogue: null,
      playerIndex: 0,
      ...opts,
    };
    paint();
    root.style.display = "block";
    playSfx("hintReceived", { volume: 0.5 });
  });
}

function isDialogueObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) && typeof x.text === "string";
}

function advance() {
  if (!active) return;
  active.idx++;
  if (active.idx >= active.lines.length) {
    close();
    return;
  }
  paint();
  playSfx("hintReceived", { volume: 0.3 });
}

function paint() {
  if (!active) return;
  root.querySelector("#dialogue-text").textContent = active.lines[active.idx];
}

function close() {
  if (!active) return;
  const resolve = active.resolve;
  const dialogue = active.dialogue;
  const playerIndex = active.playerIndex | 0;
  active = null;
  root.style.display = "none";
  if (dialogue) handleReward(dialogue, playerIndex);
  resolve(dialogue);
}

// Apply the reward via the shared dialogue helper (which writes the
// storage flags + decrements inventory through the equipment backend),
// then show the offline DOM toast. Online mode never lands here — the
// server emits a `event:dialogueClose` (with optional reward info)
// after which it runs applyDialogueReward itself.
function handleReward(d, playerIndex) {
  const reward = applyDialogueReward(d, playerIndex | 0);
  if (!reward) return;
  const template = tr("dialogue.reward_received");
  showToast(template.replace("%s", reward.name), "longHint");
}

// Test-only helpers.
export { keyMatches as _keyMatches };
