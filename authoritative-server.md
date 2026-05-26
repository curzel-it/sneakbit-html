# Authoritative Server — SneakBit Online

The endgame is an MMO: party-instanced zones, persistent characters, eventually shops and quests. This document is the single authoritative spec for how the online server is built and how it talks to the client. Nothing else (CLAUDE.md, README.md, code comments) overrides this file.

## Confirmed agreements

1. **Client distribution stays on GitHub Pages** at <https://curzel.it/sneakbit-html>. The VPS hosts only the Node server.
2. **Client has two modes** selected by URL: offline (default, no param) and online (`?online=1`). The two have **separate save state** — switching modes is switching characters, not reconnecting.
3. **Zone instances are party-scoped.** Each `(zoneId, partyId)` is a separate live instance. Two players in the same zone but in different parties see different instances.
4. **Parties are formed by join code** (e.g. `K7MJ2`, 5 alphanumeric chars). No accounts. The Party panel is reachable from the pause menu (HTML, not canvas).
5. **The server is fully authoritative.** Client sends input intents and renders snapshots; it owns nothing simulation-side. Anti-cheat is the natural consequence, not a separate system.

## Vocabulary

- **Zone** — a small, thematically-coherent piece of the map: a single floor of a maze, a house interior, a city, a forest clearing. The map is many zones connected by teleporters. (Formerly "world" in the codebase — renamed.)
- **Zone instance** — a live, ticking copy of a zone. The same zone can have many concurrent instances; each party gets its own.
- **Party** — a user-defined group of online players who share zone instances. A solo online player is a party of one.
- **Client mode** — `offline` or `online`. See agreement 2.
- **Tick** — one step of the authoritative simulation. Server runs at a fixed rate (default 10 Hz).
- **Snapshot** — server-broadcast state delta consumed by every client in a zone instance.
- **Input intent** — a high-level player command (`moveUp`, `interact`, `shoot`). The client sends intents, never authoritative state.

## Architecture at a glance

```
client (online)               server                          client (online)
─────────────────             ─────────────                   ─────────────────
input intents      ────WS───► input queue
                              party / instance routing
                              authoritative tick (10 Hz)
                              snapshot + events  ──WS────►   render
render            ◄────WS─── snapshot + events
```

- Single Node process. One process owns every zone instance, every party, every connection.
- WebSocket transport. JSON frames. Versioned handshake.
- No DB in v0: all state is in process memory. Server restart = everyone disconnects, online progress lost. Acceptable while solo dev iterates.
- Simulation modules in `shared/` run on both sides. Client-only modules (renderer, audio, input, HUD, save) live in `client/`. Server-only modules (WS, party routing, tick driver) live in `server/`.

## Authority boundaries

| Concern | Owner in online mode |
|---|---|
| Player position, HP, inventory, equipment, current zone | server |
| Zone state (entities, gates, pushables, mob HPs, dropped items) | server (per instance) |
| Mob/NPC behavior | server |
| Combat resolution, damage, death, respawn | server |
| Pickups, loot drops | server |
| Zone transitions (teleporters) | server |
| Cutscenes, dialogue progression | server (state); client renders the UI |
| Camera, zoom, animation interpolation | client |
| Audio, music | client |
| HUD, menus, settings, key bindings, touch/gamepad mapping | client |
| Save state (online) | server |
| Save state (offline) | client localStorage (unchanged from today) |
| Creative mode, map editor | client only — **hard-disabled in online mode** |

## Identity

- On first run, the client generates a **UUIDv4** and persists it in `localStorage` under `sneakbit.online.uuid`. Sent on every WS connect.
- The server uses the UUID as the player key. No usernames, no accounts, no auth in v0.
- Reconnect with the same UUID within 30 seconds → resume position and state. Beyond 30 seconds → respawn at the entry tile of the last known zone.
- Display name in v0: shortened UUID prefix (e.g. `Player-a3f9`). User-chosen names are a Phase 4 concern.

## Parties

**Every online player belongs to exactly one party. Zone instances are scoped to a party.** Two players in the same zone but in different parties see different instances and do not see each other. Two players in the same party always share a zone instance when in the same zone.

- A connected player with no party is auto-assigned a fresh party-of-one.
- Party creation is implicit on connect. The party gets a short, human-typable **join code** (e.g. `K7MJ2`, 5 alphanumeric chars).
- The current party's join code is shown in the client in a dedicated **Party panel** reachable from the pause menu (HTML, not canvas). The panel is the single place to see your code, enter another code, leave the party, and see who else is connected. The HUD itself stays unchanged — local co-op already uses HUD slots for P1/P2, and the online-party state is separate enough to live behind a menu entry.
- Joining: enter a code in the client; server moves the joiner into that party. The joiner's old solo party is destroyed if empty.
- Leaving: explicit "Leave party" action. Returns the player to a fresh party-of-one.
- Party persists while at least one member is online. Once empty, the party (and all its zone instances) is garbage-collected.
- Max party size: **4** in v0. Soft cap, easy to raise.

## Zone instances

- A zone instance is `(zoneId, partyId)`. Lazily created when the first party member enters a zone they don't yet have an instance of.
- When the last party member leaves a zone, the instance is **kept warm for 60 seconds** so brief detours (open door, look around, come back) don't reset state. After 60 s of zero attendance the instance is dropped and its state is forgotten.
- Re-entering a dropped instance respawns it from raw zone data — equivalent to the current offline behavior of "world transitions reload the zone fresh."
- A zone instance only ticks when at least one party member is connected and present in it. Idle instances cost zero CPU.

