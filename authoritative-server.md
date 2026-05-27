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
2. [x] Combat (melee + ranged), damage, death + 30 s ghost grace (landed 2026-05-26)
3. [x] Pickups + inventory mutation (landed 2026-05-26)
4. [x] Equipment slots (landed 2026-05-26)
5. [x] Pushables, gates, locks, puzzles (landed 2026-05-27)
6. [x] After-dialogue, cutscenes, trails (landed 2026-05-27)
7. [x] Dialogue progression (server tracks state, client renders the modal) (landed 2026-05-27)
8. [x] Game-over flow + respawn polish (landed 2026-05-27)

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

### Phase 4 step 2 — what landed (2026-05-26)

Four small commits landed across A → D, each green at 214 → 220 tests:

- **(A) Inversions on `shared/combat.js`, `shared/melee.js`, `shared/shooting.js`.** Each gained a `setSfxHandler(fn)` seam (default no-op). `combat.js` also gained `setFriendlyFireGetter(fn)` (default `() => false` — friendly-fire OFF on the server). New `client/combatBoot.js` wires `playSfx` + the friendly-fire setting on the client; loaded by both `client/main.js` and `client/online.js`. No `client/` imports remain in those three shared modules.
- **(B) HP backend injection + per-player WeakMap cooldowns.** `setCombatHealthBackend({applyContinuous, applyBurst, isDead})` seam on `combat.js` — default backend wraps `shared/playerHealth.js`'s per-index calls so offline HUD reads remain byte-identical. `shared/melee.js` and `shared/shooting.js` swapped their `Float32Array(MAX_PLAYERS)` cooldown arrays for `WeakMap<player, …>`. `tickMelee(dt, players)` and `tickShooting(dt, opts)` now accept the player list / per-instance zone, defaulting to `stateRef` so offline call sites just pass extra args.
- **(C) Server-side combat tick + death/respawn round-trip.** New `server/combatHealthBackend.js` installs a per-player backend that mutates `conn.player.hp/hpMax/_invuln/_regenDelay` directly — no global per-index records server-side. `server/connection.js` initializes HP at `createConnection` and routes `shoot` / `melee` / `respawn` intents through a new `conn.input.actions` queue + `respawnRequested` flag. `server/tick.js` drains actions per conn, then calls `tickMelee` → `tickShooting` → `tickServerPlayerHealth` → mob ticks → `tickCombat` against the live players. Newly-dead conns trigger `{op:"event",kind:"death",playerId}` and stop receiving input; a dead conn's `respawnRequested` triggers `{op:"event",kind:"respawn",playerId,zoneId,x,y}` with HP restored to MAX and position reset to `instance.zone.spawnPoint`. Delta and snapshot now carry `hp` / `hpMax` / `dead`. `client/online.js` translates shoot/melee keypresses to intents, opens `gameOver.js` on `event:death` for self, and pipes its Continue callback to a `respawn` intent.
- **(D) 30-s ghost grace.** `server/app.js` `onDisconnect` no longer removes the conn from byUuid / party / instance — it sets `conn.ghostExpiresAt = now + ghostGraceMs` and schedules a `finalizeGhost` timer. Ghosted conns are filtered out of the tick's live-player list (frozen entity, no input/combat). `handleHello` checks for a ghost BEFORE the 4003 conflict — a fresh hello with the same UUID rebinds the new WS's message/close listeners to the existing conn via `rebindWsToConn`, clears the timer, and sends a fresh welcome. `createApp({ ghostGraceMs })` is configurable; tests use 80 ms / 2 s windows to avoid 30-s waits.
- **Tests:** new `tests/serverCombat.test.js` (+6 tests, 214 → 220 total) covers bullet kills mob, mob kills player + event:death, respawn restores HP + position + event:respawn, friendly-fire off by default, ghost reconnect within grace (no 4003), and ghost finalize after grace (fresh login).

### Phase 4 step 2 — known gaps / follow-ups

- **Player-initiated attacks no-op until step 4 (equipment).** `getEquipped(SLOT_MELEE/RANGED, idx)` returns null on the server today, so `shoot()` / `performMeleeSwing()` exit early without spawning bullets. The combat *resolution* path is fully authoritative — mob → player damage works — but you can't kill mobs until equipment + inventory (steps 3 & 4) land. The intents, the actions queue, the keypress wiring, and the bullet → mob path through `tickCombat` are all in place; equipment installs the missing piece.
- **Online HUD doesn't show HP yet.** The wire shape carries `hp` / `hpMax` in deltas + snapshots, but `client/online.js` only installs the FPS HUD. Wire the health bar (`client/healthHud.js` reads from `playerHealth.js`'s global records — for online, swap to reading `session.self.hp`) when Phase 4 step 3 lands inventory, which already needs an HUD pass.
- **Reconnect-while-dead.** A player who dies, then disconnects, then reconnects within 30 s gets the fresh welcome with `dead: true` on self — but `client/online.js`'s welcome path doesn't re-open the GameOver modal. Trivial to add: `if (self.dead) showGameOver(...)` in `applySnapshot`. Defer until someone hits it.
- **Pickups still read `isPlayerDead` from module records.** `shared/pickups.js` still uses the legacy per-index path. Out of scope this step; step 3 (pickups) is the natural cleanup point.
- **Player-player tile collision still absent.** Carried over from Phase 2/3.
- **No rate limiting yet.** Carried over. Step 3 may want to bundle this since action ops grow surface area.

### Phase 4 step 3 — what landed (2026-05-26)

