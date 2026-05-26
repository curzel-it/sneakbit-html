// WebSocket transport: thin wrapper around `ws` that mounts on /ws and
// hands each new socket to onConnect. Anything else lives in connection.js
// (per-socket state) or index.js (message routing).

import { WebSocketServer } from "ws";

export function attachWebSockets(httpServer, { onConnect }) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      // Anything other than /ws is left to the HTTP handler (which 404s).
      // Destroying the socket here keeps the connection from hanging.
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnect(ws, req);
    });
  });

  return wss;
}
