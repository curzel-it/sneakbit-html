// Browser-side boot for the shared creativeMode flag. Reads
// `?creative=true|1|yes` from the URL once on import and flips the
// shared predicate. Stays browser-only so shared/ never has to know
// about location / URLSearchParams.

import { setCreativeMode } from "../shared/creativeMode.js";

if (typeof location !== "undefined") {
  const raw = (new URLSearchParams(location.search).get("creative") || "").toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") setCreativeMode(true);
}
