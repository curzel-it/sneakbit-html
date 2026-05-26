// Per-instance pressure-plate state for the authoritative server.
// Without this, every (zoneId, partyId) instance would read/write the
// same `pressure_plate_down_<color>` storage flag and two parties
// solving different puzzles would cross-trip each other's gates.
//
// The backend reads/writes through a "current instance" context set by
// `withPuzzleContext(instance, fn)` — the tick wraps tickPuzzles in this
// scope. Each instance keeps its own Map<lock, boolean> in
// `instance._plateState`.

import { setPressurePlateBackend, canonicaliseLock } from "../shared/locks.js";

let currentInstance = null;

function platesOf(instance) {
  if (!instance._plateState) instance._plateState = new Map();
  return instance._plateState;
}

const serverBackend = {
  get(lock) {
    if (!currentInstance) return false;
    return platesOf(currentInstance).get(canonicaliseLock(lock)) === true;
  },
  set(lock, down) {
    if (!currentInstance) return;
    platesOf(currentInstance).set(canonicaliseLock(lock), !!down);
  },
};

export function installServerPuzzleBackend() {
  setPressurePlateBackend(serverBackend);
}

export function withPuzzleContext(instance, fn) {
  const prev = currentInstance;
  currentInstance = instance;
  try { return fn(); }
  finally { currentInstance = prev; }
}
