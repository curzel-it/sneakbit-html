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

## Phase 2 — Smallest server-authoritative slice (landed)
One zone, all-comers party-less, server-authoritative walking. No mobs, no combat, no pickups.

- [x] Server: load zone 1001 on boot, spawn a player at STARTING_SPAWN on connect, run a 10 Hz tick that consumes input intents and updates each connected player via `shared/player.updatePlayer`.
- [x] Server emits a full `delta` op every tick listing every connected player's position. The welcome carries a full `snapshot` with tile grids + entities + spawn point.
- [x] Client: `?online=1` opens a WS, sends `moveX` / `stopMove` intents on input edges, renders every player from server deltas with no local sim tick.
- [x] Verify: two distinct UUIDs share the single instance — B's welcome lists both players and subsequent deltas broadcast both positions to both clients. Headless-Chrome screenshots confirm camera scrolls on input.

Outcome: `server/` grew six modules (`app`, `connection`, `data`, `memoryBackend`, `tick`, `ws`, `zoneInstance`) + the `ws` npm dep + an `npm ci` step in `deploy.py`. `client/` grew two (`online`, `onlineConnection`) and `main.js` got a 6-line dispatch on `?online=1`. 190/190 unit tests pass (added 14: 5 handshake, 4 tick, 5 client helpers).

### Phase 2 — open issues to address before going public

These didn't block landing but are real gaps. Address in the next phase that touches the same surface.

- **No UUID-conflict close (4003).** Spec calls for it; two tabs sharing the same localStorage UUID currently both register as the same playerId, get duplicate entries in `players[]`, and silently collapse in the client's `Map<playerId, player>`. Phase 3 (reconnect/ghost grace) is the natural place — both need the "is this UUID already alive?" check.
- **No per-connection server logs.** Boot logs only. Adding `console.log` on hello/close would make Phase 3 iteration far easier; near-zero cost.
- **Player-player tile collision is absent.** Two players can stand on the same tile. Probably acceptable (Rust co-op tolerates it); document and move on.
- **No rate-limiting yet** (spec says 30 intents/sec). Not exploitable in v0 with no anti-cheat surface, but the budget is in the spec — wire when adding input ops in Phase 4.
- **No `travel`, no `party.*`, no `event:zoneChange`** — those are Phase 3's job.
- **The protocol's `step: "midwalk"|"idle"` is not what we send.** We send the full step object (`{fromX,fromY,toX,toY,progress}`) so the client can interpolate. Phase 4 should reconcile the spec text with the implementation choice (either change the spec to document the object, or change the wire shape and put interpolation behind a phase string).

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

## Phase 3 — Parties + zone transitions (landed)
- [x] Party registry (`server/party.js`): in-memory `Map<partyId, {code, members, instances}>`, 5-char alphanumeric join codes (alphabet excludes `I/O/0/1`), empty-party GC, soft cap at 4 members.
- [x] `(zoneId, partyId)` instance registry replacing the Phase 2 singleton. Lazy create on entry, 60 s warm-idle timer before drop, cancel on re-entry. Concurrent creates from the same party are serialised via a pending-promise map so two travelers never end up in different copies of the same destination zone.
- [x] `server/tick.js` iterates all live instances; idle ones (no connected members) cost zero CPU per the design.
- [x] `travel` op: server validates the teleporter is under the player's foot and (optionally) matches `viaEntityId`, picks/creates the destination instance for the player's party, broadcasts `event:zoneChange` (full snapshot) to the mover.
- [x] `party.create` / `party.join` / `party.leave` ops. `party.join` may reply with `event:partyJoinFailed` (reasons: `not_found`, `full`, `same_party`). `event:partyUpdate` broadcasts to remaining members on every change.
- [x] 4003 UUID-conflict close on a second hello with a UUID already alive (Phase 2 open issue).
- [x] HTML Party panel (`client/partyPanel.js`): top-right toggle + slide-in overlay showing the join code, member list (with self marker), join-by-code input, leave button. DOM-based; not on canvas.
- [x] Client `online.js` detects tile crossings onto teleporters and sends `travel`; handles `event:zoneChange` by rebuilding zone + players from the new snapshot and re-snapping the camera. Handles `event:partyUpdate`, `event:partyJoinFailed`, and the `event:uuidConflict` notification.
- [x] Per-connection server logs on hello / travel / party switch / close — makes future iteration cheaper.
- [x] Verify: two tabs join the same party via the HTML panel, both see the same code + member list. Travel through a teleporter together is covered by an end-to-end WS test (`tests/serverParty.test.js` — both members get `event:zoneChange` with the same `zoneId` and end up in the destination instance with `connections.size === 2`). Headless-Chrome screenshots confirm the party-panel UI; the in-browser teleporter walk wasn't reproduced because the starting tile is ~92 tile steps from the nearest teleporter through a maze, and the wire protocol coverage already proves correctness.

