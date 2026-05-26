// Browser-side WebSocket client: opens the connection, exchanges hello /
// welcome, then dispatches inbound messages to per-op handlers. Outbound
// it knows about input intents, pings, and party ops (latter is Phase 3
// but the shape is stable).
//
// One-shot connect() returns the welcome payload (so callers can boot
// from it) plus a `client` object with send / on / close methods. The
// caller doesn't touch the raw WebSocket.

const PROTOCOL = 1;

export async function connectOnline({ url, uuid, joinCode = null, signal }) {
  const ws = new WebSocket(url);

  await new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(`WS connect failed: ${url}`)); };
    const onAbort = () => { cleanup(); try { ws.close(); } catch {} reject(new Error("aborted")); };
    function cleanup() {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    }
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort);
  });

  const handlers = new Map(); // op -> Set<fn>
  function on(op, fn) {
    if (!handlers.has(op)) handlers.set(op, new Set());
    handlers.get(op).add(fn);
    return () => handlers.get(op)?.delete(fn);
  }

  ws.addEventListener("message", (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    const set = handlers.get(msg.op);
    if (!set) return;
    for (const fn of set) {
      try { fn(msg); } catch (err) { console.error("ws handler threw:", err); }
    }
  });

  function send(obj) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  // Wait for welcome (or obsolete → throw and let the caller reload).
  const welcome = await new Promise((resolve, reject) => {
    const offW = on("welcome", (m) => { offW(); offO(); resolve(m); });
    const offO = on("obsolete", (m) => { offW(); offO(); reject(new Error(`obsolete: ${m.message}`)); });
    send({ op: "hello", protocol: PROTOCOL, uuid, joinCode, client: "sneakbit-html" });
  });

  // Heartbeat: spec wants a ping every 30 s; missing pings for 60 s
  // cause a server-side close (4002). 20 s gives comfortable headroom.
  const pingHandle = setInterval(() => send({ op: "ping" }), 20_000);

  function close() {
    clearInterval(pingHandle);
    try { ws.close(); } catch {}
  }

  ws.addEventListener("close", () => { clearInterval(pingHandle); });

  return {
    welcome,
    client: {
      on,
      send,
      sendIntent(intent) { send({ op: "input", intent }); },
      close,
    },
  };
}

// Resolve the server URL: explicit ?server= wins, otherwise auto-pick by
// hostname (localhost → ws://127.0.0.1:8090, else the production wss).
export function resolveServerUrl(location, searchParams) {
  const override = searchParams.get("server");
  if (override) return override;
  const host = location.hostname;
  if (!host || host === "localhost" || host === "127.0.0.1") {
    return "ws://127.0.0.1:8090/ws";
  }
  return "wss://sneakbit.curzel.it/ws";
}

const UUID_KEY = "sneakbit.online.uuid";

export function getOrCreateOnlineUuid(storage = localStorage) {
  const existing = storage.getItem(UUID_KEY);
  if (existing) return existing;
  const fresh = (crypto?.randomUUID?.() || fallbackUuid());
  storage.setItem(UUID_KEY, fresh);
  return fresh;
}

// crypto.randomUUID has been baseline in browsers since ~2022 but cheap
// to fall back for very old WebViews. Math.random is not cryptographically
// secure; that's fine — the UUID is a session token, not a secret.
function fallbackUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