## Server tick

- **Rate:** 10 Hz (configurable; tile-locked movement makes 10 Hz feel fine because the client interpolates between snapshots).
- **Loop:** for each non-idle instance, drain its input queue, run the sim modules in `tickOrder`, compute delta vs last broadcast, send `delta` to every connected member.
- **Cost:** an idle zone is free. A populated zone is dominated by mob AI and combat, both `O(entities)`.
- The same `tickOrder` the client uses today (player → mobs → monster fusion → minion spawning → combat → after-dialogue → puzzles → cutscenes → trails → pushables → player-health) is reused verbatim on the server. Phase 1 of the rollout makes that possible.

## Client modes

- **Offline (default).** `index.html` with no query param. Current behavior preserved exactly: localStorage save, local tick, creative mode, map editor available.
- **Online.** `index.html?online=1`. Optional `&server=ws://host:port` for dev. The client:
  - reads its UUID from localStorage (generates one if missing)
  - skips the local tick
  - opens a WS
  - applies snapshots/deltas to a local render state
  - sends input intents
  - disables creative mode and the map editor
- **Switching modes** is a manual reload with a different URL. Online and offline saves are **separate** — they don't migrate into each other.

## Data files

- `data/` (sprite atlases, species, strings, level JSON) ships in both client and server deploys.
- Server reads `data/` from the local filesystem. Client `fetch`es it. The same loader modules support both via injected I/O.
- Client and server must be deployed together — the protocol is version-locked, not data-version-locked, but mismatched zone JSON would diverge sims.

## Disconnect & reconnect

- Hard disconnect (WS close): server marks the player slot as ghosted with a 30 s timeout. The player's entity stays in the zone instance frozen in place during the grace period.
- Reconnect with the same UUID within the grace period: server clears the ghost flag and resumes. Position and state are exactly where they were.
- Timeout expiry: the ghosted player is removed from the zone. If they reconnect later, they spawn at the entry tile of the last known zone.
- Server restart: every connection drops, every UUID's session is forgotten (in-memory model). Clients receive close code 4500 and show a "server restarted — reconnect?" toast.

## Persistence (v0: none)

- All state lives in process memory.
- A server restart wipes online progress — both intentionally and unavoidably given the in-memory choice.
- This is acceptable while we iterate. Persistence (`better-sqlite3`) is Phase 6.

## Anti-cheat posture (v0)

- Server is authoritative for everything except UI. Clients cannot edit state — they can only send input intents.
- Input rate-limited per connection (max 30 intents/sec, plenty for keymash combat).
- Sane bounds checked: a movement intent that would land out of zone, on a non-walkable tile, or through an obstacle is dropped silently.
- No deeper anti-cheat in v0. The cost of cheating is "you ruined a casual session with 0–3 strangers." Anything stricter is wasted on a hobby project.

The client cannot:
- Move its own avatar — only send a movement intent; the server validates and applies.
- Add to its inventory — only the server emits `pickup` events.
- Open a gate, push a pushable, deal damage, complete a puzzle, advance dialogue — all server-side.
- Choose its display name in v0.

The client can:
- Render the world however it wants (skins, particles, animation timing).
- Manage its own UI state — open menu, change zoom, mute audio.
- Lie about whether it has paused — irrelevant to the server.

---

# Wire protocol

## Transport

- **WebSocket.** TLS in production (`wss://sneakbit.curzel.it/ws`), plain in dev (`ws://localhost:8090/ws`).
- **Framing:** one JSON object per WebSocket frame. UTF-8.
- **Direction:** full duplex. The client sends input intents on edge (key down/up); the server pushes snapshots and events at the tick rate.
- **Endpoint:** `/ws`. The dev server may expose it as `/`; the production nginx vhost mounts `/ws` explicitly with WebSocket upgrade headers.

## Versioning

Every connection negotiates a single `protocol` integer.

- Client opens the WS and sends `hello` with the version it speaks.
- Server matches → responds with `welcome`.
- Below the server's `minProtocol` → server responds with `obsolete` and closes (code 4001). Client must reload.
- **No compatibility shim.** Server and client are always deployed together. `protocol` exists so a stale tab can detect a deploy and self-heal.

## Connection lifecycle

```
1. Client opens WS
2. C → S: hello
3. S → C: welcome (or obsolete + close)
4. Steady state:
     C → S: input | travel | party.* | ping
     S → C: snapshot | delta | event | pong
5. Either side closes the WS
     - Server-initiated closes carry a 4xxx reason code (see "Close codes")
     - Client-initiated close: clean disconnect, server enters the 30s ghost grace
6. Reconnect: another WS open + hello with the same UUID
     - Within 30s: server clears ghost flag, resumes the player in place
     - After 30s: server creates a fresh session, spawns at the entry tile of the last known zone
```

## Message catalogue

Every message has an `op` discriminant. Below: `C →` means client → server, `S →` means server → client. Unknown ops are dropped silently.

### `hello` (C →)

The first frame on a new WebSocket. The server ignores any other frame until it receives `hello`.