Outcome: 207/207 unit tests (17 new — party 4, registry 6, server-party 7). `server/` grew one module (`party.js`) and refactored four (`app.js`, `connection.js`, `tick.js`, `zoneInstance.js`). `client/` grew one (`partyPanel.js`) and refactored `online.js`. No new npm deps.

### Phase 3 — open issues to address before going public

These didn't block landing but are real gaps. Address in the next phase that touches the same surface.

- **Player-player tile collision is still absent.** Carried over from Phase 2. Two players in the same instance can stand on the same tile.
- **No rate-limiting yet** (spec says 30 intents/sec, 10/sec for everything else). Phase 4 should add it alongside the new input ops.
- **No reconnect / 30 s ghost grace yet.** A WS close immediately removes the player from the party (`onDisconnect` calls `ctx.parties.remove`). The spec wants a 30 s window where reconnecting with the same UUID restores the session. Easy to add: keep the conn in the byUuid map for 30 s after close, route a re-hello to the existing party + instance.
- **Snapshot vs. delta on `event:zoneChange`** uses the full snapshot every time. Cheap at one zone per traveler; revisit when zones get bigger.
- **`step` is still the full object** (`{fromX,fromY,toX,toY,progress}`), not the protocol's `"midwalk"|"idle"` string. Phase 4 should reconcile.
- **`event:uuidConflict` is sent before the 4003 close**. The spec doesn't define it; it's a courtesy frame so the client can show a toast. If it stays, document in the wire protocol section.

### Phase 3 — implementation decisions

These are locked. If you find a reason to change one, update this section and explain why in the commit.

- **Party = always-present.** There is no "no party" state. A solo player is a party of one; `party.leave` creates a fresh party-of-one rather than dropping the player into a partyless limbo. Rationale: matches the spec's "every online player belongs to exactly one party" and removes a class of null-checks from every routing path.
- **Code minter alphabet excludes ambiguous chars** (`I`, `O`, `0`, `1`). 32-char alphabet × 5 chars = 33M codes; collisions retry up to 50 times. The party panel's input is `text-transform: uppercase` and the server `.toUpperCase()`'s incoming codes, so casing is irrelevant.
- **`party.leave` and `party.create` both create a fresh party-of-one.** They're synonyms server-side. The wire protocol distinguishes them so future versions can differ (e.g., `party.create` accepting a name once we have one).
- **Zone choice on party switch.** When a player leaves/creates a party, they stay in the same zone — the new party gets its own instance of that zone. Spawn point is `STARTING_SPAWN`, since we don't yet track per-player position. Phase 6's persistence will replace this.
- **4003 is sent to the *new* connection.** A refresh in tab A shouldn't kick tab A out of the game while the new tab takes over. The existing session keeps playing.
- **`uuidConflict` courtesy frame.** Sent immediately before the 4003 close. The client uses it to show a toast; without it, the user only sees a generic disconnect.
- **Concurrent `getOrCreate` is serialised** via a pending-promise map. Without this, two travelers from the same party building the destination instance simultaneously each got their own copy and the party silently split.

## Phase 4 — Re-enable systems server-side, one at a time
Each sub-step is its own commit. Test that the offline client is unaffected (`node --test tests/*.test.js` + manual `?online=0` smoke).

