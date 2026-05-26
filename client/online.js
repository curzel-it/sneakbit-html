// Online-mode entry. Opens a WS to the authoritative server, builds the
// zone from the welcome snapshot (not from a local data/ file), and runs
// a render-only game loop that forwards input as intent ops and reads
// every player's position from server deltas.
//
// Compared to the offline main(): no local tick, no save/load, no
// transitions, no mobs/combat/pickups. Creative mode and the map editor
// are hard-disabled. Those simulation systems land in later phases.

import { STARTING_SPAWN } from "../shared/constants.js";
import { setCreativeMode } from "../shared/creativeMode.js";
import { buildZone } from "../shared/zone.js";
import { createPlayer } from "../shared/player.js";
import { createCamera, updateCamera } from "../shared/camera.js";
import { createBiomeAnimation, tickBiomeAnimation } from "../shared/biomeAnimation.js";
import { tickEntities } from "../shared/entities.js";
import { updateVisibleEntities } from "../shared/zoneVisibility.js";
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
import { installToast } from "./toast.js";
import { installTouchControls } from "./touch.js";
import { getZoneCache } from "./zoneCache.js";
import { showLoadingScreen, bumpLoadingProgress, hideLoadingScreen } from "./loadingScreen.js";

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

  const stateData = welcome.zone.state;
  const zone = buildZone(rehydrateRawZone(stateData));
  zone.spawnPoint = stateData.spawnPoint ?? { x: STARTING_SPAWN.x, y: STARTING_SPAWN.y };

  const canvas = document.getElementById("game");
  const renderer = createRenderer(canvas);
  const biomeAnim = createBiomeAnimation();
  getZoneCache(zone);

  const players = new Map(); // playerId -> local Player object (render-only)
  for (const sp of stateData.players) players.set(sp.playerId, makeMirrorPlayer(sp));

  const self = players.get(welcome.playerId);
  if (!self) throw new Error(`welcome.playerId ${welcome.playerId} missing from players list`);

  const camera = createCamera();
  installAutoZoom(canvas, camera, hud.el);
  if (zone.soundtrack) playTrack(zone.soundtrack);

  client.on("delta", (delta) => {
    for (const sp of delta.players) {
      let p = players.get(sp.playerId);
      if (!p) {
        p = makeMirrorPlayer(sp);
        players.set(sp.playerId, p);
        continue;
      }
      mirrorFromServer(p, sp);
    }
  });

  // Edge-detect held direction → send one intent per change.
  let lastIntentDir = null;
  function pickHeldDir(input) {
    for (const d of DIR_PRIORITY) if (input.held.has(d)) return d;
    return null;
  }

  startGameLoop((dt) => {
    const input = pollInput();
    const desired = pickHeldDir(input);
    if (desired !== lastIntentDir) {
      client.sendIntent(desired ? DIR_TO_INTENT[desired] : "stopMove");
      lastIntentDir = desired;
    }

    tickBiomeAnimation(biomeAnim, dt);
    tickEntities(dt);
    updateCamera(camera, [self], zone);
    updateVisibleEntities(zone, camera);
    const renderPlayers = [...players.values()];
    render(renderer, zone, camera, renderPlayers, biomeAnim.frame);
    updateHud(hud, {
      zoneId: zone.id,
      fps: 1 / dt,
      showFps: getSettings().showFps,
    });
  });
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
