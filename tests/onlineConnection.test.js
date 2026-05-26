// Unit tests for the connection helpers that don't need a live WS —
// just URL resolution and UUID minting.

import { test } from "node:test";
import assert from "node:assert/strict";

const { resolveServerUrl, getOrCreateOnlineUuid } =
  await import("../client/onlineConnection.js");

function makeFakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

test("resolveServerUrl: ?server= override wins", () => {
  const url = resolveServerUrl(
    { hostname: "curzel.it" },
    new URLSearchParams("server=ws://example.com/ws"),
  );
  assert.equal(url, "ws://example.com/ws");
});

test("resolveServerUrl: localhost → local dev server", () => {
  for (const host of ["localhost", "127.0.0.1", ""]) {
    const url = resolveServerUrl({ hostname: host }, new URLSearchParams(""));
    assert.equal(url, "ws://127.0.0.1:8090/ws");
  }
});

test("resolveServerUrl: production host → wss", () => {
  const url = resolveServerUrl({ hostname: "curzel.it" }, new URLSearchParams(""));
  assert.equal(url, "wss://sneakbit.curzel.it/ws");
});

test("getOrCreateOnlineUuid: returns stored uuid when present", () => {
  const storage = makeFakeStorage();
  storage.setItem("sneakbit.online.uuid", "8a1c1d2e-3b4f-4c5d-9e6f-7a8b9c0d1e2f");
  assert.equal(
    getOrCreateOnlineUuid(storage),
    "8a1c1d2e-3b4f-4c5d-9e6f-7a8b9c0d1e2f",
  );
});

test("getOrCreateOnlineUuid: mints and persists when absent", () => {
  const storage = makeFakeStorage();
  const first = getOrCreateOnlineUuid(storage);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(storage.getItem("sneakbit.online.uuid"), first);
  const second = getOrCreateOnlineUuid(storage);
  assert.equal(second, first);
});
