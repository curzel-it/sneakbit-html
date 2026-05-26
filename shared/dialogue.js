// Dialogue resolution + reward handling. Pure shared module: resolves
// which dialogue an entity should show given the current storage state
// (display_conditions), expands the text into renderable lines, and
// applies the one-time reward (storage flag + inventory add). Mirrors
// Rust entity.rs::next_dialogue + dialogues.rs::handle_reward.
//
// The client/dialogue.js DOM modal imports these for the offline path.
// The server uses them too via server/dialogueHandlers.js, which routes
// `interact` and `dialogueClose` input ops through the same logic.

import { keyMatches, getValue, setValue } from "./storage.js";
import { tr } from "./strings.js";
import { getSpecies } from "./species.js";
import { addAmmo } from "./inventory.js";

// Pickup-toast handlers (sfx, toast) are injected so this module loads
// cleanly server-side. Default is no-op; offline client wires real
// implementations via client/dialogueBoot.js. Server installs a
// queue-event handler to broadcast event:toast for rewards.
const handlers = {
  toast: null,
  // For rewards specifically — server uses this to surface the reward
  // toast as an event rather than a local DOM call.
  onRewardGranted: null,
};

export function setDialogueHandlers(h) {
  if (!h || typeof h !== "object") return;
  for (const k of Object.keys(h)) {
    if (h[k] !== undefined) handlers[k] = h[k];
  }
}

// Returns the first dialogue from an entity whose display_conditions
// match current storage state, or null.
export function resolveEntityDialogue(entity) {
  const dialogues = entity?.dialogues || [];
  for (const d of dialogues) {
    if (!d) continue;
    const key = d.key || "always";
    const ev = d.expected_value | 0;
    if (keyMatches(key, ev)) return d;
  }
  return null;
}

// Localizes a dialogue's text into displayable lines (one per `---`
// separator).
export function dialogueLines(dialogue) {
  if (!dialogue) return [];
  return splitOnSeparator(dialogue.text).map((s) => tr(s));
}

export function splitOnSeparator(s) {
  return String(s).split(/^---?$/m).map((x) => x.trim()).filter(Boolean);
}

// Apply the one-time reward for a dialogue: marks the dialogue's text
// as read, grants the reward to the player (if any, and if not already
// granted). Returns the reward shape `{speciesId, amount, name}` (or
// null) so the caller can show a toast.
export function applyDialogueReward(d, playerOrIndex = 0) {
  if (d?.text) setValue(`dialogue.answer.${d.text}`, 1);
  if (!d?.reward) return null;
  const rewardKey = `dialogue.reward.${d.text}`;
  if (getValue(rewardKey) === 1) return null;
  setValue(rewardKey, 1);
  addAmmo(d.reward, 1, playerOrIndex);
  const sp = getSpecies(d.reward);
  const name = sp ? (tr(sp.name) || sp.name) : String(d.reward);
  const out = { speciesId: d.reward, amount: 1, name };
  if (handlers.onRewardGranted) handlers.onRewardGranted(playerOrIndex, out);
  return out;
}
