// Wires the client's audio + toast handlers into the shared gate-unlock
// module on import. Without this, walking into a yellow gate with a key
// silently opens it (key still consumed, sprite still flips) but no
// audio + no toast hint. Online clients see the audio/toast from the
// future event:gateUnlocked frame the server emits in this step.

import { setGateUnlockHandlers } from "../shared/gateUnlock.js";
import { playSfx } from "./audio.js";
import { showToast } from "./toast.js";

setGateUnlockHandlers({
  sfx: playSfx,
  toast: showToast,
});
