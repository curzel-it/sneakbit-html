// Online-mode entry. Opens a WS to the authoritative server, builds the
// zone from the welcome snapshot (not from a local data/ file), and runs
// a render-only game loop that forwards input as intent ops and reads
// every player's position from server deltas.
//
// Compared to the offline main(): no local tick, no save/load, no mobs/
// combat/pickups. Creative mode and the map editor are hard-disabled.
// Those simulation systems land in later phases. Phase 3 adds zone
// transitions (travel op + event:zoneChange) and parties (the HTML panel
// in client/partyPanel.js).

import "./spritesBoot.js";

import { STARTING_SPAWN } from "../shared/constants.js";
import { setCreativeMode } from "../shared/creativeMode.js";
import { buildZone } from "../shared/zone.js";
import { createPlayer } from "../shared/player.js";
import { createCamera, updateCamera } from "../shared/camera.js";
import { createBiomeAnimation, tickBiomeAnimation } from "../shared/biomeAnimation.js";
import { tickEntities } from "../shared/entities.js";
import { updateVisibleEntities } from "../shared/zoneVisibility.js";
import { findTeleporterAt } from "../shared/transitions.js";
import { loadSpeciesData } from "../shared/species.js";
import { loadStringsData } from "../shared/strings.js";

import { loadAssets } from "./assets.js";
import { loadSpecies, loadStrings } from "./data.js";
import { composeBiomeSheet } from "./biomeSheet.js";
import { createRenderer, render } from "./renderer.js";
import { startGameLoop } from "./gameLoop.js";
import { initInput, pollInput } from "./input.js";
import { installAutoZoom } from "./zoom.js";
import { installHud, updateHud } from "./hud.js";
import { loadAudio } from "./audio.js";
import { loadSettings, getSettings } from "./settings.js";
import { installMusic, playTrack } from "./music.js";
import { installToast, showToast } from "./toast.js";
import { installTouchControls } from "./touch.js";
import { getZoneCache } from "./zoneCache.js";
import { showLoadingScreen, bumpLoadingProgress, hideLoadingScreen } from "./loadingScreen.js";
import { installPartyPanel, openPartyPanel, updatePartyPanel } from "./partyPanel.js";
import { installOnlineMenu, isOnlineMenuOpen } from "./onlineMenu.js";

import {
  connectOnline,
  getOrCreateOnlineUuid,
  resolveServerUrl,
} from "./onlineConnection.js";

// Tile-locked movement → at most one direction at a time. We send moveX
// once per "now I want this direction" transition and stopMove when no
// direction is held. The server re-uses HOLD_PRIORITY in shared/player.js
// to keep chaining as long as a direction stays held.
const DIR_PRIORITY = ["up", "down", "left", "right"];
const DIR_TO_INTENT = {
  up: "moveUp", down: "moveDown", left: "moveLeft", right: "moveRight",
};

