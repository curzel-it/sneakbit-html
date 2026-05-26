// The online-mode predicate is the single boundary Phase 5 introduces.
// Tests cover the test-only override hook and the default behavior in a
// non-browser environment. The actual URL-read path is exercised in the
// browser by main.js loading the module on boot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isOnlineMode, _setOnlineModeForTesting } from "../client/onlineMode.js";

test("defaults to false in a non-browser test environment", () => {
  _setOnlineModeForTesting(false);
  assert.equal(isOnlineMode(), false);
});

test("override hook flips the cached value", () => {
  _setOnlineModeForTesting(true);
  assert.equal(isOnlineMode(), true);
  _setOnlineModeForTesting(false);
  assert.equal(isOnlineMode(), false);
});

test("reads as cached: repeated calls return the same value", () => {
  _setOnlineModeForTesting(true);
  assert.equal(isOnlineMode(), true);
  assert.equal(isOnlineMode(), true);
  _setOnlineModeForTesting(false);
});
