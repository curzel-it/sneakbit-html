// Browser-side boot for the shared creativeMode flag. Reads
// `?creative=true|1|yes` from the URL once on import and flips the
// shared predicate. Stays browser-only so shared/ never has to know
// about location / URLSearchParams.
//
// Hard-disabled in online mode: creative tools (map editor, prefab
// dropping, save export/import) only make sense against a local zone
// the player owns. Online zones are server-authoritative.

import { setCreativeMode } from "../shared/creativeMode.js";
import { isOnlineMode } from "./onlineMode.js";

if (typeof location !== "undefined" && !isOnlineMode()) {
  const raw = (new URLSearchParams(location.search).get("creative") || "").toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") setCreativeMode(true);
}
