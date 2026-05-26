// Per-player HP backend for the authoritative server. Installed at boot
// via setCombatHealthBackend; combat.js's damage paths then mutate the
// player object directly instead of going through shared/playerHealth.js's
// global per-index records (which would collide across online conns all
// running at index 0).
//
// Mirrors the burst-vs-continuous + invuln + regen-delay semantics from
// shared/playerHealth.js so combat parity with offline is exact. As of
// Phase 4 step 4 we also apply per-player equipment damage reductions:
// each equipped slot whose species has a `received_damage_reduction`
// multiplies incoming damage by (1 - reduction).

import { setCombatHealthBackend } from "../shared/combat.js";
import { getEquipped, SLOT_MELEE, SLOT_RANGED } from "../shared/equipment.js";
import { getSpecies } from "../shared/species.js";

export const HEALTH_MAX_HP = 100;
const RECOVERY_PER_SEC = 3;
const REGEN_DELAY_AFTER_HIT = 1.5;
const INVULN_AFTER_BURST = 0.4;

export function initPlayerHealth(player) {
  player.hp = HEALTH_MAX_HP;
  player.hpMax = HEALTH_MAX_HP;
  player._invuln = 0;
  player._regenDelay = 0;
}

function ensure(player) {
  if (typeof player.hp !== "number") initPlayerHealth(player);
}

function applyDamageReductions(player, amount) {
  let out = amount;
  for (const slot of [SLOT_MELEE, SLOT_RANGED]) {
    const id = getEquipped(slot, player);
    if (!id) continue;
    const sp = getSpecies(id);
    const r = sp?.received_damage_reduction || 0;
    if (r > 0) out *= Math.max(0, 1 - r);
  }
  return out;
}

function applyBurst(player, amount) {
  ensure(player);
  if (player._invuln > 0 || player.hp <= 0 || amount <= 0) return "ignored";
  const reduced = applyDamageReductions(player, amount);
  if (reduced <= 0) return "ignored";
  player.hp = Math.max(0, player.hp - reduced);
  player._invuln = INVULN_AFTER_BURST;
  player._regenDelay = REGEN_DELAY_AFTER_HIT;
  return player.hp <= 0 ? "died" : "hurt";
}

function applyContinuous(player, amount) {
  ensure(player);
  if (player.hp <= 0 || amount <= 0) return "ignored";
  const reduced = applyDamageReductions(player, amount);
  if (reduced <= 0) return "ignored";
  player.hp = Math.max(0, player.hp - reduced);
  player._regenDelay = REGEN_DELAY_AFTER_HIT;
  return player.hp <= 0 ? "died" : "hurt";
}

function isDead(player) {
  if (!player) return false;
  return (player.hp ?? HEALTH_MAX_HP) <= 0;
}

export function installServerCombatHealth() {
  setCombatHealthBackend({ applyContinuous, applyBurst, isDead });
}

// Tick invuln + regen for the supplied players. Run by server/tick.js
// every instance tick on the connection's player objects. Mirrors
// tickPlayerHealth's behavior on offline players.
export function tickServerPlayerHealth(dt, players) {
  for (const p of players) {
    if (!p) continue;
    ensure(p);
    if (p._invuln > 0) p._invuln = Math.max(0, p._invuln - dt);
    if (p._regenDelay > 0) {
      p._regenDelay = Math.max(0, p._regenDelay - dt);
      continue;
    }
    if (p.hp > 0 && p.hp < p.hpMax) {
      p.hp = Math.min(p.hpMax, p.hp + RECOVERY_PER_SEC * dt);
    }
  }
}

export function resetPlayerHealth(player) {
  initPlayerHealth(player);
}