- **Inversion: `shared/pickups.js`.** Dropped the three remaining `../client/*` imports (audio, toast, dialogue) in favour of a `setPickupHandlers({sfx, toast, resolveDialogue, dialogueLines, onPickup, onAutoEquip})` seam (default everything = no-op). `checkPickup` now takes either `{zone, players}` (preferred — caller pre-filters dead) or the legacy `{zone, player, player2}` shape; the `isPlayerDead` per-index module read is gone. Server's `tick.js` already filters `liveConns` and threads `livePlayers` in; offline's `client/main.js` does the same via `allPlayers(state)`.
- **Inversion: `shared/inventory.js`.** Same backend template as combat's step-2 HP seam. `setInventoryBackend(backend)` swaps the implementation; `addAmmo / removeAmmo / getAmmo / snapshotInventory / clearInventory` accept either a numeric index (legacy single/co-op) or a player object (server). Default backend is unchanged behaviour against the global per-index storage — every existing offline call site (combat, dialogue, shooting, hud, inventoryScreen, tests) keeps working without edits.
- **Server boot wires both backends.** New `server/inventoryBackend.js` mutates `conn.player.inventory = {<sid>: count}` directly; new `server/pickupHandlers.js` installs no-op sfx/toast, drops hint resolution, hooks `onPickup` into a per-instance queue, and stubs `onAutoEquip` (deferred to step 4). `server/index.js` calls `installServerInventoryBackend()` + `installServerPickupHandlers()` alongside the existing combat health backend.
- **Server tick.** Step 6 between combat and death-event detection: `withPickupContext(instance, () => checkPickup({zone, players: livePlayers}))`. The context manager makes the per-instance event queue visible to the shared module's `onPickup` so the handler knows which queue to push into. Per-pickup events drain into the tick's event broadcast as `{op:"event", kind:"pickup", playerId, speciesId, amount}`. Bundles (e.g. 7001 = "kunai.x10") collapse to a single event with `amount=10` — the shared module groups bundle contents by species before calling the handler.
- **Snapshot adds `inventory`.** `serializePlayer` in `server/zoneInstance.js` includes `inventory: { ...(p.inventory || {}) }` on welcome / `event:zoneChange` snapshots. Per-tick deltas do *not* carry inventory — the canonical client-side update is the `event:pickup` frame. Client `mirrorFromServer` hydrates `p.inventory` from the snapshot copy; the local mirror is reset on every welcome.
- **Client: online HUD HP bar + pickup toast.** `client/onlineHealthHud.js` is a small DOM bar updated every frame from `session.self.hp / hpMax`. `client/online.js` installs it, polls it from the loop, and handles `event:pickup` by incrementing the local mirror's inventory and (for self) showing a `+N Name` toast. `event:zoneChange` already routes through `applySnapshot` so inventory survives travel.
- **Tests:** new `tests/serverPickups.test.js` (+6 tests, 220 → 226 total) covers: PickableObject under a live player is collected + event:pickup fires, Bundle expands into one event with bundle-sized amount, two players keep independent inventories, dead conns don't auto-pick, ghosted conns don't auto-pick, snapshot serializes inventory and is defensive-copied.
- **Verify:** offline + online both load with zero console errors (headless Chrome via CDP, screenshots at /tmp/sb-verify-{offline,online}.png). Online HP bar visible top-left ("HP 100 / 100"). Server boots in <200 ms; `/health` → 200.

### Phase 4 step 3 — known gaps / follow-ups