1. [x] Mobs / monster fusion / minion spawning (landed 2026-05-26)
2. Combat (melee + ranged), damage, death
3. Pickups + inventory mutation
4. Equipment slots
5. Pushables, gates, locks, puzzles
6. After-dialogue, cutscenes, trails
7. Dialogue progression (server tracks state, client renders the modal)
8. Game-over flow + respawn

### Phase 4 step 1 — what landed (2026-05-26)

- Inverted the two `shared/` → `client/assets` imports via a single `setSpriteLookup(fn)` seam on `shared/species.js`. `shared/entities.js` now uses `getSpriteByName(name)` (also exported from species). `client/spritesBoot.js` is loaded as a side-effect import by both `client/main.js` and `client/online.js` and installs `getSprite`. Server installs nothing — the sprite-lookup default returns null, and every render path was already null-safe (one small addition: `drawPlayer` now early-returns when the heroes sheet is missing).
- `server/tick.js` `tickOnce()` now runs `tickMobs` → `tickMonsterFusion` → `tickMinionSpawning` → `tickEntities` after the player update loop. Aggro target = first connected player (`firstPlayer(instance)`); fine for v0 parties of 1–4.
- The `delta` op now carries `entities` (only entries whose serialized form changed since the last broadcast) and `removed.entities` (ids that disappeared from `zone.entities`). Diffing is per-instance via `instance._lastEntitiesByJson` — JSON-equal entities don't transmit. `serializeEntityForDelta` whitelists the wire fields (id, species_id, frame, direction, public flags, _hp); internal AI / sort caches stay server-side.
- `server/zoneInstance.js` `snapshotZone()` now sources entities from `instance.zone.entities` (live state), not `rawZone.entities`. Late joiners see current mob positions, current gate states, spawned minions, etc. `serializeEntityForSnapshot` strips internal `_ai` / `_visible` / `_sortKey` etc. but keeps the full on-disk static fields (destination, dialogues, lock_type, …) so the client's `buildZone` rehydrates a complete entity list.
- `client/online.js`'s `delta` handler now merges `delta.entities` into `session.zone.entities` (mutate by id) and filters out `delta.removed.entities`. Player merge unchanged.
- New tests in `tests/serverMobs.test.js` (4): a mob moves across server ticks, the delta payload thins out after the first tick, `computeEntityDelta` detects removals, `serializeEntityForDelta` strips internal fields. Total: 211/211.
- Headless-Chrome verify confirmed mobs render and move under server simulation alone (player input == none, two screenshots 4s apart show two blackberry monsters in different positions).

### Phase 4 step 1 — known gaps / follow-ups

- **`/opt/client/` push in `deploy.py` stays for now.** Even after the species/entities inversions, `shared/player.js` still imports `../client/audio.js`, and the server transitively imports `shared/player.js` from `server/connection.js` + `server/tick.js`. So node still resolves the client dir at module load. Drop the push only when *every* remaining shared→client import is gone (the table further down lists them — five more land across steps 2/5/6).
- **Mob visibility-gating is bypassed server-side.** `tickMobs` / `tickMonsterFusion` / `tickMinionSpawning` all use `zone.visibleEntities ?? zone.entities` for their iteration list. The server doesn't compute `visibleEntities` (no camera), so every entity ticks every tick. For v0 zones (<~100 entities) this is fine; if a zone scales up, decide on a per-party-aggregate visibility filter.
- **Mob movement is choppy at 10 Hz.** The mob's `frame.x` / `frame.y` snaps once per server tick (100 ms) rather than being interpolated client-side. The player already has step interpolation (`step.fromX/toX/progress`); mobs would benefit from the same shape on the wire. Defer until it looks bad in practice.
- **Reconnect / 30 s ghost grace still not implemented.** Open from Phase 2/3. Step 2 (combat → death → respawn) is the natural place to land it.
- **Player-player tile collision still absent.** Carried over.

### Phase 4 — pickup for step 2

