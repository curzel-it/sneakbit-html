// The runnable shape of the server: an HTTP server with /health, /, and a
// /ws upgrade endpoint, wired to a party registry and a (zoneId, partyId)
// instance registry. index.js loads game data and calls createApp; tests
// do the same with a minimal raw zone and a port=0 listen.
//
// Phase 3 replaced the Phase 2 singleton instance with the registry; the
// app now routes every incoming message to the connection's current
// (party, instance) pair, and handles party.* / travel ops alongside the
// existing input/ping path.

import { createServer } from "node:http";

import {
  applyInputIntent,
  createConnection,
  makeDisplayName,
  makePlayerId,
  sendJson,
} from "./connection.js";
import { createPartyRegistry } from "./party.js";
import { startTick } from "./tick.js";
import { attachWebSockets } from "./ws.js";
import {
  addConnection,
  createInstanceRegistry,
  removeConnection,
  resolveTravelSpawn,
  snapshotZone,
  spawnAtStarting,
  placePlayer,
  teleporterUnderFoot,
} from "./zoneInstance.js";
import { STARTING_ZONE_ID } from "../shared/constants.js";

export const PROTOCOL = 1;
export const DEFAULT_GHOST_GRACE_MS = 30_000;

export function createApp({
  loadRawZone,
  startingZoneId = STARTING_ZONE_ID,
  autoTick = true,
  ghostGraceMs = DEFAULT_GHOST_GRACE_MS,
}) {
  if (typeof loadRawZone !== "function") {
    throw new Error("createApp: loadRawZone(zoneId) is required");
  }
  const parties = createPartyRegistry();
  const instances = createInstanceRegistry({ loadRawZone });
  const byUuid = new Map(); // uuid -> conn (live connections; used for 4003)

  // Tests that exercise tickOnce() directly opt out of the timer.
  const stopTick = autoTick ? startTick(instances) : () => {};

  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok\n");
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("hello from sneakbit server\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  });

  const ctx = { parties, instances, byUuid, startingZoneId, ghostGraceMs };

  attachWebSockets(httpServer, {
    onConnect(ws) {
      const conn = createConnection({ ws });

      ws.on("message", (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (typeof msg !== "object" || msg === null) return;
        handleMessage(ctx, conn, msg).catch((err) => {
          console.error(`[conn ${conn.id}] message handler threw:`, err);
        });
      });

      ws.on("close", () => onDisconnect(ctx, conn));
      ws.on("error", () => {});
    },
  });

  return { httpServer, parties, instances, ctx, stopTick };
}

export async function handleMessage(ctx, conn, msg) {
  if (msg.op === "hello") {
    await handleHello(ctx, conn, msg);
    return;
  }

  if (!conn.helloDone) return;

  switch (msg.op) {
    case "input":
      if (typeof msg.intent === "string") applyInputIntent(conn, msg.intent);
      return;
    case "ping":
      sendJson(conn, { op: "pong" });
      return;
    case "travel":
      await handleTravel(ctx, conn, msg);
      return;
    case "party.create":
      await handlePartyCreate(ctx, conn);
      return;
    case "party.join":
      await handlePartyJoin(ctx, conn, msg);
      return;
    case "party.leave":
      await handlePartyLeave(ctx, conn);
      return;
    default:
      // Unknown ops dropped silently — spec, "Message catalogue".
      return;
  }
}

async function handleHello(ctx, conn, msg) {
  if (conn.helloDone) return;
  if (typeof msg.protocol !== "number" || msg.protocol < PROTOCOL) {
    sendJson(conn, { op: "obsolete", minProtocol: PROTOCOL, message: "please reload" });
    conn.ws.close(4001, "obsolete protocol");
    return;
  }
  if (typeof msg.uuid !== "string" || msg.uuid.length === 0) {
    conn.ws.close(4001, "uuid required");
    return;
  }
  // Ghost reconnect — checked BEFORE the 4003 conflict path. If the same
  // UUID is still in byUuid but the original conn was ghosted (WS closed
  // within the last 30s), restore the session: cancel the finalize timer,
  // re-route the new WS into the existing conn, and send a fresh welcome
  // with the current zone state. The existing conn keeps its place in
  // byUuid / party.members / zoneInstance.connections, so neighbours
  // don't see a partyUpdate or a player-removed delta.
  const existing = ctx.byUuid.get(msg.uuid);
  if (existing && existing.ghostExpiresAt) {
    rebindWsToConn(ctx, existing, conn.ws);
    clearTimeout(existing.ghostTimer);
    existing.ghostExpiresAt = null;
    existing.ghostTimer = null;
    console.log(
      `[conn ${existing.id}] ghost reconnect uuid=${msg.uuid.slice(0, 8)} ` +
      `player=${existing.playerId} zone=${existing.zoneInstance?.zone?.id}`
    );
    sendJson(existing, {
      op: "welcome",
      protocol: PROTOCOL,
      playerId: existing.playerId,
      partyId: existing.party.id,
      partyCode: existing.party.code,
      members: membersFor(existing.party, existing),
      zone: {
        id: existing.zoneInstance.zone.id,
        tick: existing.zoneInstance.tick,
        state: snapshotZone(existing.zoneInstance),
      },
    });
    return;
  }
  // 4003 — same UUID already online (and not ghosted). The spec calls
  // this out as the "two tabs sharing localStorage" case; treat the *new*
  // connection as the offender so a refresh in tab A doesn't kick tab A
  // out of the game while the new tab takes over.
  if (ctx.byUuid.has(msg.uuid)) {
    sendJson(conn, { op: "event", kind: "uuidConflict" });
    conn.ws.close(4003, "uuid already connected");
    return;
  }

  conn.uuid = msg.uuid;
  conn.playerId = makePlayerId(msg.uuid);
  conn.name = makeDisplayName(conn.playerId);
  conn.helloDone = true;
  ctx.byUuid.set(conn.uuid, conn);

  // Party assignment: a non-empty joinCode tries to join; anything else
  // (or a failed join) puts the player in a fresh party-of-one.
  let party = null;
  if (typeof msg.joinCode === "string" && msg.joinCode.length > 0) {
    const found = ctx.parties.getByCode(msg.joinCode);
    if (found && found.members.size < ctx.parties.maxMembers) {
      party = found;
    }
  }
  if (!party) party = ctx.parties.create();
  ctx.parties.add(party, conn);

  const instance = await ctx.instances.getOrCreate(ctx.startingZoneId, party);
  spawnAtStarting(conn);
  addConnection(instance, conn);

  console.log(
    `[conn ${conn.id}] hello uuid=${conn.uuid.slice(0, 8)} ` +
    `player=${conn.playerId} party=${party.id} code=${party.code} ` +
    `zone=${instance.zone.id}`
  );

  sendJson(conn, {
    op: "welcome",
    protocol: PROTOCOL,
    playerId: conn.playerId,
    partyId: party.id,
    partyCode: party.code,
    members: membersFor(party, conn),
    zone: {
      id: instance.zone.id,
      tick: instance.tick,
      state: snapshotZone(instance),
    },
  });

  // Other members in the same instance need to see the joiner appear in
  // their `members` list, and re-render the zone with the new player.
  broadcastPartyUpdate(ctx, party, { except: conn });
}

async function handleTravel(ctx, conn, msg) {
  const instance = conn.zoneInstance;
  if (!instance) return;
  const tele = teleporterUnderFoot(instance, conn);
  if (!tele) return;
  // Optional viaEntityId — when present, validate the player meant the
  // entity we just resolved. Mismatch = stale client; drop silently.
  if (typeof msg.viaEntityId === "number" && tele.id !== msg.viaEntityId) return;

  const destZoneId = tele.destination?.zone;
  if (typeof destZoneId !== "number" || destZoneId <= 0) return;
  if (destZoneId === instance.zone.id) return;

  const sourceZoneId = instance.zone.id;
  const party = conn.party;
  if (!party) return;

  const destInstance = await ctx.instances.getOrCreate(destZoneId, party);

  // Remove first so the source instance's broadcast in this same tick
  // doesn't include the traveler.
  removeConnection(instance, conn);
  ctx.instances.scheduleDrop(instance);

  const [spawnX, spawnY] = resolveTravelSpawn(destInstance.zone, tele.destination, sourceZoneId);
  destInstance.zone.spawnPoint = { x: spawnX, y: spawnY };
  placePlayer(conn, spawnX, spawnY, tele.destination?.direction);
  addConnection(destInstance, conn);

  console.log(
    `[conn ${conn.id}] travel ${sourceZoneId} -> ${destZoneId} ` +
    `via entity ${tele.id} party=${party.id}`
  );

  // The traveling client gets a full snapshot of the new instance so it
  // can rebuild its zone state from scratch.
  sendJson(conn, {
    op: "event",
    kind: "zoneChange",
    zoneId: destInstance.zone.id,
    tick: destInstance.tick,
    snapshot: snapshotZone(destInstance),
  });
}

async function handlePartyCreate(ctx, conn) {
  // Leave current party (GC if empty), open a fresh party-of-one.
  await moveToPartyOfOne(ctx, conn);
}

async function handlePartyJoin(ctx, conn, msg) {
  const code = typeof msg.code === "string" ? msg.code.toUpperCase() : "";
  const target = ctx.parties.getByCode(code);
  if (!target) {
    sendJson(conn, { op: "event", kind: "partyJoinFailed", reason: "not_found" });
    return;
  }
  if (target === conn.party) {
    sendJson(conn, { op: "event", kind: "partyJoinFailed", reason: "same_party" });
    return;
  }
  if (target.members.size >= ctx.parties.maxMembers) {
    sendJson(conn, { op: "event", kind: "partyJoinFailed", reason: "full" });
    return;
  }
  await switchParty(ctx, conn, target);
}

async function handlePartyLeave(ctx, conn) {
  await moveToPartyOfOne(ctx, conn);
}

async function moveToPartyOfOne(ctx, conn) {
  const fresh = ctx.parties.create();
  await switchParty(ctx, conn, fresh);
}

async function switchParty(ctx, conn, target) {
  const oldParty = conn.party;
  const oldInstance = conn.zoneInstance;
  const currentZoneId = oldInstance ? oldInstance.zone.id : ctx.startingZoneId;

  if (oldInstance) {
    removeConnection(oldInstance, conn);
    ctx.instances.scheduleDrop(oldInstance);
  }
  if (oldParty) {
    ctx.parties.remove(oldParty, conn);
    if (oldParty.members.size > 0) broadcastPartyUpdate(ctx, oldParty);
  }

  ctx.parties.add(target, conn);
  // Land the player in the target party's instance of the same zone.
  // Mirrors the offline behavior of "you keep your zone, your party
  // changes." If no instance exists yet, create it and spawn fresh.
  const destInstance = await ctx.instances.getOrCreate(currentZoneId, target);
  if (destInstance.connections.size === 0) {
    // Fresh-build of the destination zone instance: spawn at start.
    spawnAtStarting(conn);
  } else {
    // Spawn the joiner at the party's existing reference point — fall
    // back to STARTING_SPAWN if we don't have a better one yet. (Phase 4
    // will track per-party rally points; v0 just clones the entry tile.)
    spawnAtStarting(conn);
  }
  addConnection(destInstance, conn);

  sendJson(conn, {
    op: "event",
    kind: "zoneChange",
    zoneId: destInstance.zone.id,
    tick: destInstance.tick,
    snapshot: snapshotZone(destInstance),
  });

  broadcastPartyUpdate(ctx, target);

  console.log(
    `[conn ${conn.id}] party switch -> ${target.id} code=${target.code} ` +
    `zone=${destInstance.zone.id}`
  );
}

// WS close → start the ghost-grace timer. The player's entity stays in
// the instance (frozen — tick.js filters ghosted conns out of input and
// combat), so neighbours see no partyUpdate and the player can resume in
// place when they re-hello with the same UUID within ghostGraceMs.
//
// If the timer expires without a reconnect, finalizeGhost removes the
// player from the party / instance for real.
function onDisconnect(ctx, conn) {
  if (!conn.helloDone) return;
  // Already ghosted (the new WS is rebinding, the close on the old WS
  // arrives here). No-op — handleHello cleared the timer.
  if (conn.ghostExpiresAt == null && conn.ghostTimer == null && !ctx.byUuid.has(conn.uuid)) {
    // Race: finalize fired before close. No-op.
    return;
  }
  if (conn.ghostExpiresAt != null) {
    // We're already ghosting (a rebind happened and the old WS just
    // closed). Don't restart the timer.
    return;
  }
  console.log(
    `[conn ${conn.id}] ws closed -> ghost grace ${ctx.ghostGraceMs}ms ` +
    `player=${conn.playerId}`
  );
  conn.ghostExpiresAt = Date.now() + ctx.ghostGraceMs;
  conn.input.held.clear();
  conn.input.actions.length = 0;
  conn.ghostTimer = setTimeout(() => finalizeGhost(ctx, conn), ctx.ghostGraceMs);
  conn.ghostTimer.unref?.();
}

function finalizeGhost(ctx, conn) {
  // Already restored (handleHello cleared the timer just before we fired).
  if (conn.ghostExpiresAt == null) return;
  console.log(`[conn ${conn.id}] ghost expired, finalizing player=${conn.playerId}`);
  conn.ghostExpiresAt = null;
  conn.ghostTimer = null;
  ctx.byUuid.delete(conn.uuid);
  const oldInstance = conn.zoneInstance;
  if (oldInstance) {
    removeConnection(oldInstance, conn);
    ctx.instances.scheduleDrop(oldInstance);
  }
  const party = conn.party;
  if (party) {
    ctx.parties.remove(party, conn);
    if (party.members.size > 0) broadcastPartyUpdate(ctx, party);
  }
}

// Re-route a fresh WS's message/close listeners to dispatch to `target`
// (the ghost-restored conn). The original listeners on the new WS were
// closed over the discarded carrier conn; we replace them so subsequent
// frames go to the existing conn.
function rebindWsToConn(ctx, target, newWs) {
  newWs.removeAllListeners("message");
  newWs.removeAllListeners("close");
  newWs.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (typeof msg !== "object" || msg === null) return;
    handleMessage(ctx, target, msg).catch((err) => {
      console.error(`[conn ${target.id}] message handler threw:`, err);
    });
  });
  newWs.on("close", () => onDisconnect(ctx, target));
  target.ws = newWs;
}

function membersFor(party, selfConn) {
  return [...party.members].map((m) => ({
    playerId: m.playerId,
    name: m.name,
    self: m === selfConn,
  }));
}

function broadcastPartyUpdate(ctx, party, { except = null } = {}) {
  for (const m of party.members) {
    if (m === except) continue;
    sendJson(m, {
      op: "event",
      kind: "partyUpdate",
      partyId: party.id,
      code: party.code,
      members: membersFor(party, m),
    });
  }
}
