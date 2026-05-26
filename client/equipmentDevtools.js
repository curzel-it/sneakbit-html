// Mounts the equipment API on window.equipment so devtools can flip
// loadout slots without rebuilding the page. Parity with window.skills.

import {
  getEquipped,
  setEquipped,
  clearEquipped,
  SLOT_RANGED,
  SLOT_MELEE,
} from "../shared/equipment.js";

if (typeof window !== "undefined") {
  window.equipment = {
    get:   getEquipped,
    set:   setEquipped,
    clear: clearEquipped,
    SLOT_RANGED,
    SLOT_MELEE,
  };
}
