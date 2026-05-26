// Single source of truth for "are we in online mode?" Reading the URL
// query string in one place keeps every consumer (the entry-point
// dispatch, the localStorage backend, creative-mode boot, the co-op
// backend) in agreement. The boundary is set at page load — there is no
// in-game switch — so we cache the result.
//
// Authoritative spec: see authoritative-server.md § "Client modes".

let cached = null;

export function isOnlineMode() {
  if (cached !== null) return cached;
  if (typeof location === "undefined") return (cached = false);
  try {
    cached = new URLSearchParams(location.search).get("online") === "1";
  } catch {
    cached = false;
  }
  return cached;
}

// Test seam — flips the cache so tests can simulate either mode without
// touching window.location. Production code never calls this.
export function _setOnlineModeForTesting(on) {
  cached = !!on;
}
