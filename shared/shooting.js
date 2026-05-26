// Player ranged attack: spawning a Bullet entity that travels in the
// player's facing direction. pickups.js leaves player-spawned bullets
// alone (via the _spawned flag) so the thrown kunai doesn't re-collect
// itself.
//
// Bullet/entity collision is handled in combat.js — here we only spawn
// bullets and advance them through space. The bullet is removed when it
// runs out of lifespan or leaves the zone bounds; combat.js removes
// bullets that hit walls or kill targets.
//
// Pure shoot/tick logic lives here so the server simulation (and unit
// tests) can drive it without a keyboard. The keyboard wiring is in
// client/shootingInput.js.

import { getSpecies } from "./species.js";
import { getAmmo, removeAmmo } from "./inventory.js";
import { getEquipped, SLOT_RANGED } from "./equipment.js";

let sfxHandler = null;
export function setSfxHandler(fn) {
  sfxHandler = typeof fn === "function" ? fn : null;
}
function sfx(name) { if (sfxHandler) sfxHandler(name); }

const KUNAI_BULLET_SPECIES_ID = 7000;
const BULLET_SPEED = 9;           // fallback: kunai base_speed
const BULLET_LIFESPAN = 1.6;      // fallback when species lifespan missing
const COOLDOWN = 0.35;            // fallback when weapon.cooldown_after_use==0

// Maps Rust EquipmentUsageSoundEffect → audio.js sfx names.
const SFX_FOR_USAGE = {
  SwordSlash:  "swordSlash",
  GunShot:     "gunShot",
  LoudGunShot: "loudGunShot",
  KnifeThrown: "knifeThrown",
  NoAmmo:      "noAmmo",
};

const DIR_DELTA = {
  up:    [ 0, -1],
  down:  [ 0,  1],
  left:  [-1,  0],
  right: [ 1,  0],
};

let stateRef = null;
// Per-player ranged cooldown, keyed by the player object. Same shape as
// melee.js's cooldownMap. Each value is just a number (cooldown seconds
// remaining) — no swing duration here.
const cooldownMap = new WeakMap();
let nextBulletId = 1;

export function setShootingStateRef(getState) {
  stateRef = getState;
}

export function getShootingState() {
  return stateRef ? stateRef() : null;
}

// Decay shooter cooldowns and advance live bullets through space.
//
// Offline: tickShooting(dt) with no opts uses stateRef — single zone,
// state.player (and state.player2 when co-op).
// Server: tickShooting(dt, {zone, players}) — caller supplies the
// per-instance zone and the live player list so cooldowns/bullets are
// scoped to that instance.
export function tickShooting(dt, opts = {}) {
  const players = opts.players ?? offlinePlayers();
  for (const p of players) {
    const cd = cooldownMap.get(p) ?? 0;
    if (cd > 0) cooldownMap.set(p, Math.max(0, cd - dt));
  }
  const zone = opts.zone ?? stateRef?.()?.zone;
  if (zone) advanceBulletsInZone(zone, dt);
}

function offlinePlayers() {
  const state = stateRef?.();
  if (!state) return [];
  const out = [];
  if (state.player) out.push(state.player);
  if (state.player2) out.push(state.player2);
  return out;
}

// Exposed so the touch action button can trigger a shot.
export function tryShoot() {
  const state = stateRef?.();
  if (!state) return;
  shoot(state, state.player);
}

export function shoot(state, shooter) {
  const idx = (shooter?.index | 0) || 0;
  const existing = cooldownMap.get(shooter) ?? 0;
  if (existing > 0) return;
  const { weapon, bulletId } = resolveRangedWeapon(idx);
  const bulletSp = getSpecies(bulletId);
  if (!bulletSp) return;
  if (getAmmo(bulletId, idx) <= 0) { sfx("noAmmo"); return; }
  if (!removeAmmo(bulletId, 1, idx)) return;
  cooldownMap.set(shooter, (weapon?.cooldown_after_use > 0) ? weapon.cooldown_after_use : COOLDOWN);

  const dir = shooter.direction;
  const [dx, dy] = DIR_DELTA[dir] ?? DIR_DELTA.down;
  const speed = bulletSp.base_speed > 0 ? bulletSp.base_speed : BULLET_SPEED;
  const lifespan = (weapon?.bullet_lifespan > 0) ? weapon.bullet_lifespan : BULLET_LIFESPAN;
  // Spawn one tile ahead of the player so the bullet doesn't start
  // overlapping the player's own hitbox.
  const bullet = {
    id: -(nextBulletId++),
    _spawned: true,
    _vx: dx * speed,
    _vy: dy * speed,
    _lifespan: lifespan,
    _playerIndex: idx,
    species_id: bulletId,
    is_consumable: false,
    direction: capitalize(dir),
    frame: {
      x: shooter.tileX + dx,
      y: shooter.tileY + dy,
      w: 1,
      h: 1,
    },
    dialogues: [],
  };
  state.zone.entities.push(bullet);
  sfx(SFX_FOR_USAGE[weapon?.equipment_usage_sound_effect] || "knifeThrown");
}

// Picks the equipped ranged weapon's bullet species, falling back to the
// kunai bullet so the game keeps working when no species data is loaded
// (tests) or when equipment storage is empty in an unusual way.
function resolveRangedWeapon(playerIndex) {
  const weaponId = getEquipped(SLOT_RANGED, playerIndex);
  const weapon = weaponId ? getSpecies(weaponId) : null;
  if (weapon && weapon.entity_type === "WeaponRanged" && weapon.bullet_species_id) {
    return { weapon, bulletId: weapon.bullet_species_id };
  }
  return { weapon: null, bulletId: KUNAI_BULLET_SPECIES_ID };
}

function advanceBulletsInZone(zone, dt) {
  const ents = zone.entities;
  for (let i = ents.length - 1; i >= 0; i--) {
    const e = ents[i];
    if (!e._spawned) continue;
    const f = e.frame;
    f.x += e._vx * dt;
    f.y += e._vy * dt;
    e._lifespan -= dt;
    if (
      e._lifespan <= 0 ||
      f.x < -1 || f.y < -1 ||
      f.x > zone.cols || f.y > zone.rows
    ) {
      ents.splice(i, 1);
    }
  }
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : "Down"; }