```jsonc
{
  "op": "hello",
  "protocol": 1,
  "uuid": "8a1c1d2e-3b4f-4c5d-9e6f-7a8b9c0d1e2f",
  "joinCode": "K7MJ2" | null,   // present if the client wants to join an existing party on connect
  "client": "sneakbit-html"     // free-form, useful for logs
}
```

### `welcome` (S →)

Sent in response to a valid `hello`. Carries everything the client needs to render the first frame: the party shape, the assigned player id, and a full snapshot of the zone the player landed in.

```jsonc
{
  "op": "welcome",
  "protocol": 1,
  "playerId": "p_a3f9b1",
  "partyId": "pty_8c3f12",
  "partyCode": "K7MJ2",
  "members": [
    {"playerId":"p_a3f9b1","name":"Player-a3f9","self":true},
    {"playerId":"p_b1d2e3","name":"Player-b1d2","self":false}
  ],
  "zone": {
    "id": 1001,
    "tick": 0,
    "state": { /* full zone snapshot — see "Zone snapshot shape" */ }
  }
}
```

### `obsolete` (S →)

```jsonc
{"op":"obsolete","minProtocol":2,"message":"please reload"}
```

### `input` (C →)

```jsonc
{
  "op": "input",
  "intent": "moveUp" | "moveDown" | "moveLeft" | "moveRight"
          | "stopMove"
          | "interact"
          | "shoot"
          | "melee"
}
```

Sent on edge (key down / key up), not per-tick. Rate limit: 30/sec per connection; excess dropped silently.

### `travel` (C →)

Client suggests the teleporter under its feet; server validates and resolves the actual destination.

```jsonc
{"op":"travel","viaEntityId":12345}
```

Server replies with an `event:zoneChange`. If the entity isn't actually a teleporter under the player's foot, the server drops the message silently — the client cannot force a zone change.

### Party ops (C →)

```jsonc
{"op":"party.create"}                  // leave current, create a fresh party-of-one
{"op":"party.join","code":"K7MJ2"}     // join existing
{"op":"party.leave"}                   // leave; server creates a fresh party-of-one
```

Each replies with an `event:partyUpdate` on success. `party.join` may reply with `event:partyJoinFailed` (reasons: `not_found`, `full`, `same_party`).

### `ping` (C →) / `pong` (S →)

Heartbeat. The server expects a `ping` at least every 30 seconds; missing pings for 60 seconds cause a close with code 4002 (idle timeout).

### `snapshot` (S →)

Full zone-instance state. Sent on join, zone change, and reconnect-after-grace.

```jsonc
{
  "op": "snapshot",
  "tick": 1234,
  "zone": { "id": 1001, "state": { /* see "Zone snapshot shape" */ } }
}
```

### `delta` (S →)

Per-tick deltas at 10 Hz. Only changed fields appear.

```jsonc
{
  "op": "delta",
  "tick": 1235,
  "players": [
    {"playerId":"p_a3f9b1","x":12.0,"y":7.0,"tileX":12,"tileY":7,"direction":"right","hp":95,"step":"midwalk"}
  ],
  "entities": [
    {"id":4242,"hp":12,"_open":true}
  ],
  "removed": { "entities": [9999] }
}
```

Sparse — the client maintains its own zone state machine and merges deltas in. Absent = unchanged.

### `event` (S →)

Discrete one-shot occurrences. Examples:

```jsonc
{"op":"event","kind":"zoneChange","zoneId":1002,"snapshot":{...},"tick":N}
{"op":"event","kind":"dialogueOpen","forPlayerId":"p_a3f9b1","entityId":4321,"lines":["..."]}
{"op":"event","kind":"dialogueAdvance","forPlayerId":"p_a3f9b1","lineIdx":2}
{"op":"event","kind":"dialogueClose","forPlayerId":"p_a3f9b1"}
{"op":"event","kind":"pickup","playerId":"p_a3f9b1","speciesId":5,"amount":1}
{"op":"event","kind":"death","playerId":"p_a3f9b1"}
{"op":"event","kind":"respawn","playerId":"p_a3f9b1","zoneId":1001,"x":3.0,"y":3.0}
{"op":"event","kind":"partyUpdate","partyId":"...","code":"K7MJ2","members":[...]}
{"op":"event","kind":"partyJoinFailed","reason":"not_found"|"full"|"same_party"}
{"op":"event","kind":"toast","forPlayerId":"p_a3f9b1","textKey":"notification.pickup","args":{"name":"Coin"}}
{"op":"event","kind":"cutsceneStart","zoneId":1001,"id":"intro"}
{"op":"event","kind":"cutsceneEnd","zoneId":1001,"id":"intro"}
```

`event` kinds are extensible; the client must ignore unknown kinds.

## Zone snapshot shape

The `state` payload on `welcome` / `snapshot` / `event:zoneChange` is a single object:

```jsonc
{
  "id": 1001,
  "tick": 1234,
  "zoneType": "HouseInterior",
  "rows": 30, "cols": 60,
  "biomeTiles":        { "sheet_id": N, "tiles": ["...","..."] },
  "constructionTiles": { "sheet_id": N, "tiles": ["...","..."] },
  "lightConditions": "Day",
  "soundtrack": "village",
  "players": [
    {"playerId":"p_a3f9b1","x":...,"y":...,"tileX":...,"tileY":...,
     "direction":"down","hp":100,"hpMax":100,"step":"idle",
     "inventory":{"5":3,"7":1},
     "equipment":{"melee":1,"ranged":2}}
  ],
  "entities": [
    {"id":4242,"species_id":123,"x":10.5,"y":7.0,"frame":{...},"hp":20,"_open":false}
  ],
  "spawnPoint": {"x":3,"y":3}
}
```

