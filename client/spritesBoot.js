// Installs the client's sprite lookup into the shared species module on
// import. Without this, shared/entities.js's render path returns null
// sheets and nothing draws. Server boot does NOT import this — server-
// side sim paths don't need sprites.

import { setSpriteLookup } from "../shared/species.js";
import { getSprite } from "./assets.js";

setSpriteLookup((name) => {
  try { return getSprite(name); } catch { return null; }
});