export async function runOnlineMode() {
  setCreativeMode(false);

  showLoadingScreen(5);
  initInput();
  loadSettings();
  loadAudio();
  installToast();
  installTouchControls();
  installMusic();
  const hud = installHud();

  const uuid = getOrCreateOnlineUuid();
  const url = resolveServerUrl(location, new URLSearchParams(location.search));

  // Open the WS in parallel with asset/species/strings loading. The
  // welcome's zone snapshot can't be turned into a runtime zone until
  // species are loaded (buildZone reads getSpecies), so we await both.
  const [{ welcome, client }, , speciesRaw, stringsRaw] = await Promise.all([
    connectOnline({ url, uuid }).then((r) => {
      bumpLoadingProgress("Server connected");
      return r;
    }),
    loadAssets().then((r) => { bumpLoadingProgress("Sprites loaded"); return r; }),
    loadSpecies().then((r) => { bumpLoadingProgress("Species loaded"); return r; }),
    loadStrings("en").then((r) => { bumpLoadingProgress("Strings loaded"); return r; }),
  ]);

  loadSpeciesData(speciesRaw);
  loadStringsData(stringsRaw);
  await composeBiomeSheet();
  bumpLoadingProgress("Ready");
  hideLoadingScreen();

  // Game state owned by this entry. Mutated by event handlers (zoneChange
  // rebuilds zone+players; partyUpdate refreshes the panel).
  const session = {
    zone: null,
    players: new Map(), // playerId -> mirror Player
    self: null,
    selfId: welcome.playerId,
    party: {
      partyId: welcome.partyId,
      code: welcome.partyCode,
      members: welcome.members,
    },
    travelInFlight: false,
  };

  applySnapshot(session, welcome.zone.state);

  const canvas = document.getElementById("game");
  const renderer = createRenderer(canvas);
  const biomeAnim = createBiomeAnimation();
  getZoneCache(session.zone);

  const camera = createCamera();
  installAutoZoom(canvas, camera, hud.el);
  if (session.zone.soundtrack) playTrack(session.zone.soundtrack);

  const panel = installPartyPanel({
    onJoin: (code) => client.send({ op: "party.join", code }),
    onLeave: () => client.send({ op: "party.leave" }),
  });
  updatePartyPanel(panel, session.party);

  installOnlineMenu({
    onOpenParty: () => openPartyPanel(panel),
    onLeaveParty: () => client.send({ op: "party.leave" }),
  });

  client.on("delta", (delta) => {
    for (const sp of delta.players ?? []) {
      let p = session.players.get(sp.playerId);
      if (!p) {
        p = makeMirrorPlayer(sp);
        session.players.set(sp.playerId, p);
        continue;
      }
      mirrorFromServer(p, sp);
    }
    if (delta.entities) mergeEntityDelta(session.zone, delta.entities);
    if (delta.removed?.entities?.length) {
      removeEntities(session.zone, delta.removed.entities);
    }
  });

  client.on("event", (msg) => {
    if (msg.kind === "zoneChange") onZoneChange(session, msg, camera);
    else if (msg.kind === "partyUpdate") onPartyUpdate(session, msg, panel);
    else if (msg.kind === "partyJoinFailed") onPartyJoinFailed(msg);
    else if (msg.kind === "uuidConflict") {
      showToast("Already playing in another tab.");
    }
  });

  // Edge-detect held direction → send one intent per change. Also detect
  // "player just landed on a teleporter tile" → send travel.
  let lastIntentDir = null;
  function pickHeldDir(input) {
    for (const d of DIR_PRIORITY) if (input.held.has(d)) return d;
    return null;
  }

  let lastSelfTile = { x: -1, y: -1 };

  startGameLoop((dt) => {
    // The server keeps ticking regardless, but we stop sending movement
    // intents while the menu is open so navigating the menu doesn't
    // drag the avatar across the floor. The edge below collapses to
    // "stopMove" on the open transition; the next held-direction
    // re-fires on close.
    const menuOpen = isOnlineMenuOpen();
    const input = menuOpen ? null : pollInput();
    const desired = menuOpen ? null : pickHeldDir(input);
    if (desired !== lastIntentDir) {
      client.sendIntent(desired ? DIR_TO_INTENT[desired] : "stopMove");
      lastIntentDir = desired;
    }

    // Detect tile crossings on `self` and ask the server to travel when
    // the new tile is a teleporter. The server validates and may drop
    // the message — the client is just the eventually-consistent trigger.
    if (session.self && !session.travelInFlight) {
      const tx = session.self.tileX;
      const ty = session.self.tileY;
      if (tx !== lastSelfTile.x || ty !== lastSelfTile.y) {
        lastSelfTile = { x: tx, y: ty };
        const tele = findTeleporterAt(session.zone, tx, ty);
        if (tele && tele.destination?.zone) {
          session.travelInFlight = true;
          client.send({ op: "travel", viaEntityId: tele.id });
        }
      }
    }

    tickBiomeAnimation(biomeAnim, dt);
    tickEntities(dt);
    if (session.self) {
      updateCamera(camera, [session.self], session.zone);
    }
    updateVisibleEntities(session.zone, camera);
    const renderPlayers = [...session.players.values()];
    render(renderer, session.zone, camera, renderPlayers, biomeAnim.frame);
    updateHud(hud, {
      zoneId: session.zone.id,
      fps: 1 / dt,
      showFps: getSettings().showFps,
    });
  });
}

