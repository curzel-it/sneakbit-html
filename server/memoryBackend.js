// Installs the in-memory storage backend used by the server. The shared
// storage module already defaults to a Map, so the "backend" here is just
// a no-op set/remove pair — there's nothing to persist in v0. This module
// exists for symmetry with client/localStorageBackend.js and so the Phase 6
// SQLite swap has one obvious place to land.

import { installStorageBackend } from "../shared/storage.js";

export function installMemoryBackend() {
  installStorageBackend({
    initial: {},
    set: () => {},
    remove: () => {},
  });
}
