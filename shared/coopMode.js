// Local co-op mode flag + per-player keymaps. When co-op is on:
//   * a second player entity (P2) spawns next to P1 at boot
//   * P1 inputs are WASD + Z/X/C (interact / shoot / melee)
//   * P2 inputs are IJKL + B/N/M (interact / shoot / melee)
//   * the keyBindings.js settings UI is bypassed — co-op locks the
//     keymap to those two hardwired sets so the second player always
//     has a stable control scheme
//   * inventory, HP, skills and save data are shared (one save slot)
//   * the camera follows the midpoint between the two players
//
// The flag is held in-process. Browser entry points install
// client/coopModeBackend.js to persist it to localStorage; node-side
// tests get a clean in-memory default.

let cached = false;
let saver = null;

export function isCoopMode() { return cached; }

export function setCoopMode(on) {
  cached = !!on;
  if (saver) saver(cached);
}

export function installCoopBackend({ initial, save } = {}) {
  if (typeof initial === "boolean") cached = initial;
  saver = typeof save === "function" ? save : null;
}

// Fixed per-player keymaps for co-op. Spread across the keyboard so the
// two players can sit at the same machine without their hands colliding.
export const COOP_KEYMAPS = {
  1: {
    moveUp:    "KeyW",
    moveDown:  "KeyS",
    moveLeft:  "KeyA",
    moveRight: "KeyD",
    interact:  "KeyZ",
    shoot:     "KeyX",
    melee:     "KeyC",
  },
  2: {
    moveUp:    "KeyI",
    moveDown:  "KeyK",
    moveLeft:  "KeyJ",
    moveRight: "KeyL",
    interact:  "KeyB",
    shoot:     "KeyN",
    melee:     "KeyM",
  },
};

export function _setCoopModeForTesting(on) {
  cached = !!on;
  saver = null;
}