- **`combat.js`'s catcher refund still calls `addAmmo(sid, 1, b._playerIndex|0)` with a numeric index.** Server backend's `asPlayer` returns null for a number and the add no-ops — i.e. the bullet-catcher skill refund is broken server-side. Not exercised today (player attacks no-op until equipment lands in step 4); fix when step 4 spawns server-side bullets (thread the owning conn's player object through `b._playerOwner` or similar).
- **Auto-equip is server no-op.** A weapon pickup goes into inventory but doesn't equip server-side because `onAutoEquip` is a stub. Step 4 will replace the stub with a real per-player equipment write.
- **Hints don't fire server-side.** `Hint` entities (consumable + persistent) are matched by `classify` but the server's `resolveDialogue` / `dialogueLines` handlers return `null` / `[]`, so the consumable variant just despawns silently and the persistent variant idles. Add an `event:toast` (or roll into the dialogue work in step 7) so online players get the same hint-sign experience offline does.
- **`shared/storage.js` writes for the collected-item flag.** `checkPickup` still calls `setValue("item_collected.${e.id}", 1)` on collection. Server's memory backend is a single shared Map keyed only by entity id — so two parties picking up the same id in their own instances would collide. Doesn't currently matter (`shared/storage.js` is global per process and only Zone State checks rely on it offline), but flag it before persistence lands in phase 6.
- **No rate limiting yet.** Carried over from steps 2 + 1. Action ops (`shoot`, `melee`, `respawn`) plus the new wire surface from step 4 (equip) will push us over the 30 intents/sec budget if a client is hostile.
- **Player-player tile collision still absent.** Carried over from Phase 2/3.

### Phase 4 step 4 — what landed (2026-05-26)

- **Inversion: `shared/equipment.js`** swapped to a `setEquipmentBackend(backend)` seam (same template as inventory). Default (legacy) backend reads from a player object's `equipment` field first if present (so online mirror players Just Work without a second backend in the client), otherwise falls back to per-index storage. Numeric indices keep working for single/co-op offline call sites.
- **Threaded player object through shared call sites.** `shared/shooting.js` (`shoot`) and `shared/melee.js` (`performMeleeSwing`) now pass the shooter / swinger directly into `getEquipped` and `getAmmo` / `removeAmmo`. `shared/entities.js` (`drawPlayer`) does the same for the weapon overlay. Spawned bullets now carry `_playerOwner` (player object) in addition to the legacy `_playerIndex`, so server-side catcher refunds route through the per-player inventory backend (fix for step 3's known gap).
- **`server/equipmentBackend.js`** mutates `conn.player.equipment = { ranged, melee }`. Default ranged = `DEFAULT_RANGED_WEAPON_ID` (1160, kunai launcher); melee starts null. `initPlayerEquipment` runs at `createConnection` time so attack intents work immediately.
- **Server combat damage reductions apply per player.** `server/combatHealthBackend.js`'s `applyBurst` and `applyContinuous` now call `getEquipped(slot, player)` to derive damage reductions before deducting HP. The shield (1171) halves incoming damage on whichever conn equips it.
- **Server auto-equip + event:equip.** `server/pickupHandlers.js`'s `onAutoEquip` stub became a real write: `setEquipped(slot, weaponSp.id, picker)` followed by queuing an `event:equip {playerId, slot, speciesId}` into the per-instance event queue. The tick drains pickup + equip events together.
- **Snapshot adds `equipment`** to `serializePlayer` in `server/zoneInstance.js`. Per-tick deltas still omit it (canonical update = `event:equip`).
- **Client online handles `event:equip`** by mutating the mirror player's `equipment` object and showing a one-shot toast (`Equipped: Name\nPress G/F`). `mirrorFromServer` also hydrates `equipment` from snapshots so rejoin / zone-change restores state. The shared equipment backend's player-direct read makes the offline renderer transparently use the mirror's equipment for online players.
- **Tests:** new `tests/serverEquipment.test.js` (+6 tests, 226 → 232 total). Covers: default ranged equipped on connect, two conns keep independent slots, weapon pickup auto-equips into the right slot + emits event:equip, snapshot serializes equipment with defensive copy, shoot intent spawns a bullet carrying `_playerOwner`, equipped shield halves damage taken (end-to-end through `tickCombat` against a real CloseCombatMonster).
- **Verify:** offline + online both load with zero console errors. Online shows HP bar; the spawn-adjacent monster kills the player as before (combat → death → GameOver round-trip working). The `_playerOwner` thread also fixed the step-3 carry-over: server-side catcher refunds now land on the right conn's inventory.

### Phase 4 step 4 — known gaps / follow-ups

- **No online ammo HUD.** Offline has `client/ammoHud.js` in the top-right; online doesn't install it. Trivial port — read `session.self.inventory[KUNAI_SPECIES_ID]` (or the equipped weapon's bullet species) instead of `getAmmo(...)`. Defer until someone notices.
- **Pickups still don't dedupe `item_collected.X` across party instances.** Step 3's gap carried over.
- **`shared/storage.js` writes still global server-side.** Same gap — the collected-item flag in `checkPickup` writes to a shared Map keyed only by entity id. Two parties picking up the same id in their own instances would collide. Not currently exercised since persistence (Phase 6) hasn't landed.
- **Equipment listeners don't fire on the server.** `onEquipmentChange` subscribers (offline `client/touch.js`, `client/ammoHud.js`) don't get notified when the server backend writes to `player.equipment` — the server backend skips listeners on purpose. Wire `event:equip` if a client-side derived-state subscriber needs to update.
- **No rate limiting yet.** Still carried over.
- **Player-player tile collision still absent.** Still carried over.

### Phase 4 step 5 — what landed (2026-05-27)

- **Inversion: `shared/gateUnlock.js`.** Dropped `client/audio` + `client/toast` imports for a `setGateUnlockHandlers({sfx, toast, onUnlock})` seam. `tryUnlockGate(gate, unlocker)` now takes a player-or-index so the inventory backend lands the key consumption on the right per-conn / per-index bag. `shared/player.js`'s `canEnter` threads the currently-being-moved player through a closure-private `activePlayer`, set/cleared by `updatePlayer`.
- **Per-instance plate state.** `shared/locks.js` now routes `isPressurePlateDown` / `setPressurePlateDown` through a `setPressurePlateBackend(backend)` seam. Default (legacy) stays storage-backed so dialogue conditions reading `pressure_plate_down_<color>` keep working offline. The server installs `serverPlateBackend` keyed off the active instance via `withPuzzleContext(instance, fn)` — two parties can solve different plate puzzles in the same zone without bleed.
- **Server gate-unlock handler.** `server/gateUnlockHandlers.js` installs no-op sfx/toast + an `onUnlock(gate, unlocker, lock)` hook that queues an `event:gateUnlocked {playerId, gateId, lock}` onto the per-instance event queue. The tick wraps movement in `withGateUnlockContext` so unlocks fire on the right instance.
- **Server tick wires puzzles + pushables.** After pickups: `withPuzzleContext(instance, () => tickPuzzles(zone, primary))` updates plates + gates from the per-instance backend; `tickPushables(zone, DT)` decays slide animations. Gate `_open` flips ride the existing entity-delta path (no new wire field).
- **Per-instance setupPuzzles.** `createZoneInstance` wraps `setupPuzzles(zone)` in `withPuzzleContext` so each instance reads its own plate state — without this, the first member of party B entering a zone where party A had a plate down would see party A's state.
- **Bugfix in `shared/puzzles.js` updateGates.** LOCK_NONE gates (which include gates freshly unlocked by `tryUnlockGate` setting `lock_type = LOCK_NONE`) are now left alone instead of being re-closed on the next tick — previously, walking through a keyed gate would immediately re-close it because `isPressurePlateDown(LOCK_NONE)` returned false. The bug existed offline too; the fix preserves Rust parity (LOCK_NONE gates are key-managed, not plate-managed).
- **Client.** `client/gateUnlockBoot.js` wires the offline audio + toast handlers (loaded by both `main.js` and `online.js`). `client/online.js` handles `event:gateUnlocked` with a self-only toast.
- **Tests:** new `tests/serverPuzzles.test.js` (+5 tests, 232 → 237 total): plate down/up, gate opens when matching plate pressed, two parties keep independent plate state in the same zone, walking through a yellow gate with a yellow key consumes the key + emits event:gateUnlocked, pushable slide animation decays.
- **Verify:** offline + online both load with zero console errors. The starting-zone gate / plate puzzles still play through correctly in offline.

### Phase 4 step 5 — known gaps / follow-ups

- **No `event:plateChange` frame.** Plate state changes only ride via entity `_frameOffsetX` deltas (which already work). If a client wants to react to a plate flip without polling the entity state, surface a dedicated event — defer until needed.
- ~~**`tickPuzzles` uses the primary live player only.**~~ Resolved 2026-05-27: `tickPuzzles(zone, playerOrPlayers)` now accepts either a single player (legacy) or an array. `updatePlates` iterates all players via `anyPlayerOnFrame`. Server tick passes `livePlayers`; offline tick passes `allPlayers(state)`, so co-op P2-alone-on-plate works too. Covered by `tests/puzzles.test.js` ("plate held by any party member") and `tests/serverPuzzles.test.js` ("plate held by a second party member alone still registers").
- **Pressure plate dialogue conditions are silent server-side.** The legacy storage write still happens (so offline dialogues work), but on the server the per-instance backend doesn't write to global storage. If a dialogue references `pressure_plate_down_yellow` it'll always evaluate to false server-side until dialogue (step 7) routes through per-instance storage.
- **`gateUnlock` toast wording is duplicated** between `shared/gateUnlock.js` (offline default) and `client/online.js` (online event handler). If we localize gate-unlock toasts they'll need to converge through `tr(...)`.
- **No rate limiting yet, no player-player tile collision.** Still carried over.

### Phase 4 step 6 — what landed (2026-05-27)

- **`shared/trails.js`** swapped `getSprite` (from `client/assets.js`) for `getSpriteByName` (from `shared/species.js`, which already has the inverted sprite-lookup seam from step 1). Same for `shared/cutscenes.js`. Both modules now import-clean.
- **`shared/cutscenes.js`** added a `setCutsceneHandlers({onStart, onEnd})` seam. Defaults are null. Server installs handlers that queue `event:cutsceneStart` and `event:cutsceneEnd` to the per-instance event queue via `withCutsceneContext(instance, fn)`. Client (offline) doesn't install — local cutscenes need no extra eventing.
- **Server tick** runs `tickAfterDialogue(zone, DT)`, `tickCutscenes(zone, primary, DT)` (wrapped in `withCutsceneContext`), and `tickTrails(zone, primary, DT)` after pushables/puzzles. `setupCutscenes(zone)` runs once per instance in `createZoneInstance` so each instance gets its own `cutscenes` array.
- **No client changes needed.** Cutscene render reads `zone.cutscenes[i]._isPlaying / _frameIndex` straight from the snapshot/delta — but the live entity state goes through `snapshotZone`'s entity serializer; cutscenes themselves don't ride on `zone.entities`, so the client wouldn't see them in online mode without further work. For v0 the cutscenes in zone 1001 are gated by the storage key (`getValue(c.key) === 1`) which is set by the offline player's local save — so online clients never see any cutscene either way until persistence (Phase 6) lands and the server can read per-account flags. Trails are similar: a `zone._trails` list, not in `entities`, so online clients don't render them today. The shared inversions still cleared the import-rule violation, which is what step 6 was supposed to do.
- **Tests:** new `tests/serverTrails.test.js` (+2 tests, 237 → 239 total). Covers: walking across snow leaves a trail entry; trails decay past their lifespan.
- **Verify:** offline + online both load with zero console errors. Trails work in offline (snow tiles drop footsteps).

### Phase 4 step 6 — known gaps / follow-ups

- **Online clients don't render cutscenes or trails.** `zone.cutscenes` and `zone._trails` aren't part of the entity wire shape; clients only see `zone.entities`. To surface these, either include them in deltas/snapshots or move cutscene state onto regular entities. Defer — neither system is exercised by current data without a player save state that hasn't transferred to online.
- **Trails interpolation is via `lastTileByZone` WeakMap.** Server side, this is keyed by the live `zone` object — fine, but if instance teardown garbage-collects the zone, the WeakMap entry vanishes too (correct behavior).
- **AfterDialogue's `_flyAway` decoration isn't on the wire shape.** The entity's frame.x moves; entity delta serializer picks that up (it whitelists `frame`). So flying NPCs animate to clients via existing deltas. But the actual removal via `splice` triggers the `removed.entities` path which is already wired.
- **`setValue` writes inside `finishCutscene` still write to global storage.** Per-instance scope for the cutscene-key flag would prevent two parties from blocking each other's cutscenes, but in v0 no zone has shared cutscenes wired to gates. Same caveat as the plate-storage write; revisit when persistence (Phase 6) lands.

### Phase 4 step 7 — what landed (2026-05-27)

- **Split: `client/dialogue.js` → `shared/dialogue.js`.** Pure resolution + reward logic moved: `resolveEntityDialogue`, `dialogueLines`, `splitOnSeparator`, plus a new `applyDialogueReward(d, playerOrIndex)` that writes the storage flags (`dialogue.answer.*` + `dialogue.reward.*`) and grants the reward through the per-player inventory backend. The client modal re-exports the resolvers so existing offline callers (interactInput, pickupBoot) keep importing from `client/dialogue.js` unchanged.
- **New input ops: `interact` + `dialogueClose`.** `applyInputIntent` routes both. `handleInteractIntent(conn)` resolves the facing entity, computes lines, queues `event:dialogueOpen {forPlayerId, entityId, lines}`. `handleDialogueCloseIntent(conn)` runs `applyDialogueReward` + `handleAfterDialogue` (Disappear → entity splice; FlyAwayEast → `_flyAway` decoration), emits `event:dialogueClose` + (if reward) `event:toast {textKey:"dialogue.reward_received", args:{name}}`. Per-conn `_activeDialogue = {entityId, dialogue, target}` blocks re-entry while a modal is open.
- **Client online wires `interact` to a keydown + `dialogueOpen` → modal.** Online's keydown listener now translates the interact action into an `interact` intent (gated on `!isDialogueOpen()` for a fast local short-circuit). `client/dialogue.js`'s new `showDialogueLines(lines)` opens the modal with already-resolved lines; on close, the online client sends a `dialogueClose` intent. `event:toast` now generates a localized DOM toast through `tr(textKey)`.
- **Tick reset semantics changed.** `instance._pendingPickupEvents` is no longer reset at the top of `tickOnce` — interact / dialogueClose events arrive between ticks via `applyInputIntent` and would have been wiped. Now we lazily init the queue if absent and drain (clear length) only at the end of the tick.
- **Tests:** new `tests/serverDialogue.test.js` (+5 tests, 239 → 244 total). Covers: interact → event:dialogueOpen with lines, dialogueClose → event:dialogueClose + Disappear removes NPC, dialogue reward grants inventory + emits event:toast, interact during open is a no-op, interact with nothing facing the player no-ops.
- **Verify:** offline + online both load with zero console errors. Online client can drive a real dialogue end-to-end via the wire protocol.

### Phase 4 step 7 — known gaps / follow-ups

- **No per-tick `event:dialogueAdvance`.** The protocol catalogues it; the implementation lets the client drive line progression locally and only emits open / close. If we want server-driven cinematic pacing or a "player A advances, player B sees the same line" co-op-dialogue mode, server-tracked line idx + advance events become necessary.
- **`event:toast` is the *first* server → client toast surface.** Pickups (step 3) still send sfx-less `event:pickup` and the client synthesizes its own toast; same for `event:gateUnlocked` (step 5) and the auto-equip path (step 4). Reconciling all of those onto `event:toast` would let the server localize once and clients render exactly. Defer.
- **`handleAfterDialogue` runs server-side but its `splice(entity)` rides via the existing entity-delta path's `removed.entities`.** So clients see the NPC disappear on the next tick. Good. But `markCollected` writes a global storage flag — same per-party-scope concern as plates/cutscenes. Persistence (Phase 6) will need to track this per-player.
- **The dialogue modal's keybindings only accept Space and the rebound interact key.** That's fine offline. Online: the rebind set is `localStorage`-backed so the dialogue modal uses the same key bindings as offline.
- **Co-op dialogue is single-player only.** Server's `interact` only opens the dialogue for the triggering conn — other party members don't see the modal. Spec aligns with this (`forPlayerId` discriminator).

### Phase 4 step 8 — what landed (2026-05-27)

- **Reconnect-while-dead re-opens the GameOver modal.** `client/online.js` now checks `session.self?.dead` after the welcome's `applySnapshot` and (if true) calls `showGameOver(() => sendIntent("respawn"))`. Fixes the step-2 carry-over: a player who DC'd at HP 0 + reconnected within 30 s previously got back a dead-self mirror with no way to respawn.
- **Death clears `_activeDialogue` server-side.** Without this, a player who died mid-dialogue would respawn with the server still thinking they were mid-conversation; the next `interact` would silently no-op until they walked into a different NPC.
- **Tests:** `serverCombat` welcome-while-dead reports `dead:true` on self; `serverDialogue` death clears active dialogue. 244 → 246 total.
- **Verify:** offline + online both load with zero console errors.

### Phase 4 — complete

Phase 4 is done. Every system from the original list is server-authoritative; the wire shape covers position, HP, inventory, equipment, gates, plates, cutscenes, trails, dialogue, and death/respawn. Online + offline clients share the same simulation modules; nothing in `shared/` simulates client-only state.

### Phase 4 — post-completion cleanup notes

- **Remaining shared→client imports:** 2 (`shared/firstLaunch.js`, `shared/player.js`'s optional `playSfx("stepTaken")`). Neither blocks the architecture; `firstLaunch.js` is a UI gate that should probably move outright to `client/`, and `player.js`'s playSfx already no-ops server-side. Drop the `/opt/client/` push in `deploy.py` once both are addressed.
- **Pressure-plate / cutscene / dialogue storage writes are still global.** Per-party scoping for these would matter for shared-server multi-party correctness; addressed naturally by Phase 6 (persistence) which gives each session its own state row.
- **No online ammo HUD.** Trivial port from `client/ammoHud.js`.
- **No `event:dialogueAdvance` round-trip.** The client drives line progression locally and only sends `dialogueClose`. Fine for v0; add advance events if we want server-paced cinematic dialogue or shared dialogue progression across the party.
- **No rate limiting.** Spec says 30 intents/sec; not exploitable in v0 since damage paths go through server backends, but easy to add a token bucket per conn.
- **No player-player tile collision.** Two party members can stand on the same tile. Document and move on per Phase 2 decision.
- **Multi-member plate puzzles** — resolved 2026-05-27. `tickPuzzles` now takes an array; all live party members (and pushables) contribute to plate-down. See updated step 5 known-gaps entry above.

### Phase 4 — pickup notes (historical — for step 8, kept for reference)

**Step-8 plan that landed:** files most likely to change (resolved):
- Respawn-in-place toast / "You died — N seconds" UX layer.
- Reset per-run score / streak counters server-side (none today, but the natural place to add them).
- Multi-party respawn coordination — if the whole party dies, do they all warp back together?
- Re-open the GameOver modal on welcome if the conn comes back ghosted-and-dead (step 2 carry-over: a dead player who DCs + reconnects within 30 s gets a fresh welcome with `dead: true` but no modal because online.js's welcome path doesn't re-open it).

Many of these are tiny tweaks. Step 8 is intentionally scoped small — the heavy lift was step 2.

### Phase 4 — pickup notes (historical — for step 7, kept for reference)

**Step-7 plan that landed:** files most likely to change (resolved):
- `shared/dialogue.js` (lookup) + the existing `client/dialogue.js` (modal) need a split: `shared/dialogue.js` exports the state machine (which lines have been seen, what answer was given, reward tracking, etc.) — pure data. `client/dialogue.js` keeps the DOM modal but consumes state via `event:dialogueOpen / event:dialogueAdvance / event:dialogueClose`.
- `shared/pickups.js`'s hint path can finally fire on the server — it currently no-ops via `resolveDialogue: () => null`. Wire it to emit an `event:toast` with the resolved hint text.
- `shared/interact.js` (the "press E in front of an entity" path) needs an `interact` input op routed to the server, which then opens the dialogue server-side. Client renders.
- `server/dialogueHandlers.js` (new) — installs handlers + tracks per-conn dialogue state (which lines have been seen).
- Wire protocol: `interact` input op, `event:dialogueOpen {forPlayerId, entityId, lines}`, `event:dialogueAdvance {forPlayerId, lineIdx}`, `event:dialogueClose {forPlayerId}` (all in the spec). Add a `dialogueAdvance` input op so the client can drive line progression.
- Tests: `tests/serverDialogue.test.js` (interact → open → advance → close → reward grants).

Step 7 is bigger because dialogue touches inventory (rewards), storage (`dialogue.answer.*` and `dialogue.reward.*`), and the after-dialogue side-effects (Disappear / FlyAwayEast). Bundle the inversion of `client/dialogue.js → shared/dialogue.js` as a Phase 1-style file split before the server wiring.

### Phase 4 — pickup notes (historical — for step 6, kept for reference)

**Step-6 plan that landed:** files most likely to change (resolved):
- `shared/cutscenes.js` — imports `client/assets` (getSprite via the now-inverted species path? check). Cutscenes drive `_dying` and other entity flags; need an "active cutscene per instance" state and ideally `event:cutsceneStart/End` events.
- `shared/trails.js` — imports `client/assets`. Trails are render-only entities; the inversion is the same one-line `setSpriteLookup` template species/entities already use. Server can run `tickTrails(zone, player, dt)` to spawn trail entities visible to all party members.
- `shared/afterDialogue.js` — runs side-effects keyed off `dialogue_read.<text>` storage flags. Server-side, dialogue (step 7) is the bigger system; afterDialogue is a passive ticker that just needs to be called.
- `server/tick.js` — wire `tickAfterDialogue(zone, dt)`, `tickCutscenes(zone, primary, dt)`, `tickTrails(zone, primary, dt)` after pickups.
- Tests: `tests/serverTrails.test.js` (trail entity spawns when player steps on snow; decays).

After step 6 lands 3 more shared→client imports clear (`cutscenes.js`, `trails.js`, plus optionally `player.js`'s `playSfx` for "stepTaken"). Will leave 2 — `firstLaunch.js` (a client-only UI concern that should probably just move to client/) and `player.js` (optional, sfx no-ops on server anyway).

### Phase 4 — pickup notes (historical — for step 5, kept for reference)

**Step-5 plan that landed:** files most likely to change (resolved):
- `shared/pushables.js` — already passes a state object; should work server-side once driven from `server/tick.js`. The shared module already exposes `tickPushables(zone, dt)` and `pushOneTile(zone, pushable, dir)` — `shared/player.js` calls it when walking onto a pushable. Wire `tickPushables` into the server tick after pickups.
- `shared/gateUnlock.js` — currently imports `client/audio` + `client/toast` for the unlock SFX/toast. Inversion template same as the others (`setGateUnlockHandlers({sfx, toast})`). After inversion, the server's gate unlock can emit an `event:gate` or fold into entity deltas (the `_open` flag already rides the wire shape).
- `shared/locks.js` — verify it's pure; probably no changes needed.
- `shared/puzzles.js` — `tickPuzzles(zone, player)` needs to be called by the server tick after pickups; check whether it has any client imports.
- `server/tick.js` — add `tickPuzzles` + `tickPushables` calls after pickup step. Entity deltas already carry `_open` for gates, so flipping them server-side propagates to clients via the existing delta path.
- Tests: `tests/serverPuzzles.test.js` (a pressure-plate puzzle opens its gate when a player steps on the plate), `tests/serverPushables.test.js` (shoving a rock changes its entity position broadcast on the next delta).

`shared/gateUnlock.js`'s inversion clears another shared→client violation. After step 5: 4 remaining (`trails.js`, `firstLaunch.js`, `cutscenes.js`, `player.js`'s optional playSfx).

### Phase 4 — pickup notes (historical — for step 4, kept for reference)

**Step-4 plan that landed:** files most likely to change (resolved):
- `shared/equipment.js` — currently global per-index keyed via storage. Same backend pattern as inventory: `setEquipmentBackend(backend)` with `{getEquipped(player, slot), setEquipped(player, slot, sid)}`. Legacy backend wraps the per-index storage calls; server backend mutates `conn.player.equipment = {<slot>: sid}`.
- `server/equipmentBackend.js` (new) + `server/pickupHandlers.js`'s `onAutoEquip` stub replaced with a real write through the new backend. Wire `event:equip {playerId, slot, speciesId}` when a weapon auto-equips on pickup.
- `server/connection.js` initializes `conn.player.equipment = { ranged: DEFAULT_RANGED_WEAPON_ID, melee: null }` on create, so attack actions immediately spawn bullets / swing.
- `shared/playerHealth.js`'s `applyDamageReductions` reads `getEquipped(slot, index)` — needs the same routing (offline = legacy index, server = player object via the backend).
- `client/online.js` handles `event:equip` to update the local mirror; the future online equipment HUD reads from the mirror.
- Tests: `tests/serverEquipment.test.js` — covers default ranged equips on connect, weapon pickup auto-equips into the right slot, attack action spawns a bullet (combat → mob path through `tickCombat` exercised end-to-end).

The pickup → inventory write path already routes through the per-player backend, so the most invasive piece is done; step 4 is the same shape (one more shared module flipped, one more per-player backend on the server). After step 4 lands, player attacks fire server-authoritative bullets and the "no-op until equipment" carry-over from step 2 is cleared.

### Phase 4 — pickup notes (historical — for step 3, kept for reference)

**Pickup-for-step-3 plan that landed:** files most likely to change (resolved):
- `shared/pickups.js` — invert `client/audio`, `client/toast`, `client/dialogue` imports via a `setPickupHandlers({sfx, toast, resolveEntityDialogue})` seam (mirror the combat-step inversion template). Default-noop on the server; client wires actual handlers in `client/combatBoot.js` or a new boot file.
- `shared/inventory.js` — currently global per-index. Server needs per-conn inventory; same shape as step 2's HP backend: add `setInventoryBackend(backend)` with `{add(player, speciesId, amount), remove(player, speciesId, amount), get(player, speciesId)}`. Server backend mutates `conn.player.inventory = {<speciesId>: count}`. Default backend wraps the legacy per-index calls.
- `server/tick.js` — call `tickPickups(zone, players, DT)` after combat. Server emits `event:pickup` with `{playerId, speciesId, amount}` per the spec.
- `client/online.js` — handle `event:pickup`: show a toast, update the local inventory mirror (which the future inventory HUD reads).
- New tests: `tests/serverPickups.test.js`.

Equipment (step 4) lands right after — once inventory is per-player, equipping is just routing slot writes to the same backend.

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
| ~~`shared/trails.js`~~ | ~~`assets` (getSprite)~~ | ~~step 6~~ — landed; switched to `getSpriteByName` from species.js. |
| ~~`shared/cutscenes.js`~~ | ~~`assets` (getSprite)~~ | ~~step 6~~ — landed; same swap, plus `setCutsceneHandlers({onStart, onEnd})` seam. |
| `shared/player.js` | `audio.playSfx` ("stepTaken") | optional — playSfx already no-ops server-side |
| ~~`shared/combat.js`~~ | ~~`audio` (hits/deaths), `settings` (friendly fire flag)~~ | ~~step 2~~ — landed; `setSfxHandler` + `setFriendlyFireGetter` seams, default getter returns false |
| ~~`shared/melee.js`~~ | ~~`audio.playSfx` (swing)~~ | ~~step 2~~ — landed; `setSfxHandler` seam |
| ~~`shared/shooting.js`~~ | ~~`audio.playSfx` (shot / no-ammo)~~ | ~~step 2~~ — landed; `setSfxHandler` seam |
| ~~`shared/pickups.js`~~ | ~~`dialogue`, `toast`, `audio`~~ | ~~step 3~~ — landed; `setPickupHandlers({sfx, toast, resolveDialogue, dialogueLines, onPickup, onAutoEquip})` seam, all defaults no-op. Server installs queue-onto-instance `onPickup`; hints currently silent server-side (deferred to step 7 with dialogue). |
| ~~`shared/gateUnlock.js`~~ | ~~`audio`, `toast`~~ | ~~step 5~~ — landed; `setGateUnlockHandlers({sfx, toast, onUnlock})` seam. Server's `onUnlock` queues `event:gateUnlocked`. |
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

- **Branch:** `main` is the starting point. **Phase 4 is complete** — all 8 steps merged + deployed (steps 1 → 4 on 2026-05-26; steps 5 → 8 on 2026-05-27). Phase 2, 3, 4, and 5 are done. Production is live at <https://sneakbit.curzel.it> (WS at `wss://sneakbit.curzel.it/ws`). Next phase is **Phase 6 — persistence** (better-sqlite3 swap of the memory backend). **Heads up:** the post-commit hook fires on `commit`, not on `merge`, so merging a future feature branch into `main` will NOT auto-deploy — see "Operational notes for Phase 4" above for the workaround.
- **Folder layout (actual, post-step-4):**
  ```
  shared/   43 .js files. Phase 4 step 4 converted equipment to a
            backend seam (setEquipmentBackend) — the default backend
            reads from `player.equipment` first when given a player
            object, so online mirror players are served without a
            separate client backend. shooting/melee/entities now thread
            the player object through getEquipped / getAmmo /
            removeAmmo; spawned bullets carry `_playerOwner` for
            server-side catcher routing.
  client/   47 .js files — no new files in step 4 (the equipment
            mirror is handled by the same backend default + the
            event:equip handler added to online.js).
  server/   17 files — adds equipmentBackend.js (per-player slots on
            conn.player.equipment, installed at boot; default ranged =
            kunai launcher):
              app.js
              combatHealthBackend.js + equipment-aware damage reductions
              connection.js          + initPlayerEquipment on new conns
              data.js
              equipmentBackend.js    per-player equipment backend
              index.js               + installServerEquipmentBackend()
              inventoryBackend.js
              memoryBackend.js
              party.js
              pickupHandlers.js      onAutoEquip writes via backend +
                                     queues event:equip
              tick.js                drains pickup + equip events
              ws.js
              zoneInstance.js        + equipment in player snapshot
              package.json
              package-lock.json
              node_modules/          gitignored
  data/     unchanged — 125 zone JSONs + species.json + strings.en.json.
  tests/    232 tests, all green. Phase 4 step 4 added 6
            (serverEquipment: default equipped on connect,
            two-conn independence, weapon pickup auto-equips +
            event:equip, snapshot serializes equipment, shoot intent
            spawns bullet with _playerOwner, equipped shield halves
            continuous damage).
  deploy.py pushes server/, shared/, client/, data/ to /opt/{sneakbit-server,shared,client,data}/.
            Client dir push still stays — 5 shared→client violations remain
            (player.js, gateUnlock.js, firstLaunch.js, trails.js,
            cutscenes.js). Drop in step 5 / 6 as each lands.
  ```
- **Next concrete step:** Phase 6 — **persistence (better-sqlite3)**. Goal: per-player state (position, zone, HP, inventory, equipment) and per-party state (members, current zones) survives server restarts. The storage backend seam in `shared/storage.js` is already pluggable — Phase 6 swaps `server/memoryBackend.js` for a SQLite-backed equivalent. Per-instance state (plate, cutscene-hidden flag) also needs a home; consider scoping by (uuid, key) for player keys and (partyId, zoneId, key) for zone keys. Will likely need a debounce so we don't write SQL on every position delta. The npm dep is the main "blast radius" call (the only one in the entire repo right now is `ws`).
- **Known-good local state right now:**
  - `node --test tests/*.test.js` is 246/246 on `main`.
  - `node server/index.js` boots in ~150ms, logs `sneakbit server ready (starting zone 1001)` + listening on `127.0.0.1:8090`. `GET /health` → 200 ok.
  - End-to-end smoke (one tab at `?online=1`): client loads with zero console errors; HP bar reads "HP 100 / 100" top-left; pause menu on Esc; Party panel via the menu. Walk near a CloseCombatMonster, HP drops every tick, GameOver modal opens, Continue → server returns the player to spawn at full HP. Force-close + reopen within 30 s → same player object, same position. Wait 30 s → fresh login. Pickup of a weapon auto-equips server-side. Pressure-plate puzzles + keyed gates work in offline; server tests cover the same code paths under per-instance backends.
  - Tests covering the above: `tests/serverCombat.test.js` (6), `tests/serverPickups.test.js` (6), `tests/serverEquipment.test.js` (6), `tests/serverPuzzles.test.js` (5), `tests/serverMobs.test.js` (4).
- **Production state (verified 2026-05-27):** `https://sneakbit.curzel.it/health` → 200, `wss://sneakbit.curzel.it/ws` delivers a `welcome` with a 5-char `partyCode`, `https://restartborgo.it/` → 200. systemd unit `sneakbit-server` is active. The VPS holds the full tree at `/opt/{sneakbit-server,shared,client,data}/`.
- **Step-5 gaps to remember when starting step 6:** see "Phase 4 step 5 — known gaps" above. None block step 6. Multi-player plate puzzles were patched 2026-05-27 (tickPuzzles now takes an array). Pressure-plate dialogue conditions will need a thought when persistence lands.
- **What's NOT done yet for the hard rule:** Phase 4 steps 1–6 cleared 9 of the 11 shared→client imports (`species.js`, `entities.js`, `combat.js`, `melee.js`, `shooting.js`, `pickups.js`, `gateUnlock.js`, `trails.js`, `cutscenes.js`). 2 remain: `firstLaunch.js` (a client-only UI concern that should probably move outright to `client/`) and `player.js`'s `playSfx("stepTaken")` (optional — already no-ops server-side). Once both are addressed the `/opt/client/` push in `deploy.py` can drop. Step 7 doesn't touch either, but addressing them is a 10-line follow-up.
- **Memory note:** persistent notes in `~/.claude/projects/.../memory/` — movement-model decision, asset-pipeline source, server-roadmap pointer (bumped to step 3), post-commit-hook macOS gotcha, and the remote-verify workflow (headless Chrome via CDP for change-screenshots). All still apply.

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
