// The runnable shape of the server: an HTTP server with /health, /, and a
// /ws upgrade endpoint, wired to a single zone instance. index.js loads
// game data and calls createApp; tests do the same with a minimal raw zone
// and a port=0 listen.

import { createServer } from "node:http";

import {
  applyInputIntent,
  createConnection,
  makeDisplayName,
  makePlayerId,
  sendJson,
} from "./connection.js";
import { startTick } from "./tick.js";
import { attachWebSockets } from "./ws.js";
import {
  addConnection,
  createZoneInstance,
  removeConnection,
  snapshotZone,
} from "./zoneInstance.js";

export const PROTOCOL = 1;

export function createApp({ rawZone, autoTick = true }) {
  const instance = createZoneInstance({ rawZone });
  // Tests that exercise tickOnce() directly opt out of the timer.
  const stopTick = autoTick ? startTick(instance) : () => {};

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

  attachWebSockets(httpServer, {
    onConnect(ws) {
      const conn = createConnection({ ws, instance });

      ws.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (typeof msg !== "object" || msg === null) return;
        handleMessage(instance, conn, msg);
      });

      ws.on("close", () => {
        if (conn.helloDone) removeConnection(instance, conn);
      });

      ws.on("error", () => {});
    },
  });

  return { httpServer, instance, stopTick };
}

export function handleMessage(instance, conn, msg) {
  if (msg.op === "hello") {
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
    conn.uuid = msg.uuid;
    conn.playerId = makePlayerId(msg.uuid);
    conn.name = makeDisplayName(conn.playerId);
    conn.helloDone = true;
    addConnection(instance, conn);
    sendJson(conn, {
      op: "welcome",
      protocol: PROTOCOL,
      playerId: conn.playerId,
      // Phase 2 has no party concept. The wire shape stays stable for
      // Phase 3 by sending stub identifiers — every solo connection is
      // its own "party of one" from the client's POV.
      partyId: "pty_solo_" + conn.id,
      partyCode: "SOLO" + String(conn.id).padStart(2, "0"),
      members: [{ playerId: conn.playerId, name: conn.name, self: true }],
      zone: {
        id: instance.zone.id,
        tick: instance.tick,
        state: snapshotZone(instance),
      },
    });
    return;
  }

  if (!conn.helloDone) return;

  if (msg.op === "input") {
    if (typeof msg.intent === "string") applyInputIntent(conn, msg.intent);
    return;
  }

  if (msg.op === "ping") {
    sendJson(conn, { op: "pong" });
    return;
  }

  // Unknown ops dropped silently — spec, "Message catalogue".
}