- Tile grids are unchanged from the raw `data/*.json` shape so existing parsers work.
- `players` is the live, server-authoritative state. Client renders these directly — no local prediction in v0.
- `entities` carries the live entity state, including mob HP, gate `_open` flags, pushable positions, etc.

## Close codes

| Code | Meaning | Client action |
|---|---|---|
| `1000` | Normal closure | Show "Disconnected" toast, offer reconnect |
| `4001` | Obsolete protocol | Force a `location.reload()` |
| `4002` | Idle timeout (no pings) | Auto-reconnect once, then show "Disconnected" |
| `4003` | UUID conflict (same UUID already connected) | Show "Already playing in another tab" |
| `4004` | Rate-limit ban | Show "Disconnected — too many messages" |
| `4500` | Internal server error / restart | Show "Server error — reconnecting…" + auto-reconnect after 3 s |

## Rate limits

- Inputs: 30/sec per connection. Excess silently dropped.
- All other ops: 10/sec per connection.
- Severe violations (1000+ msgs in 10 s) result in a 4004 close. The same UUID can reconnect after 60 s.

## Reconnection

- Whenever the WebSocket closes, the client computes a back-off delay (1s, 2s, 4s, 8s, capped at 30s) and re-opens.
- On reopen, it sends the same UUID. Within the 30 s grace window the server restores the same session; after that the server treats it as a fresh login.
- The client should buffer no more than 2 seconds of unsent input — anything older is discarded on reconnect (the server's authoritative state would have evolved past it anyway).

## Sequence diagrams

### Solo player joins, walks one tile, leaves

```
C → hello {uuid, protocol:1, joinCode:null}
S → welcome {playerId, partyCode, zone}
C → input {intent:"moveDown"}
... server ticks at 10 Hz, broadcasting deltas with updated position ...
S → delta {tick:101, players:[{playerId, tileY:1}]}
S → delta {tick:102, players:[{playerId, tileY:2}]}
C → input {intent:"stopMove"}
C → (WS close)
... server marks player as ghost, 30 s grace ...
... 30 s later: server removes the ghost; party-of-one is GC'd (empty) ...
```

### Two players, one walks through a teleporter

```
A → hello {uuid:U1, joinCode:null}
S → welcome (party PA, code "ABC12", zone 1001)
B → hello {uuid:U2, joinCode:"ABC12"}
S → welcome (party PA — joined A, zone 1001 — same instance)
A → input {moveDown} ... → S sends deltas to both A and B
A → travel {viaEntityId: 99 (teleporter to zone 1002)}
S → A: event:zoneChange {zoneId:1002, snapshot:{...}}
S → B: delta {removed:{players:[U1]}}
... B is still in zone 1001 alone. When B teleports too, B lands in the same zone-1002 instance party PA already owns.
```

---

# Phase 1 file classification

Audit of every file in `js/` against direct browser-API use (`document`, `window`, `localStorage`, `fetch`, `Image`, `Audio`, `getContext`, `addEventListener`, `requestAnimationFrame`, `indexedDB`, `location`, `navigator`).

The destination layout is:

```
client/   browser-only code (Canvas, audio, input devices, HUD, modals, IndexedDB, localStorage)
server/   Node-only code (the hello-world is already there; the tick lands here)
shared/   pure simulation and data — imported by both client and server, no browser APIs
```

Hard rules:
- `shared/` MUST NOT import from `client/` or `server/`.
- `client/` may import from `shared/` freely. Same for `server/`.
- Persistence in `shared/` is an injected interface; concrete backends are localStorage (client), in-memory or SQLite (server).
- The protocol data shapes live in `shared/`; the transport (WS server / WS client) lives in `server/` and `client/` respectively.

Outcome target: `node -e "import('./shared/zone.js').then(m => m.buildZone(rawJson))"` works with zero browser shims.

## Bucket A — move to `shared/` as-is

| File | Notes |
|---|---|
| `afterDialogue.js` | post-dialogue side-effects on zone state |
| `biomeAnimation.js` | frame counter |
| `biomes.js`, `biomeTiles.js` | biome data + tile-selection rules |
| `camera.js` | camera math (interpolation, world-to-screen) |
| `combat.js` | damage resolution, hitboxes |
| `constants.js` | tile size, sprite-sheet IDs |
| `constructions.js`, `constructionTiles.js` | construction data + tile-selection |
| `cutscenes.js` | cutscene state machine |
| `entities.js` | entity tick driver |
| `entityVisibility.js` | visibility predicates |
| `explosives.js` | explosive state |
| `firstLaunch.js` | first-launch flag (no browser deps) |
| `gateUnlock.js` | gate unlock rules |
| `locks.js` | lock state |
| `minions.js`, `mobs.js`, `monsters.js` | mob AI + spawning |
| `movement.js` | tile-locked stepping math |
| `pickups.js` | pickup resolution |
| `player.js` | player tick |
| `prefabs.js` | raw-zone generator (creative mode) |
| `pushables.js` | pushable resolution |
| `puzzles.js` | puzzle state |
| `save.js` | uses `storage` interface, not localStorage directly — portable |
| `species.js`, `strings.js` | data tables |
| `trails.js` | trail decay |
| `zone.js`, `zoneVisibility.js` | zone state |

## Bucket B — move to `client/` as-is

| File | Why it's client-only |
|---|---|
| `ammoHud.js`, `healthHud.js`, `hud.js` | DOM HUD elements |
| `assets.js` | `new Image()` sprite loading |
| `audio.js`, `music.js` | Web Audio |
| `biomeSheet.js` | Canvas-baked sprite atlas |
| `dialogue.js`, `gameOver.js`, `message.js`, `toast.js`, `inventoryScreen.js`, `loadingScreen.js`, `fastTravel.js`, `menu.js` | DOM modals + event listeners |
| `data.js` | `fetch()` for level/species/strings JSON in browser |
| `gameLoop.js` | `requestAnimationFrame` |
| `gamepad.js`, `input.js`, `keyBindings.js`, `touch.js` | input devices |
| `main.js` | entry point — wires everything browser-side |
| `mapEditor.js` | creative-mode DOM editor |
| `renderer.js` | Canvas 2D drawing |
| `settings.js` | DOM settings UI |
| `zoom.js` | Canvas/DOM zoom |
| `zoneBuffer.js` | IndexedDB-backed zone-state buffer |
| `zoneCache.js` | Canvas-baked static-tile surfaces |

## Bucket C — split, one file lands in two places

| File | shared/ part | client/ part |
|---|---|---|
| `storage.js` | the `getValue`/`setValue` interface + a Map-backed default | localStorage backend that's installed on boot |
| `coopMode.js` | the flag accessor (reads injected storage) | the localStorage backing + Settings toggle |
| `creativeMode.js` | the flag accessor | URL-param read on boot |
| `migrations.js` | migration ladder + storage-only steps | the v2 legacy-inventory scan (raw `localStorage.length` walk) |
| `inventory.js` | per-player amounts + mutation | the legacy `sneakbit.inventory.v1` scan helper |
| `equipment.js` | slot state + getters | `window.equipment` devtools binding |
| `skills.js` | skill resolution + active set | `window.skills` devtools binding + override-key localStorage read |
| `playerHealth.js` | HP + invuln-window state | (re-audit — comment `invuln window` triggered a false positive; likely already pure) |
| `interact.js` | "interact with entity ahead" resolution | `window.addEventListener("keydown", ...)` and the touch-hint DOM element |
| `melee.js` | swing resolution + cooldown | `window.addEventListener("keydown", ...)` |
| `shooting.js` | bullet spawn + ammo decrement | `window.addEventListener("keydown", ...)` |
| `transitions.js` | zone-change + spawn-resolution logic | fade-overlay DOM element |

After the split, each file in the right column is small (input wiring or one DOM element); each file in the left column is the actual simulation surface.

---

# Implementation order

Phases are gated on the previous landing. Each phase ends with a runnable, deployable state — even if "runnable" means "press a button, see one player walk."

## Phase 0 — Foundations (landed)
- [x] Hello-world Node server + `deploy.py` + auto-deploy hook
- [x] Decisions locked: anonymous UUID, party-instanced, in-memory, full server-authoritative tick
- [x] Vocabulary fixed: world → zone everywhere in the codebase
- [x] This document

## Phase 1 — Headless simulation (landed)

Make the simulation modules run under `node` with no DOM.

- [x] Create the `client/`, `server/`, `shared/` skeleton (no code moves yet — just empty directories with a `.gitkeep`). `server/` already exists with the hello-world.
- [x] Move bucket A files into `shared/`. Update import paths in their consumers. Run tests after each batch.
- [x] Move bucket B files into `client/`. Same.
- [x] Tackle bucket C one file at a time. Each split is its own commit. After every split, `node --test` is green AND the page still loads in a browser.
- [x] Adjust `index.html` to point at `client/main.js`.
- [x] Verify `node -e "import('./shared/zone.js')"` loads cleanly with zero browser shims.

Outcome: the `js/` folder is gone. 33 simulation modules now live in `shared/` (+ 5 new ones from the bucket C splits: `coopMode`, `creativeMode`, `interact`, `shooting`, `transitions`), 28 browser modules + 6 boot/devtools/input wrapper modules live in `client/`. `node -e "import('./shared/zone.js')"` succeeds; 176/176 tests pass; the page still loads in the browser via `index.html → client/main.js`.

The hard rule "shared/ MUST NOT import client/" is **not yet fully held** — five shared modules (`combat`, `cutscenes`, `melee`, `pickups`, `shooting`, and a couple of others) still import `../client/audio.js`, `../client/dialogue.js`, `../client/settings.js`, `../client/toast.js`, or `../client/assets.js`. Those targets have no top-level browser-API use, so node loads them harmlessly today; Phase 4 inverts each via injected handlers as the server starts calling these systems.

### Phase 1 — implementation decisions

These are locked. If you find a reason to change one, update this section and explain why in the commit.

- **storage.js split.** `shared/storage.js` exposes `getValue` / `setValue` against an injected backend, with a **Map-backed in-memory default** so accidental use without a backend doesn't crash. Concrete backends:
  - `client/localStorageBackend.js` installs the localStorage-backed implementation on boot in the browser entry point.
  - `server/memoryBackend.js` (Phase 6 swaps to SQLite) installs the per-player keyed in-memory backend on the server.
  - Rationale: forgiving default beats a hard throw — the engine starts up even mid-refactor, behavior is just transient. Tests can install whatever backend they want.
- **`data/` location.** Stays at repo root. Both client and server reach for it but via their own loaders (`client/data.js` uses `fetch`, `server/data.js` uses `fs.readFile`). It is *not* moved under `shared/` — that would imply shared code reads the disk, which it can't portably.
- **`playerHealth.js` bucket.** Lands in **bucket A (`shared/`)**. The browser-API grep matched a comment ("invuln window") not actual `window.` usage. Confirmed in the audit.

### Phase 1 — what's already proven (don't re-litigate)

- `node -e "import('./js/zone.js')"` succeeds today — `buildZone`, `isWalkable`, `isEntityBlocked`, `isTileSlippery`, `hasEnterableTeleporter` all load with no DOM. Most bucket A files are likely already pure as written; surgery may be lighter than expected.
- 176 unit tests pass on `main` and on the `phase-1` branch (no test changes pending).
- Auto-deploy hook is installed (`core.hooksPath = .githooks`). It fires on commits touching `server/`, `deploy.py`, or `.githooks/` **regardless of branch**. Phase 1 file moves do not touch any of those, so the hook stays dormant. Phase 2 onward will deploy from whatever branch the commit lands on — decide a branch guard or merge policy before Phase 2 starts.

## Phase 2 — Smallest server-authoritative slice
One zone, one player, server-authoritative walking. No mobs, no combat, no pickups.

- Server: load zone 1001 (or the starting zone), spawn a player on connect, run a tick that consumes input intents and updates player position via the shared movement module.
- Server emits a snapshot per tick.
- Client: `?online=1` opens a WS, sends intents on key/touch input, renders from snapshots.
- Verify: opening two tabs in `?online=1` shows two avatars in the same zone, both controlled by their respective tabs.

### Phase 2 — implementation decisions

These are starting points for the next session, not yet locked. Update this list (and explain in the commit) if reality forces a change.

- **WebSocket transport.** Two viable paths:
  1. Hand-roll RFC 6455 on top of `node:http`'s `upgrade` event. Keeps the "no deps" rule that the rest of `server/` follows, but ~150 lines of handshake + framing + masking just to send JSON.
  2. Take the `ws` dep — single, small, no transitive deps. Easiest justification for breaking the no-deps rule we'll find.

  Recommend (2). It's strictly defensive: hand-rolled framing is the kind of code that's a Steam-game-tier bug source for zero gameplay benefit. If we take it, document the exception in CLAUDE.md so future sessions don't add more deps casually.
- **Server module layout.** Same "one feature, one file" rule as `client/` and `shared/`. Concrete files to create:
  - `server/ws.js` — upgrade handler, frame encode/decode (or thin wrapper around `ws`).
  - `server/connection.js` — per-socket state (uuid, partyId, zoneInstanceId, ghost flag).
  - `server/party.js` — party registry, join codes, party-of-one auto-assign.
  - `server/zoneInstance.js` — `(zoneId, partyId)` instance lifecycle (lazy create, 60s warm idle, drop).
  - `server/tick.js` — 10 Hz loop iterating non-idle instances.
  - `server/data.js` — `fs.readFile` mirror of `client/data.js`'s API (`loadZone`, `loadSpecies`, `loadStrings`).
  - `server/memoryBackend.js` — installs an in-memory backend into `shared/storage.js` on boot (Map-keyed by `(playerId, key)` so per-player state stays isolated when we add players).
  - `server/index.js` — entry point, wires the above. `/health` and `/` stay as today.
- **Reusing the shared sim modules on the server.** During Phase 1 I traced what happens when `shared/` modules with `../client/*` imports get loaded under node:
  - `audio.playSfx` is a no-op when `buffers` is empty (and `loadAudio()` is never called server-side, so it stays empty).
  - `toast.showToast` no-ops because `installToast()` returns null when `typeof document === "undefined"`.
  - `dialogue.showDialogue` is never called by the Phase 2 player tick path (it's only invoked from `interact.js`, which is client-only input).
  - `assets.getSprite` returns null when no asset is loaded; the call sites in `entities.js` / `cutscenes.js` / `trails.js` / `species.js` already handle null gracefully (they're render paths, not sim paths).

  Net: the Phase 2 server can `import { createPlayer, updatePlayer } from "../shared/player.js"` and call `updatePlayer()` directly. No urgent need to invert the shared→client imports — that's Phase 4 territory.
- **Storage backend on server.** Install `server/memoryBackend.js` at the top of `server/index.js` (same role `client/localStorageBackend.js` plays in `client/main.js`). v0 has no persistence — every restart wipes online state — so the backend is just a no-op `set` / `remove`. Phase 6 swaps the implementation to SQLite without touching `shared/storage.js`.
- **Player identity.** Server keys players by the UUIDv4 the client sends in `hello`. Map: `uuid → { connectionId, playerId, partyId, currentZoneInstanceId, lastPosition, ghostExpiresAt }`. The 30s ghost grace is a `setTimeout` that, on expiry, removes the player from their zone instance.
- **Snapshots in Phase 2.** Send a full `snapshot` on `welcome` and on every tick where the player's position changed. Skip the delta vs. snapshot split — premature optimisation at one player per zone. We add deltas when zone instances start carrying mobs.
- **Tick driver.** One `setInterval(tick, 100)` for the whole process. For each non-idle zone instance: drain its input queue, advance the player(s), broadcast. Idle instances (no connected members) are skipped — zero CPU per the design.
- **Branch policy.** Work happens on a `phase-2` branch. The `.githooks/post-commit` hook fires on any commit touching `server/`, `deploy.py`, or `.githooks/` *regardless of branch*, so DO NOT commit experimental server code directly to a tracked branch unless you're ready to deploy it. Options:
  1. Commit to `phase-2`; the hook still fires and deploys whatever's on `server/` at the time of the commit. Acceptable if the staging VPS has no live players.
  2. Add a branch guard to the hook before Phase 2 starts (recommended): only deploy when committing on `main`. One-line change in `.githooks/post-commit`.
  3. Keep `phase-2` work as uncommitted/stashed until ready, then commit straight to `main`. Risky — easy to lose work.

  Recommend (2). The hook change itself triggers the hook (it touches `.githooks/`), so the first commit on `main` after adding the guard will still deploy — that's fine.

## Phase 3 — Parties + zone transitions
- Implement party creation, join-by-code, leave. Party panel in HTML.
- Per-party zone instance lifecycle (lazy create, 60 s warm idle, drop).
- Server-side teleporter handling: `travel` op resolves the destination, moves the player into the destination zone instance (creating it if needed).
- Verify: two tabs join the same party, both end up in the same zone instance, walk through a teleporter together, end up in the same destination instance.

## Phase 4 — Re-enable systems server-side, one at a time
Each sub-step is its own commit. Test that the offline client is unaffected.

1. Mobs / monster fusion / minion spawning
2. Combat (melee + ranged), damage, death
3. Pickups + inventory mutation
4. Equipment slots
5. Pushables, gates, locks, puzzles
6. After-dialogue, cutscenes, trails
7. Dialogue progression (server tracks state, client renders the modal)
8. Game-over flow + respawn

### Phase 4 — pending shared→client inversions

These are the Phase 1 hard-rule violations that Phase 4 needs to clean up before each system goes server-authoritative. Each is a small, well-bounded refactor that follows the same template the Phase 1 bucket C splits established: the shared module exposes an `install<X>Handler` / `setXBackend` seam, the client wires the real implementation on import, and any server caller wires its own (or none, for no-ops).

| shared module | imports from client/ | Phase 4 step that needs it inverted |
|---|---|---|
| `shared/species.js` | `assets` (getSprite) | step 1 (mobs render-pass uses getSprite, but the sim path doesn't — sim path may not need inversion at all; double-check before touching) |
| `shared/entities.js` | `assets` (getSprite) | step 1 (same — render only) |
| `shared/trails.js` | `assets` (getSprite) | step 6 (trails: server spawns trail entities; client renders) |
| `shared/cutscenes.js` | `assets` (getSprite) | step 6 (cutscenes: server drives state; client renders) |
| `shared/player.js` | `audio.playSfx` ("stepTaken") | optional — playSfx already no-ops server-side |
| `shared/combat.js` | `audio` (hits/deaths), `settings` (friendly fire flag) | step 2 — needs both an sfx handler seam and a server-side settings injection (or hardcode friendly-fire=false on server) |
| `shared/melee.js` | `audio.playSfx` (swing) | step 2 |
| `shared/shooting.js` | `audio.playSfx` (shot / no-ammo) | step 2 |
| `shared/pickups.js` | `dialogue` (resolveEntityDialogue for hint pickups), `toast`, `audio` | step 3 — dialogue resolution moves server-side; toast becomes a `toast` event sent to the relevant client |
| `shared/gateUnlock.js` | `audio`, `toast` | step 5 |
| `shared/firstLaunch.js` | `settings`, `toast` | step 1 or unblock-as-needed — first-launch is a client-only UI concern, but the gate currently lives in shared. Consider moving the *whole file* to client/ rather than inverting.

Inversion template (copy-paste from `shared/melee.js`'s `setMeleeStateRef` + `shared/storage.js`'s `installStorageBackend`):

```js
// In shared/X.js — replace direct import of ../client/audio.js with:
let onSfx = null;
export function setSfxHandler(fn) { onSfx = typeof fn === "function" ? fn : null; }
// then `onSfx?.("stepTaken")` instead of `playSfx("stepTaken")`.
```

```js
// In client/Xboot.js (loaded by main.js's import-for-side-effect list):
import { setSfxHandler } from "../shared/X.js";
import { playSfx } from "./audio.js";
setSfxHandler(playSfx);
```

The server installs no handler (default no-op) or a logger.

## Phase 5 — Mode-aware client
- Implement `?online=1` mode toggle in the client cleanly: a single boundary that gates "do we run a local tick or read from snapshots."
- HTML UI for: party code display, join-by-code, leave party.
- Separate online-mode save namespace in localStorage (just UI/settings caches; the canonical state is server-side).
- Disable creative mode + map editor in online mode.

## Phase 6 — Persistence
- `better-sqlite3` on the server.
- Per-player state: position, zone, HP, inventory, equipment.
- Per-party state: members, current zones.
- Save on every snapshot diff or on a debounce — TBD when we get there.
- Survive server restarts.

## Phase 7 — Identity & accounts
- Optional email/password binding to the existing UUID.
- Forgot-password (email link). Friend list. Display names.

## Phase 8+ — MMO surface
Beyond this point we're in proper MMO territory: shops, quests, NPC dialogue trees with branching state, persistent overworld zones, multi-process sharding. Each is its own design discussion.

## Working state (next session pickup)

This section is a handoff note for the next time work is resumed. Update it as state changes.

- **Branch:** Phase 1 (17 commits, 7d006cc..49078da) landed on `phase-1` and fast-forwarded into `main`. Both refs pushed to origin. Phase 2 should branch fresh from `main`.
- **Folder layout (actual, post-merge):** `js/` is gone.
  ```
  shared/   43 .js files — every pure sim module + the bucket C split halves
            (storage, coopMode, creativeMode, migrations, inventory, equipment,
             skills, melee, shooting, interact, transitions)
  client/   38 .js files — every browser-only module + 6 boot files imported
            for side effect by main.js (localStorageBackend, coopModeBackend,
            creativeModeBoot, legacyInventoryScan, equipmentDevtools,
            skillsDevtools), 3 input wrappers (meleeInput, shootingInput,
            interactInput), and the orchestration half of transitions.
  server/   index.js (hello-world + /health) and package.json — unchanged
            since Phase 0.
  data/     unchanged, stays at repo root.
  tests/    176 tests, all green, all import from ../shared/ or ../client/
            now (no leftover ../js/ references anywhere in the codebase).
  ```
- **Next concrete step:** Phase 2 step 1 — give `server/index.js` a real WS endpoint at `/ws`, load zone 1001 on boot, accept `hello`, and broadcast a `welcome` with the zone snapshot. See "Phase 2 — implementation decisions" above for the per-file split and the WS-library question (recommend taking `ws`).
- **What's known good right now:** `node --test tests/*.test.js` is 176/176 on `main`. `node -e "import('./shared/zone.js')"` returns five exports (`buildZone`, `hasEnterableTeleporter`, `isEntityBlocked`, `isTileSlippery`, `isWalkable`). Production at <https://sneakbit.curzel.it/health> still returns 200. The deploy.py + post-commit hook are wired and silent for Phase 1 (no `server/` touches).
- **Bug to fix early in Phase 2:** CLAUDE.md tells you to run tests with `node --test tests/` — that actually errors (`Cannot find module 'tests'`). The correct form is `node --test tests/*.test.js`. One-line CLAUDE.md fix; do it as part of the first Phase 2 commit so future sessions don't trip.
- **What's NOT done yet for the hard rule:** 11 `shared/` files still import 5 `../client/*` modules (`audio`, `assets`, `dialogue`, `settings`, `toast`). Inverting each is Phase 4 work; the table under "Phase 4 — pending shared→client inversions" lists every shared file, its imports, and which Phase 4 step needs it. The good news: every one of those client modules degrades to a no-op when called server-side (audio buffers empty, document undefined, etc. — checked during Phase 1). The Phase 2 server can call shared `updatePlayer` directly without inverting anything.
- **Watch out for:** the `.githooks/post-commit` hook deploys on any commit touching `server/`, `deploy.py`, or `.githooks/` *regardless of branch*. Phase 2 inherently touches `server/`, so EITHER add a branch-guard to the hook before starting (see Phase 2 decisions point 7), OR accept that every `phase-2`-branch commit on server/* hits the live VPS at <https://sneakbit.curzel.it>. The VPS is shared with `restartborgo.it` (paying customer's static site) — `deploy.py` re-validates restartborgo on every run, so a botched deploy won't take down the paying tenant, but a botched deploy WILL break sneakbit.curzel.it until fixed.
- **Memory note:** I've stored two facts about this port in `~/.claude/projects/.../memory/` — the movement-model decision (tile-locked, not free-axis) and the asset-pipeline source (`~/dev/sneakbit/`). Both still apply.

---

# Open questions / deferred

- **PvP:** out of scope. Same as today.
- **Chat:** out of scope for v0. Even a per-zone shout adds moderation surface — postpone.
- **Real accounts (email/password, OAuth):** Phase 7. The UUID lets us bind retroactively.
- **Friends list, party invites by name:** Phase 7+.
- **Persistent worlds (shared-instance overworld):** explicitly *not* the model. Everything is party-instanced. We may add public zones later (e.g. a "town hub" that's not party-scoped), but the default is party.
- **Server snapshot persistence across deploys:** Phase 6.
- **Time-of-day, weather, daily resets:** not in the current sim. If/when added, server-side.
- **Sharding across processes:** one Node process is enough until profiled. Phase 8+.
- **Mobile / touch quirks of online mode:** same input layer feeds the intent translator, so touch should work for free. Verify in Phase 2.
- **Compression / binary frames:** maybe per-message deflate or binary later; not needed at 10 Hz with small payloads.
- **Partial-zone deltas:** splitting `delta` by region for very large zones. Not relevant at current zone sizes.
- **Matchmaking / find-friend over the wire:** not in v0 — parties are formed by code-sharing out of band.
