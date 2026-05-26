// Party registry: code minter, join, leave, GC.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPartyRegistry } from "../server/party.js";

function fakeConn(id) {
  return { id, playerId: `p_${id}`, name: `Player-${id}`, party: null };
}

test("create() returns a fresh party with a 5-char alphanumeric code", () => {
  const reg = createPartyRegistry();
  const p = reg.create();
  assert.equal(typeof p.id, "string");
  assert.ok(p.id.startsWith("pty_"));
  assert.equal(p.code.length, 5);
  assert.match(p.code, /^[A-Z2-9]+$/);
});

test("codes are unique across many parties", () => {
  const reg = createPartyRegistry();
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = reg.create();
    assert.ok(!seen.has(p.code), `duplicate code ${p.code}`);
    seen.add(p.code);
  }
});

test("getByCode is case-insensitive and returns null for unknown codes", () => {
  const reg = createPartyRegistry();
  const p = reg.create();
  assert.equal(reg.getByCode(p.code), p);
  assert.equal(reg.getByCode(p.code.toLowerCase()), p);
  assert.equal(reg.getByCode("ZZZZZ"), null);
  assert.equal(reg.getByCode(null), null);
});

test("add/remove tracks membership; empty party is GC'd", () => {
  const reg = createPartyRegistry();
  const p = reg.create();
  const a = fakeConn("a");
  const b = fakeConn("b");
  reg.add(p, a);
  reg.add(p, b);
  assert.equal(p.members.size, 2);
  assert.equal(a.party, p);

  reg.remove(p, a);
  assert.equal(p.members.size, 1);
  assert.equal(a.party, null);
  // Still alive — b is in there.
  assert.equal(reg.getByCode(p.code), p);

  reg.remove(p, b);
  assert.equal(reg.getByCode(p.code), null);
  assert.equal(reg.getById(p.id), null);
});
