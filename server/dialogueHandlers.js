// Server-side dialogue handler. Owns the `interact` and `dialogueClose`
// input ops and broadcasts `event:dialogueOpen` / `event:dialogueClose`
// per the wire protocol. Reward grant + after-dialogue side-effects
// run server-side via the shared dialogue helper + afterDialogue.
//
// Per-conn state lives on `conn._activeDialogue = { entityId }` while a
// dialogue is open; subsequent `interact` ops are ignored until the
// client closes the current modal.

import { findFacingEntity } from "../shared/interact.js";
import {
  applyDialogueReward,
  dialogueLines,
  resolveEntityDialogue,
} from "../shared/dialogue.js";
import { handleAfterDialogue } from "../shared/afterDialogue.js";

function queue(instance, ev) {
  const q = instance._pendingPickupEvents
    ?? (instance._pendingPickupEvents = []);
  q.push(ev);
}

// Called from server/connection.js applyInputIntent when the wire op is
// "interact". The conn's instance is captured at call time (no module
// global needed since there's no inner-tick handler that crosses into
// shared/ for dialogue).
export function handleInteractIntent(conn) {
  if (!conn || conn.dead) return;
  if (conn._activeDialogue) return;
  const instance = conn.zoneInstance;
  if (!instance) return;
  const target = findFacingEntity(instance.zone, conn.player);
  if (!target) return;
  const dialogue = resolveEntityDialogue(target);
  if (!dialogue) return;
  const lines = dialogueLines(dialogue);
  if (!lines.length) return;
  conn._activeDialogue = {
    entityId: target.id ?? null,
    dialogue,
    target,
  };
  queue(instance, {
    op: "event",
    kind: "dialogueOpen",
    forPlayerId: conn.playerId,
    entityId: target.id ?? null,
    lines,
  });
}

// Client-driven close. Server runs reward + after-dialogue and emits
// dialogueClose. Inventory increments ride the same per-player backend
// installed at boot; the reward event also generates a toast event so
// the modal can announce "Received <name>".
export function handleDialogueCloseIntent(conn) {
  if (!conn || !conn._activeDialogue) return;
  const instance = conn.zoneInstance;
  const { dialogue, target } = conn._activeDialogue;
  conn._activeDialogue = null;
  const reward = applyDialogueReward(dialogue, conn.player);
  if (instance) {
    if (reward) {
      queue(instance, {
        op: "event",
        kind: "toast",
        forPlayerId: conn.playerId,
        textKey: "dialogue.reward_received",
        args: { name: reward.name, speciesId: reward.speciesId },
      });
    }
    queue(instance, {
      op: "event",
      kind: "dialogueClose",
      forPlayerId: conn.playerId,
    });
    if (target) handleAfterDialogue(instance.zone, target);
  }
}
