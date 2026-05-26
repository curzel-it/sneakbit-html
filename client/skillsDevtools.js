// Browser-side persistence + devtools binding for shared/skills.js.
// Reads the localStorage override blob on import, registers a saver so
// every setSkill call writes back, then mounts window.skills for live
// tweaking from the devtools console.

import {
  installSkillsOverrideBackend,
  getSkills,
  setSkill,
  unlockSkillFromGameplay,
} from "../shared/skills.js";

const OVERRIDE_KEY = "sneakbit.skills.override.v1";

function readInitial() {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

installSkillsOverrideBackend({
  initial: readInitial(),
  save(map) {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(map)); } catch {}
  },
});

if (typeof window !== "undefined") {
  window.skills = {
    get:    getSkills,
    set:    setSkill,
    on:     (n) => setSkill(n, true),
    off:    (n) => setSkill(n, false),
    clear:  (n) => setSkill(n, null),
    unlock: unlockSkillFromGameplay,
  };
}
