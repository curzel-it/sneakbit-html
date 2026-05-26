// Browser-side persistence for the shared co-op flag. Reads the legacy
// "sneakbit.coop.v1" key on import and installs a setter that writes
// back to localStorage on every setCoopMode call.

import { installCoopBackend } from "../shared/coopMode.js";

const STORAGE_KEY = "sneakbit.coop.v1";

function readInitial() {
  if (typeof localStorage === "undefined") return false;
  try { return localStorage.getItem(STORAGE_KEY) === "1"; }
  catch { return false; }
}

installCoopBackend({
  initial: readInitial(),
  save(on) {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem(STORAGE_KEY, on ? "1" : "0"); } catch {}
  },
});
