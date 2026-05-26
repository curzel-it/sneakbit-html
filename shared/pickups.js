// Pickups + hints: when one of the supplied live players snaps onto an
// auto-triggered entity we fire its effect and remove it from the zone.
//
// Hint entities (consumable variant) show their dialogue, then vanish.
// Bundles and PickableObjects play a pickup SFX and vanish; the ammo
// goes into the picking-up player's inventory, and weapon pickups equip
// into that player's slot. Teleporters are handled in transitions.js so
// they can fade between zones.
//
// Co-op / online rule: iterate every live player and the first one whose
// tile overlaps a pickup wins it. The caller is responsible for filtering
// dead/ghosted players out before calling — keeps the dead-check policy
// out of shared/ (offline reads per-index records, server reads conn.dead).

import { getSpecies } from "./species.js";
import { addAmmo } from "./inventory.js";
import { getValue, setValue } from "./storage.js";
import { setEquipped, SLOT_MELEE, SLOT_RANGED } from "./equipment.js";
import { tr } from "./strings.js";
import { shouldBeVisible } from "./entityVisibility.js";
import { isCreativeMode } from "./creativeMode.js";

// Side-effects (sfx, toast, dialogue resolution) and observation hooks
// (onPickup) are injected so this module loads under node without pulling
// client/audio.js, client/toast.js, or client/dialogue.js. Defaults are
// no-ops — the offline client wires real handlers via client/pickupBoot.js;
// the server wires onPickup to emit `event:pickup` and leaves sfx/toast as
// no-ops (those reach players via separate event frames).
const handlers = {
  sfx: null,
  toast: null,
  resolveDialogue: null,
  dialogueLines: null,
  // Per-pickup hook called once per (player, speciesId, amount) write. Server
  // uses this to broadcast `event:pickup`; offline leaves it null.
  onPickup: null,
  // Auto-equip hook called when a pickup carries an `associated_weapon`.
  // Default behavior: write the weapon id into the legacy equipment slot
  // and toast a hint. The server overrides with a no-op until step 4
  // (equipment) ports the slot writes to per-player storage.
  onAutoEquip: null,
};

export function setPickupHandlers(h) {
  if (!h || typeof h !== "object") return;
  for (const k of Object.keys(h)) {
    if (h[k] !== undefined) handlers[k] = h[k];
  }
}

function sfx(name) { if (handlers.sfx) handlers.sfx(name); }
function toast(text, kind, opts) { if (handlers.toast) handlers.toast(text, kind, opts); }

// Bullet is here because in zone data, placed Bullets (speed=0) act as
// stationary collectibles — same rule as the original Rust core. Bundles
// expand into N copies of their bundle_contents species (e.g. one
// "kunai.x10" gives 10 kunai). Player-spawned bullets carry _spawned and
// are explicitly excluded so the kunai you just threw doesn't immediately
// re-collect itself.
const AUTO_PICKUP_TYPES = new Set(["Bundle", "PickableObject", "Bullet"]);

// `state` accepts either:
//   - { zone, players: [livePlayer, ...] } — preferred; caller pre-filters dead
//   - { zone, player, player2 } — legacy offline shape; caller is expected
//     to pre-filter or pass both, this function does not filter again.
export function checkPickup(state) {
  const zone = state?.zone;
  if (!zone?.entities) return;
  // Creative mode never auto-collects: pickups stay on the floor (so
  // the designer can keep arranging them), and hint signs don't fire
  // their toast. Mirrors Rust update_pickable_object early-returning
  // in creative.
  if (isCreativeMode()) return;

  const players = Array.isArray(state.players)
    ? state.players
    : [state.player, state.player2].filter(Boolean);
  if (!players.length) return;

  for (let i = 0; i < zone.entities.length; i++) {
    const e = zone.entities[i];
    if (e._spawned) continue;
    if (!shouldBeVisible(e)) continue;
    const kind = classify(e);
    if (!kind) continue;
    const f = e.frame; if (!f) continue;
    const picker = players.find(p =>
      p && p.tileX >= f.x && p.tileX < f.x + f.w &&
      p.tileY >= f.y && p.tileY < f.y + f.h
    );
    if (!picker) continue;
    if (kind === "hint-persistent") {
      triggerHint(e, /* persist */ true);
    } else {
      zone.entities.splice(i, 1);
      if (e.id != null && !zone.ephemeralState) {
        setValue(`item_collected.${e.id}`, 1);
      }
      trigger(e, kind, picker);
    }
    return;
  }
}