**Start with step 2: combat (melee + ranged), damage, death.** Files most likely to change:
- `shared/combat.js`, `shared/melee.js`, `shared/shooting.js` — invert the `client/audio` + `client/settings` imports via `setSfxHandler` / `setFriendlyFireSetting` seams.
- `server/tick.js` `tickOnce()` — call `tickCombat(zone, players, DT)` and `tickShooting`/`tickMelee` after the mob ticks. Aggro target picker becomes "all connected players" for combat (every player can take/deal damage).
- New input ops: keep `shoot` / `melee` as the same intents already in the catalogue (`server/connection.js` `applyInputIntent` translates them today — they were wired up Phase 2-style but never reach the sim path).
- Add an `event:death` / `event:respawn` round-trip. Server marks the player ghosted on death; client shows the GameOver modal and sends a "respawn" intent (TBD).
- New tests: `tests/serverCombat.test.js`.

Bundle the **reconnect / 30 s ghost grace** into the same phase — death and disconnect both call into the same removal path; one shape change for both.

### Pickup for step 1 (historical, kept for reference)

Step 1 has three pieces in sequence:

1. **Invert the two `shared/` → `client/assets` imports first** (`shared/species.js`, `shared/entities.js`). Both only use `assets.getSprite` on render-only paths; the sim path doesn't read it. The cleanest fix is the inversion template lower in this doc — add a `setSpriteLookup(fn)` seam, default to `() => null`, and let `client/main.js` (and `client/online.js`) wire `getSprite` on boot. Server installs nothing. Once landed, you can delete `/opt/client/` from the deploy (drop `step_push_shared_and_data`'s client push + `REMOTE_CLIENT_DIR`).
2. **Wire the three ticks into the server's per-instance loop.** In `server/tick.js` `tickOnce()`, after the `updatePlayer` loop, call:
   ```js
   tickMobs(instance.zone, primaryPlayer, DT);
   tickMonsterFusion(instance.zone);
   tickMinionSpawning(instance.zone, primaryPlayer, DT);
   tickEntities(DT);  // already imported indirectly; entities tick is dt-only
   ```
   `tickMobs` and `tickMinionSpawning` take a *single* player (Rust's "the player mobs aggro towards"). For multi-member parties pick `[...instance.connections.values()][0].player` as v0; a real "aggro target picker" is a Phase 4.x detail.
3. **Broadcast entity deltas alongside player deltas.** Today's `delta` op only carries `players`. Extend `tick.js`'s broadcast to also include `entities: [...]` for entities whose state changed (position, HP, `_open`, etc.). Naive shape: serialize every entity that has a mutable field, send the lot once per second + every tick where something interesting happened. Phase 4 step 1 *should* introduce delta-diffing because mob counts make full snapshots heavy. The client already calls `tickEntities(dt)` for sprite-frame animation; it should *not* run mob AI on its own — `online.js` doesn't import `tickMobs` and shouldn't.

Files most likely to change for step 1:
- `shared/species.js` + new `client/spritesBoot.js` (inversion of `assets`)
- `shared/entities.js` (same inversion)
- `server/tick.js` (add the three ticks + entity delta serializer)
- `server/zoneInstance.js` (`snapshotZone` already emits raw entities; add an `entityDelta(prev, curr)` helper, or maintain `instance._lastEntityState` for diffing)
- `client/online.js` (`client.on("delta", ...)` must merge `delta.entities` into the local zone's entity array, keyed by `e.id`)
- New tests: `tests/serverMobs.test.js` (mob walks, monster fuses, minion spawns through the WS) — use the same `createApp({autoTick:false}) + tickOnce()` pattern as `tests/serverTick.test.js`.

### Other Phase 4 cleanup to bundle in (or first, your call)

These don't strictly block step 1 but the next session is the natural time:

- **Reconnect / 30 s ghost grace.** Phase 2/3 open issue. Without it, every WS hiccup wipes the player out of their party. Implementation: in `server/app.js` `onDisconnect`, instead of immediately `removeConnection` + `parties.remove`, set `conn.ghostExpiresAt = Date.now() + 30_000` and keep them in `byUuid`. On a fresh hello with the same UUID, route to the existing conn's party/instance and clear the ghost. After 30 s, finalize the removal. The instance keeps ticking with the ghost present but skips its player update (so they freeze in place — spec-compliant).
- **Player-player tile collision.** Trivial fix: in `shared/player.js`'s movement-commit branch, reject the move if any other connection in the same instance has the same target `tileX,tileY`. Carrying over from Phase 2/3.
- **Rate limiting.** Spec: 30 intents/sec, 10/sec for everything else, 4004 close on flagrant abuse. Token bucket per connection. Wire when the input ops surface area grows (which step 2 will do).
- **`step: "midwalk"|"idle"` reconciliation.** Either change the wire to send the full object (and update spec § "Zone snapshot shape"), or change the implementation to send the short string + client interpolates from `tileX/tileY` deltas. Pick one in the same commit that adds entity deltas.

### Operational notes for Phase 4 (read before deploying)

- **Branch off `main`.** Phase 3 merged + deployed on 2026-05-26. `main` is the new starting point.
- **The post-commit hook fires on `git commit`, not `git merge`.** Merging a feature branch into `main` will NOT auto-deploy. Two options:
  1. Land Phase 4 steps as direct commits on `main` (each step deploys on commit — fine since deploys are idempotent and `?online=0` is unaffected).
  2. Work on a `phase-4` branch, merge with `--no-ff` to `main`, then make any tiny commit on `main` (touch `authoritative-server.md`'s handoff line) to trigger the hook. Or just run `python3 deploy.py` manually.
- **Deploy already pushes the full tree.** `deploy.py` was updated this session to push `server/`, `shared/`, `client/`, `data/` to `/opt/{sneakbit-server,shared,client,data}/`. Phase 4 should not need deploy changes — if you find one, document it like this session did.
- **The `/opt/client/` push exists only because of the unresolved shared→client imports.** When step 1's inversion lands and `shared/species.js` + `shared/entities.js` no longer import from `client/`, you can drop `REMOTE_CLIENT_DIR` from `deploy.py`. The other inversions are scheduled across steps 2/5/6 — drop the push only when every remaining shared→client import is gone.
- **Production is at <https://sneakbit.curzel.it>** (WS at `wss://sneakbit.curzel.it/ws`). `restartborgo.it` is on the same VPS and must stay 200. `deploy.py`'s health check covers both.

### Phase 4 — pending shared→client inversions

These are the Phase 1 hard-rule violations that Phase 4 needs to clean up before each system goes server-authoritative. Each is a small, well-bounded refactor that follows the same template the Phase 1 bucket C splits established: the shared module exposes an `install<X>Handler` / `setXBackend` seam, the client wires the real implementation on import, and any server caller wires its own (or none, for no-ops).

| shared module | imports from client/ | Phase 4 step that needs it inverted |
|---|---|---|
| ~~`shared/species.js`~~ | ~~`assets` (getSprite)~~ | ~~step 1~~ — landed; `setSpriteLookup` seam + `getSpriteByName` helper |
| ~~`shared/entities.js`~~ | ~~`assets` (getSprite)~~ | ~~step 1~~ — landed; uses `getSpriteByName` from species |
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

## Phase 5 — Mode-aware client (landed)
- [x] Implement `?online=1` mode toggle in the client cleanly: a single boundary that gates "do we run a local tick or read from snapshots."
- [x] HTML UI for: party code display, join-by-code, leave party.
- [x] Separate online-mode save namespace in localStorage (just UI/settings caches; the canonical state is server-side).
- [x] Disable creative mode + map editor in online mode.

### Phase 5 — what landed

- **Single boundary, single source of truth.** New `client/onlineMode.js` exposes `isOnlineMode()` (cached URL read) plus a test seam `_setOnlineModeForTesting`. `client/main.js` consults it for the boot dispatch; every mode-aware side-effect import (storage backend, creative-mode boot, co-op backend, legacy-inventory scan) reads the same predicate so we don't have two parallel boot lists to keep in sync.
- **Online localStorage namespace.** `client/localStorageBackend.js` picks `sneakbit.online.kv.v1.*` instead of `sneakbit.kv.v1.*` when `isOnlineMode()`. Settings (`sneakbit.settings.v1`) and key bindings (`sneakbit.keyBindings.v1`) remain shared — they're universal UI prefs, not save state. Online mode actually writes nothing to the kv prefix today (server is authoritative for everything that would have lived there), but the namespace is in place for when Phase 6 adds client-side caches.
- **Creative + editor hard-disabled online.** `client/creativeModeBoot.js` no-ops when online so `?online=1&creative=1` can't unlock creative tools. `client/coopModeBackend.js` and `client/legacyInventoryScan.js` similarly no-op online. `online.js` already called `setCreativeMode(false)` and never installed the map editor, so this layer just makes the lockout robust against URL params and future code paths.
- **Online pause menu.** New `client/onlineMenu.js` (DOM, not canvas) is installed by `online.js` and toggled on Esc. Slim by design — Resume, Settings (audio + FPS + key bindings), Party… (opens the existing party panel), Leave party (confirm + `party.leave`), Credits. Reuses the same widget patterns as `client/menu.js` but doesn't drag in inventory / skills / save export / new-game / creative — all offline-only concepts. The standalone "Party ▸" floating button still works as a shortcut; spec calls for the panel to be reachable from the pause menu, and now it is.
- **Input gating while menu is open.** `online.js`'s game loop checks `isOnlineMenuOpen()` and sends `stopMove` on the open-edge so navigating the menu doesn't drag the avatar across the floor. Re-fires the held direction on close.
- **Tests:** new `tests/onlineMode.test.js` (3) covers the test seam + cache. Total 214/214.
- **Verify:** headless-Chrome screenshots confirm offline + online both load, the pause menu opens on Esc, the party panel opens via the menu, the Settings sub-screen renders with audio/FPS controls. localStorage shows only `sneakbit.online.uuid` written from the online session — kv-prefix isolation holds.

### Phase 5 — known gaps / follow-ups

- **Settings split across two menus.** Offline `client/menu.js` and online `client/onlineMenu.js` each implement their own Settings card. The widgets are near-identical; if Settings grows new options (e.g. Phase 4 step 2 may add a "show damage numbers" toggle), factor the card body into a shared module. Today's duplication is small enough to live with.
- **Online has no inventory / skills modal yet.** Server-authoritative inventory + equipment + skills lands in Phase 4 steps 3 & 4. When it does, the online pause menu needs entries pointing at server-driven views. Don't reuse the offline `inventoryScreen.js` directly — it reads `shared/inventory.js` which is keyed off the offline player state.
- **Reconnect / 30 s ghost grace still not implemented.** Carried over from Phase 2/3. Phase 4 step 2 is the natural place; the menu's "Leave party" path already collapses to a single `party.leave` op so it'll keep working post-grace.
- **Settings audio sliders show 60%/45% defaults in online mode** because they were never written through the now-shared `sneakbit.settings.v1` key. That's correct behavior — the first slider drag in either mode persists for both. Document if/when settings start to need per-mode overrides.

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

- **Branch:** `main` is the starting point. Phase 2 + Phase 3 + Phase 4 step 1 + Phase 5 merged + deployed on 2026-05-26. Production is live at <https://sneakbit.curzel.it> (WS at `wss://sneakbit.curzel.it/ws`). Phase 4 step 2 should branch fresh from `main`. **Heads up:** the post-commit hook fires on `commit`, not on `merge`, so merging a future feature branch into `main` will NOT auto-deploy — see "Operational notes for Phase 4" above for the workaround.
- **Folder layout (actual, post-Phase-3):**
  ```
  shared/   43 .js files. Phase 4 step 1 inverted species.js + entities.js so
            neither imports client/assets any more. New seams: setSpriteLookup
            on species.js (default null), getSpriteByName re-exported for
            entities.js's player/inventory sheet lookups.
  client/   44 .js files — Phase 1 set + online.js + onlineConnection.js +
            partyPanel.js + spritesBoot.js (the side-effect import that wires
            getSprite into the species seam, loaded by both main.js and online.js)
            + Phase 5: onlineMode.js (the cached `?online=1` predicate the
            backends + creative/co-op boot consult) and onlineMenu.js (the Esc-
            toggled HTML pause menu installed only by online.js).
  server/   13 files (tick.js gained mob/fusion/minion ticks + entity-delta diff):
              app.js              createApp({loadRawZone, startingZoneId, autoTick}) — http + ws + router
              connection.js       per-socket state, intent-to-input translator
              data.js             fs.readFile mirror of client/data.js
              index.js            entry — loads data, calls createApp, listens
              memoryBackend.js    no-op storage backend (Phase 6 → SQLite)
              party.js            party registry + 5-char join code minter
              tick.js             10 Hz loop, iterates all live instances
              ws.js               WebSocketServer noServer wrapper, /ws only
              zoneInstance.js     (zoneId, partyId) registry with 60s warm-idle drop
              package.json        + dependencies: { ws: ^8.21.0 }
              package-lock.json   committed
              node_modules/       gitignored
  data/     unchanged — 125 zone JSONs + species.json + strings.en.json.
  tests/    214 tests, all green. Phase 4 step 1 added 4 (serverMobs);
            Phase 5 added 3 (onlineMode).
  deploy.py pushes server/, shared/, client/, data/ to /opt/{sneakbit-server,shared,client,data}/.
            Client dir push stays — shared/player.js still imports client/audio.js
            (one of the remaining nine shared→client violations).
  ```
- **Next concrete step:** Phase 4 step 2 — **combat (melee + ranged) → damage → death → respawn, bundled with the long-deferred reconnect / 30 s ghost grace** (death and disconnect both call the same removal path; one shape change covers both). **Read "Phase 4 — pickup for step 2" above** for the exact starting checklist: invert audio/settings imports on `shared/combat.js`, `shared/melee.js`, `shared/shooting.js` using the `setSfxHandler` template (lines 731-747); wire `tickCombat` / `tickShooting` / `tickMelee` into `server/tick.js` `tickOnce()` after the mob ticks; add `event:death` (server marks player ghosted) + `event:respawn` (client GameOver modal → respawn intent); add the 30 s ghost grace in `server/app.js` `onDisconnect` (set `conn.ghostExpiresAt = Date.now() + 30_000`, keep in `byUuid`, re-route a fresh hello with the same UUID back into the existing party/instance). New tests go in `tests/serverCombat.test.js`. The aggro target picker for combat is "all connected players" (everyone can take/deal damage), not the step-1 `firstPlayer(instance)` single-target.
- **Known-good local state right now:**
  - `node --test tests/*.test.js` is 214/214 on `main`.
  - `node server/index.js` boots in ~150ms, logs `sneakbit server ready (starting zone 1001)` + listening on `127.0.0.1:8090`. `GET /health` → 200 ok.
  - With `python3 -m http.server 8000` from the repo root, opening `http://127.0.0.1:8000/?online=1` shows the world + hero + working WS round-trip + party panel toggle in the top-right + Esc-toggled SneakBit-Online pause menu. Two browsers with different localStorage UUIDs can form a party via the panel; the join code propagates and the member list updates on both sides (headless-Chrome verify reproduces).
  - End-to-end teleporter travel is covered by `tests/serverParty.test.js` — two members place themselves on a teleporter tile, both send `travel`, both land in the same destination instance (`connections.size === 2`).
- **Production state (verified 2026-05-26):** `https://sneakbit.curzel.it/health` → 200, `wss://sneakbit.curzel.it/ws` delivers a Phase-3 `welcome` with a 5-char `partyCode`, `https://restartborgo.it/` → 200. systemd unit `sneakbit-server` is active. The VPS holds the full tree at `/opt/{sneakbit-server,shared,client,data}/`.
- **Open Phase 2 + Phase 3 gaps to remember:** see the per-phase "open issues" sections above. The biggest one for Phase 4 is the missing reconnect / 30 s ghost grace — Phase 4 will need it anyway when per-player state starts getting tracked.
- **What's NOT done yet for the hard rule:** Phase 4 step 1 cleared 2 of the 11 shared→client imports (`species.js`, `entities.js`). 9 remain across `trails.js`, `pickups.js`, `combat.js`, `melee.js`, `gateUnlock.js`, `firstLaunch.js`, `shooting.js`, `cutscenes.js`, `player.js` — scheduled across steps 2, 3, 5, 6. The `/opt/client/` push in `deploy.py` stays as long as any of these remain.
- **Memory note:** persistent notes in `~/.claude/projects/.../memory/` — movement-model decision, asset-pipeline source, server-roadmap pointer, and the remote-verify workflow (headless Chrome via CDP for change-screenshots). All still apply.

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
