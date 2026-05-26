// Unlockable combat skills, mirroring the original game_core flags:
//   * piercing  → kunai does 2x damage (red ninja quest reward)
//   * boomerang → kunai bounces back on wall/kill   (black ninja)
//   * catcher   → caught bullets refund into ammo  (blue ninja)
//
// In-game acquisition path: reading the corresponding "gain_…_skill"
// dialogue marks dialogue.answer.<text>=1 (see dialogue.js::handleReward).
// has*Skill() reads those storage keys so the unlock survives reload
// without us needing a side cache.
//
// A tiny per-skill devtools override (true/false/null) pins the skill on
// or off regardless of the dialogue state. The browser persists the
// override map to localStorage via client/skillsDevtools.js; node-side
// tests start with everything null.

import { getValue, setValue } from "./storage.js";

const DIALOGUE_KEYS = {
  piercing:  "dialogue.answer.quest.ninja_skills.red_ninja.gain_piercing_knife_skill",
  boomerang: "dialogue.answer.quest.ninja_skills.black_ninja.gain_bouncing_knifes_skill",
  catcher:   "dialogue.answer.quest.ninja_skills.blue_ninja.gain_knife_catcher_skill",
};

const overrides = { piercing: null, boomerang: null, catcher: null };
const listeners = new Set();
let saveOverrides = null;

function normaliseOverride(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  return null;
}

export function installSkillsOverrideBackend({ initial, save } = {}) {
  if (initial && typeof initial === "object") {
    overrides.piercing  = normaliseOverride(initial.piercing);
    overrides.boomerang = normaliseOverride(initial.boomerang);
    overrides.catcher   = normaliseOverride(initial.catcher);
  }
  saveOverrides = typeof save === "function" ? save : null;
}

function isUnlocked(name) {
  if (overrides[name] === true) return true;
  if (overrides[name] === false) return false;
  const key = DIALOGUE_KEYS[name];
  if (!key) return false;
  return getValue(key) === 1;
}

export function hasPiercingKnifeSkill() { return isUnlocked("piercing"); }
export function hasBoomerangSkill()      { return isUnlocked("boomerang"); }
export function hasBulletCatcherSkill()  { return isUnlocked("catcher"); }

// Devtools toggle: pins the flag on/off regardless of dialogue progress.
export function setSkill(name, on) {
  if (!(name in overrides)) return;
  overrides[name] = on == null ? null : !!on;
  if (saveOverrides) saveOverrides({ ...overrides });
  for (const fn of listeners) fn(getSkills());
}

// Grants the skill the way the in-game dialogue would: marks the
// "gain_*_skill" dialogue as answered. Useful for pickup/reward paths
// that want to unlock without going through the dialogue overlay.
export function unlockSkillFromGameplay(name) {
  const key = DIALOGUE_KEYS[name];
  if (!key) return;
  setValue(key, 1);
  for (const fn of listeners) fn(getSkills());
}

export function getSkills() {
  return {
    piercing:  hasPiercingKnifeSkill(),
    boomerang: hasBoomerangSkill(),
    catcher:   hasBulletCatcherSkill(),
  };
}

export function onSkillsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Re-emit listener updates when storage changes outside of this module
// (e.g. dialogue.js writes the dialogue.answer key on close).
export function _notifySkillsChanged() {
  for (const fn of listeners) fn(getSkills());
}