function classify(e) {
  const sp = getSpecies(e.species_id);
  if (!sp) return null;
  if (AUTO_PICKUP_TYPES.has(sp.entity_type)) return "pickup";
  if (sp.entity_type === "Hint") {
    return e.is_consumable ? "hint" : "hint-persistent";
  }
  return null;
}

function trigger(e, kind, picker) {
  if (kind === "hint") {
    triggerHint(e, /* persist */ false);
    return;
  }
  const sp = getSpecies(e.species_id);
  let amounts;
  if (sp?.bundle_contents?.length) {
    const map = new Map();
    for (const cid of sp.bundle_contents) map.set(cid, (map.get(cid) || 0) + 1);
    amounts = [...map.entries()];
  } else {
    amounts = [[e.species_id, 1]];
  }
  for (const [cid, n] of amounts) {
    addAmmo(cid, n, picker);
    if (handlers.onPickup) handlers.onPickup(picker, cid, n);
  }
  sfx("ammoCollected");
  maybeEquipWeapon(sp, picker);
}

// When a pickup is associated with a weapon (sword pickup → sword,
// AR15 pickup → AR15, …) auto-equip it into the matching slot so the
// player can immediately see — and use — the weapon they just grabbed.
// Mirrors how `available_weapons` in Rust surfaces a weapon as soon as
// its pickup species lands in the inventory, with the JS twist that
// we equip it directly instead of opening a chooser (no inventory UI yet).
function maybeEquipWeapon(pickupSp, picker) {
  if (!pickupSp) return;
  const weaponId = pickupSp.associated_weapon;
  if (!weaponId) return;
  const weaponSp = getSpecies(weaponId);
  if (!weaponSp) return;
  let slot = null;
  let hint = "";
  if (weaponSp.entity_type === "WeaponMelee")  { slot = SLOT_MELEE;  hint = "Press G to swing"; }
  if (weaponSp.entity_type === "WeaponRanged") { slot = SLOT_RANGED; hint = "Press F to shoot"; }
  if (!slot) return;
  if (handlers.onAutoEquip) {
    handlers.onAutoEquip(picker, slot, weaponSp, hint);
    return;
  }
  // Default (offline) path: legacy per-index equipment slot + toast.
  setEquipped(slot, weaponId, picker);
  const name = tr(weaponSp.name) || weaponSp.name || "weapon";
  toast(`Equipped: ${name}\n${hint}`, "longHint", {
    image: inventoryIconFor(weaponSp),
  });
}

// Builds the ToastImage payload for a species' inventory icon. Returns
// null if the species has no inventory_texture_offset. Mirrors Rust
// ToastImage::static_image(species.inventory_sprite_frame(), SHEET_INVENTORY).
function inventoryIconFor(sp) {
  const off = sp?.inventory_texture_offset;
  if (!off) return null;
  const TILE = 16;
  return {
    url: "./assets/inventory.png",
    // inventory_texture_offset is [row, col] in Rust.
    sx: (off[1] | 0) * TILE,
    sy: (off[0] | 0) * TILE,
    sw: TILE,
    sh: TILE,
    renderSize: 32,
  };
}

// Renders the hint as a toast. For persistent hints (Rust is_consumable=false)
// we suppress repeats by storing a read-flag under "hint.read.<text>" — same
// storage key as Rust entities/hint.rs::set_hint_read. The flag persists
// across reloads so a hint the player has already seen never spams again.
function triggerHint(e, persist) {
  if (!handlers.resolveDialogue || !handlers.dialogueLines) return;
  const dialogue = handlers.resolveDialogue(e);
  const lines = handlers.dialogueLines(dialogue);
  if (!lines.length) return;
  const text = lines.join("\n");
  if (persist) {
    const key = `hint.read.${text}`;
    if (getValue(key)) return;
    setValue(key, 1);
  }
  sfx("hintReceived");
  toast(text, "hint");
}
