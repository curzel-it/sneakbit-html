// Creative-mode predicate. Mirrors Rust's `is_creative_mode()` — the
// single source of truth other features consult to gate behavior. The
// flag is stable for the whole session (no in-game switch); browser
// entry points call setCreativeMode(true) once at boot when the URL
// carries `?creative=true`. Default is `false`.
//
// See creative-mode-requirements.md for the list of behaviors each
// gate is supposed to change once we wire them up; today this module
// only powers the save export/import gating.

let cached = false;

export function isCreativeMode() { return cached; }

export function setCreativeMode(on) { cached = !!on; }

// Test hook: same as setCreativeMode but named to make test intent
// obvious at the call site.
export function _setCreativeModeForTesting(v) { cached = !!v; }
