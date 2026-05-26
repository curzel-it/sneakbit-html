// Party registry. Every connected player belongs to exactly one party.
// A party owns the (zoneId, partyId)-keyed zone instances its members
// currently occupy. Solo players are a party of one — there is no
// "partyless" state on the server.
//
// Parties are looked up two ways: by id (for routing) and by join code
// (for the party.join op). Codes are 5-char alphanumeric, regenerated on
// collision. Empty parties are GC'd in leaveParty() — the registry never
// holds dangling refs.

const PARTY_PREFIX = "pty_";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
const CODE_LEN = 5;
const MAX_MEMBERS = 4;

let nextPartyId = 1;

export function createPartyRegistry() {
  const byId = new Map();
  const byCode = new Map();

  function mintCode() {
    // Loop with a retry budget — at 32^5 ≈ 33M codes the collision risk
    // is negligible for v0 traffic, but the cap protects against an
    // exhausted PRNG (or a future tighter alphabet).
    for (let attempt = 0; attempt < 50; attempt++) {
      let s = "";
      for (let i = 0; i < CODE_LEN; i++) {
        s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!byCode.has(s)) return s;
    }
    throw new Error("party code minter exhausted retries");
  }

  function create() {
    const id = PARTY_PREFIX + (nextPartyId++).toString(36);
    const code = mintCode();
    const party = {
      id,
      code,
      members: new Set(),   // Set<conn>
      instances: new Map(), // Map<zoneId, ZoneInstance>
    };
    byId.set(id, party);
    byCode.set(code, party);
    return party;
  }

  function getByCode(code) {
    if (typeof code !== "string") return null;
    return byCode.get(code.toUpperCase()) ?? null;
  }

  function getById(id) {
    return byId.get(id) ?? null;
  }

  function add(party, conn) {
    party.members.add(conn);
    conn.party = party;
  }

  function remove(party, conn) {
    party.members.delete(conn);
    if (conn.party === party) conn.party = null;
    if (party.members.size === 0) destroy(party);
  }

  function destroy(party) {
    // Mark all instances for drop. The zone-instance module owns the
    // 60s warm-idle timer; we just clear the party's reference list.
    for (const inst of party.instances.values()) {
      inst.partyGone = true;
    }
    party.instances.clear();
    byId.delete(party.id);
    byCode.delete(party.code);
  }

  function summary(party) {
    return {
      partyId: party.id,
      code: party.code,
      members: [...party.members].map((m) => ({
        playerId: m.playerId,
        name: m.name,
        self: false,
      })),
    };
  }

  return {
    create,
    getByCode,
    getById,
    add,
    remove,
    destroy,
    summary,
    maxMembers: MAX_MEMBERS,
    // Exposed for tests; production code routes through the helpers.
    _byId: byId,
    _byCode: byCode,
  };
}
