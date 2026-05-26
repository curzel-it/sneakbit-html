// Wires the client's audio + toast + dialogue helpers into the shared
// pickup module on import. Without this, picked-up items are silent and
// hint signs go untoasted offline. The legacy inventory backend stays
// installed by default in shared/inventory.js, so per-index storage keeps
// working unchanged.
//
// Online mode loads this same file (see client/online.js) — the pickup
// pipeline runs server-side, but the auto-equip toast still needs the DOM
// toast handler in case a future server-side equipment system surfaces
// hints through the same shared path.

import { setPickupHandlers } from "../shared/pickups.js";
import { playSfx } from "./audio.js";
import { showToast } from "./toast.js";
import { resolveEntityDialogue, dialogueLines } from "./dialogue.js";

setPickupHandlers({
  sfx: playSfx,
  toast: showToast,
  resolveDialogue: resolveEntityDialogue,
  dialogueLines,
});
