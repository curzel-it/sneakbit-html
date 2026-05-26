// Installs the client's sfx + friendly-fire setting into the shared
// combat/melee/shooting modules on import. Without this, sword swings are
// silent and the friendly-fire toggle in Settings does nothing. Server boot
// does NOT import this — the server uses the no-op defaults (silent + FF
// off) which match the spec's "no per-conn audio, no shared damage" stance.

import { setSfxHandler as setCombatSfxHandler, setFriendlyFireGetter } from "../shared/combat.js";
import { setSfxHandler as setMeleeSfxHandler } from "../shared/melee.js";
import { setSfxHandler as setShootingSfxHandler } from "../shared/shooting.js";
import { playSfx } from "./audio.js";
import { getSettings } from "./settings.js";

setCombatSfxHandler(playSfx);
setMeleeSfxHandler(playSfx);
setShootingSfxHandler(playSfx);
setFriendlyFireGetter(() => !!getSettings().friendlyFire);