function onZoneChange(session, msg, camera) {
  applySnapshot(session, msg.snapshot);
  getZoneCache(session.zone);
  if (session.zone.soundtrack) playTrack(session.zone.soundtrack);
  // Recenter the camera immediately so the next rendered frame doesn't
  // pan across the new zone from wherever it was sitting before.
  if (session.self && camera) updateCamera(camera, [session.self], session.zone);
  // Reset the tile-cross detector so we don't immediately fire `travel`
  // again on the destination teleporter we just landed on.
  session.travelInFlight = false;
}

function onPartyUpdate(session, msg, panel) {
  session.party.partyId = msg.partyId;
  session.party.code = msg.code;
  session.party.members = msg.members;
  updatePartyPanel(panel, session.party);
}

function onPartyJoinFailed(msg) {
  const reasons = {
    not_found: "Party not found.",
    full: "That party is full.",
    same_party: "You're already in that party.",
  };
  showToast(reasons[msg.reason] ?? "Could not join party.");
}

// Rebuild the local zone and players Map from a server snapshot. Called
// on initial welcome and on every event:zoneChange.
function applySnapshot(session, stateData) {
  const zone = buildZone(rehydrateRawZone(stateData));
  zone.spawnPoint = stateData.spawnPoint ?? { x: STARTING_SPAWN.x, y: STARTING_SPAWN.y };
  session.zone = zone;
  session.players.clear();
  for (const sp of stateData.players) {
    session.players.set(sp.playerId, makeMirrorPlayer(sp));
  }
  const self = session.players.get(session.selfId);
  if (!self) throw new Error(`snapshot missing self ${session.selfId}`);
  session.self = self;
}

// The snapshot uses camelCase keys for the named-export protocol but
// buildZone() reads the raw on-disk shape (snake_case keys from data/*.json).
// Translate the two namespaces back so the same loader works for both.
function rehydrateRawZone(stateData) {
  return {
    id: stateData.id,
    biome_tiles: stateData.biomeTiles,
    construction_tiles: stateData.constructionTiles,
    entities: stateData.entities ?? [],
    world_type: stateData.zoneType,
    light_conditions: stateData.lightConditions,
    soundtrack: stateData.soundtrack,
  };
}

// A "mirror player" is a local Player object whose position/direction
// fields are overwritten from server snapshots every tick. The renderer
// reads the same fields createPlayer() produces, so this stays plug-in
// compatible with shared/player.js's data shape.
function makeMirrorPlayer(sp) {
  const p = createPlayer({ index: sp.index | 0 });
  mirrorFromServer(p, sp);
  return p;
}

function mirrorFromServer(p, sp) {
  p.x = sp.x;
  p.y = sp.y;
  p.tileX = sp.tileX;
  p.tileY = sp.tileY;
  if (sp.direction) p.direction = sp.direction;
  p.moving = !!sp.moving;
  if (typeof sp.frameIndex === "number") p.frameIndex = sp.frameIndex;
}

// Apply per-entity server updates. Entries reference existing entities
// by id and mutate fields in-place so render-time pointer identity stays
// stable. Unknown ids spawn a new entity (minion births, future loot
// drops). Static fields (dialogues, destination, etc.) are not in the
// delta wire shape, so they stay at their welcome-snapshot values.
function mergeEntityDelta(zone, updates) {
  const byId = new Map();
  for (const e of zone.entities) byId.set(e.id, e);
  for (const upd of updates) {
    const existing = byId.get(upd.id);
    if (existing) {
      existing.species_id = upd.species_id;
      if (upd.frame) {
        existing.frame = existing.frame ?? {};
        existing.frame.x = upd.frame.x;
        existing.frame.y = upd.frame.y;
        existing.frame.w = upd.frame.w;
        existing.frame.h = upd.frame.h;
      }
      if (upd.direction !== undefined) existing.direction = upd.direction;
      existing._open = !!upd._open;
      existing._spawned = !!upd._spawned;
      existing._dying = !!upd._dying;
      existing._invisible = !!upd._invisible;
      existing._frameOffsetX = upd._frameOffsetX ?? 0;
      if (upd._hp !== undefined) existing._hp = upd._hp;
    } else {
      zone.entities.push({ ...upd, frame: upd.frame ? { ...upd.frame } : null });
    }
  }
}

function removeEntities(zone, ids) {
  const drop = new Set(ids);
  zone.entities = zone.entities.filter((e) => !drop.has(e.id));
}
