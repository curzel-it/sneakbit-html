// Player melee attack: a swing spawns five short-lived bullet entities
// in a cross pattern around the hero (center + four cardinals). Mirrors
// Rust equipment/melee.rs. Each bullet deals
// bullet_species.dps * weapon.melee_dps_multiplier, applied via
// combat.js's normal bullet resolution path.
//
// Pure swing math + cooldown lives here so the server tick (and unit
// tests) can call performMeleeSwing without a keyboard. The browser-side
// keydown wiring is in client/meleeInput.js.

import { getSpecies } from "./species.js";
import { getEquipped, SLOT_MELEE } from "./equipment.js";

let sfxHandler = null;
export function setSfxHandler(fn) {
  sfxHandler = typeof fn === "function" ? fn : null;
}
function sfx(name) { if (sfxHandler) sfxHandler(name); }

const DEFAULT_COOLDOWN = 0.35;
const DEFAULT_LIFESPAN = 0.4;

// Bullet offsets around the hero, mirroring Rust bullet_offsets():
// center + 4 cardinals.
const BULLET_OFFSETS = [
  [ 0,  0],
  [ 0, -1],
  [ 1,  0],
  [-1,  0],
  [ 0,  1],
];

const DIR_DELTA = {
  up:    [ 0, -1],
  down:  [ 0,  1],
  left:  [-1,  0],
  right: [ 1,  0],
};

const SFX_FOR_USAGE = {
  SwordSlash:  "swordSlash",
  GunShot:     "gunShot",
  LoudGunShot: "loudGunShot",
  KnifeThrown: "knifeThrown",
};

let stateRef = null;
// Per-player cooldown / swing-animation state, keyed by the player object.
// WeakMap so a player that's no longer referenced anywhere (e.g. an
// online conn that disconnected) doesn't leak. Each entry is {cd, dur}
// where cd decays each tick and dur holds the original swing length so
// the equipment overlay can derive a 0..1 progress.
const cooldownMap = new WeakMap();
function getCooldown(player) { return cooldownMap.get(player); }
function setCooldown(player, cd, dur) { cooldownMap.set(player, { cd, dur }); }
let nextBulletId = 1;

export function setMeleeStateRef(getState) {
  stateRef = getState;
}

export function getMeleeState() {
  return stateRef ? stateRef() : null;
}

// Returns 0..1 if a melee swing is mid-animation for the given player
// (where 1.0 = just started, 0.0 = finished), or null otherwise.
// entities.js::drawEquipment reads this to flip the equipment sprite to
// its usage-row strip while the swing plays out.
export function getMeleeSwingProgress(player) {
  if (!player) return null;
  const rec = cooldownMap.get(player);
  if (!rec || rec.cd <= 0 || rec.dur <= 0) return null;
  return Math.max(0, Math.min(1, rec.cd / rec.dur));
}

// Decay cooldowns for the given players. Offline call sites pass
// [state.player, state.player2]; server passes the per-instance player
// list. Players without an active cooldown are no-ops.
export function tickMelee(dt, players = []) {
  for (const p of players) {
    const rec = cooldownMap.get(p);
    if (rec && rec.cd > 0) rec.cd = Math.max(0, rec.cd - dt);
  }
}

// Touch button entry point — parity with shooting.tryShoot.
export function tryMelee() {
  const state = stateRef?.();
  if (!state) return;
  performMeleeSwing(state, { swinger: state.player });
}

// Spawns the cross-pattern bullets. Exported for unit tests.
// `opts.swinger` defaults to state.player so existing tests keep working.
export function performMeleeSwing(state, opts = {}) {
  const swinger = opts.swinger || state.player;
  const idx = (swinger?.index | 0) || 0;
  const existing = cooldownMap.get(swinger);
  if (existing && existing.cd > 0 && !opts.ignoreCooldown) return false;
  const weaponId = getEquipped(SLOT_MELEE, idx);
  if (!weaponId) return false;
  const weapon = getSpecies(weaponId);
  if (!weapon || weapon.entity_type !== "WeaponMelee") return false;
  const bulletId = weapon.bullet_species_id;
  if (!bulletId) return false;
  const bulletSp = getSpecies(bulletId);
  if (!bulletSp) return false;

  const cd = weapon.cooldown_after_use > 0 ? weapon.cooldown_after_use : DEFAULT_COOLDOWN;
  setCooldown(swinger, cd, cd);
  const lifespan = weapon.bullet_lifespan > 0 ? weapon.bullet_lifespan : DEFAULT_LIFESPAN;
  const speed = bulletSp.base_speed > 0 ? bulletSp.base_speed : 0;
  const dps = (bulletSp.dps || 0) * (weapon.melee_dps_multiplier || 1);

  const dir = swinger.direction;
  const [vx, vy] = DIR_DELTA[dir] ?? [0, 1];

  for (const [ox, oy] of BULLET_OFFSETS) {
    const bullet = {
      id: -(nextBulletId++),
      _spawned: true,
      _invisible: true,
      _vx: vx * speed,
      _vy: vy * speed,
      _lifespan: lifespan,
      _dpsOverride: dps,
      _playerIndex: idx,
      species_id: bulletId,
      is_consumable: false,
      direction: capitalize(dir),
      frame: {
        x: swinger.tileX + ox,
        y: swinger.tileY + oy,
        w: 1, h: 1,
      },
      dialogues: [],
    };
    state.zone.entities.push(bullet);
  }
  sfx(SFX_FOR_USAGE[weapon.equipment_usage_sound_effect] || "swordSlash");
  return true;
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : "Down"; }
