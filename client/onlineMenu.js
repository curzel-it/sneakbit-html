// Online-mode pause menu. Esc toggles a slim HTML overlay with the
// settings most players actually want during a session (audio, FPS) and
// the entries that get the player into / out of a party — the spec lists
// "Party panel reachable from the pause menu" as the canonical path.
//
// Deliberately leaner than client/menu.js: inventory, skills, save
// import/export, creative tools, and the New-game / Clear-cache buttons
// are all offline-only concepts (or server-authoritative ones) and have
// no business in an online session. We re-use the existing partyPanel
// for the actual party UI — this menu just toggles it.

import { getSettings, saveSettings } from "./settings.js";
import { playSfx } from "./audio.js";
import { APP_VERSION } from "../shared/constants.js";
import {
  ACTIONS, codesFor, setBinding, resetBindings, matchesAction,
} from "./keyBindings.js";

let root = null;
let open = false;
let screen = "pause";
let rebindCapture = null;

const STYLES_ID = "online-menu-styles";

export function installOnlineMenu({ onOpenParty, onLeaveParty } = {}) {
  if (root) return root;
  root = document.createElement("div");
  root.id = "online-menu";
  root.innerHTML = `
    <div class="om-card" data-screen="pause">
      <h1>SneakBit Online</h1>
      <div class="om-row om-stack">
        <button id="om-resume">Resume (Esc)</button>
        <button id="om-open-settings">Settings</button>
        <button id="om-open-party">Party…</button>
        <button id="om-leave-party">Leave party</button>
        <button id="om-open-credits">Credits</button>
      </div>
      <p class="om-hint">
        WASD / arrows to move &middot; E to interact &middot; Esc to toggle menu<br>
        Online mode — your save lives on the server.
      </p>
      <p class="om-version">v${APP_VERSION}</p>
    </div>
    <div class="om-card" data-screen="settings">
      <h1>Settings</h1>
      <div class="om-row">
        <label for="om-sfx">SFX</label>
        <input id="om-sfx" type="range" min="0" max="100" step="1" />
        <span id="om-sfx-val"></span>
      </div>
      <div class="om-row">
        <label for="om-music">Music</label>
        <input id="om-music" type="range" min="0" max="100" step="1" />
        <span id="om-music-val"></span>
      </div>
      <div class="om-row">
        <label for="om-muted"><input id="om-muted" type="checkbox" /> Mute all</label>
      </div>
      <div class="om-row">
        <label for="om-fps"><input id="om-fps" type="checkbox" /> Show FPS</label>
      </div>
      <div class="om-row om-stack">
        <button id="om-open-controls">Key bindings…</button>
        <button id="om-settings-back">Back</button>
      </div>
    </div>
    <div class="om-card" data-screen="controls">
      <h1>Key Bindings</h1>
      <ul class="om-controls-list" id="om-controls-list"></ul>
      <p class="om-hint">
        Click a binding and press the key you want to use. Esc cancels capture.
      </p>
      <div class="om-row om-stack">
        <button id="om-controls-reset">Reset to defaults</button>
        <button id="om-controls-back">Back</button>
      </div>
    </div>
    <div class="om-card" data-screen="credits">
      <h1>Credits</h1>
      <p class="om-credits">
        <strong>SneakBit</strong> · web port of the
        <a href="https://github.com/curzel-it/sneakbit" target="_blank" rel="noopener">original Rust build</a>.
      </p>
      <p class="om-credits">
        Web port source:
        <a href="https://github.com/curzel-it/sneakbit-html" target="_blank" rel="noopener">github.com/curzel-it/sneakbit-html</a>
      </p>
      <p class="om-credits">
        Music by <a href="https://www.filippovicarelli.com/8bit-game-background-music" target="_blank" rel="noopener">Filippo Vicarelli</a><br>
        Sound effects by <a href="https://opengameart.org/content/512-sound-effects-8-bit-style" target="_blank" rel="noopener">SubspaceAudio</a>
      </p>
      <div class="om-row om-stack">
        <button id="om-credits-back">Back</button>
      </div>
    </div>
  `;
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    display: "none",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.6)",
    backdropFilter: "blur(2px)",
    zIndex: "20",
    color: "#eee",
    fontFamily: "monospace",
  });
  document.body.appendChild(root);
  injectStyles();
  bindWidgets({ onOpenParty, onLeaveParty });

  window.addEventListener("keydown", (e) => {
    if (rebindCapture) return;
    if (!matchesAction("menu", e.code) && e.code !== "Escape") return;
    e.preventDefault();
    if (!open) { openMenu(); return; }
    if (screen !== "pause") { showScreen("pause"); return; }
    closeMenu();
  });
  return root;
}

export function isOnlineMenuOpen() { return open; }

function openMenu() {
  open = true;
  showScreen("pause");
  root.style.display = "flex";
  playSfx("hintReceived", { volume: 0.5 });
}

function closeMenu() {
  open = false;
  root.style.display = "none";
  playSfx("hintReceived", { volume: 0.5 });
}

function showScreen(next) {
  screen = next;
  root.querySelectorAll(".om-card").forEach((card) => {
    card.style.display = card.dataset.screen === next ? "block" : "none";
  });
  if (next === "settings") syncSettingsWidgets();
  if (next === "controls") renderControlsList();
  if (next !== "controls") cancelRebindCapture();
}

function bindWidgets({ onOpenParty, onLeaveParty }) {
  root.querySelector("#om-resume").addEventListener("click", closeMenu);
  root.querySelector("#om-open-settings").addEventListener("click", () => showScreen("settings"));
  root.querySelector("#om-open-credits").addEventListener("click", () => showScreen("credits"));
  root.querySelector("#om-credits-back").addEventListener("click", () => showScreen("pause"));
  root.querySelector("#om-settings-back").addEventListener("click", () => showScreen("pause"));
  root.querySelector("#om-open-controls").addEventListener("click", () => showScreen("controls"));
  root.querySelector("#om-controls-back").addEventListener("click", () => showScreen("settings"));
  root.querySelector("#om-controls-reset").addEventListener("click", () => {
    if (!confirm("Reset all key bindings to their defaults?")) return;
    resetBindings();
    renderControlsList();
  });
  root.querySelector("#om-open-party").addEventListener("click", () => {
    closeMenu();
    onOpenParty?.();
  });
  root.querySelector("#om-leave-party").addEventListener("click", () => {
    if (!confirm("Leave the current party? You'll be moved to a fresh solo party.")) return;
    onLeaveParty?.();
  });

  const sfx = root.querySelector("#om-sfx");
  const sfxVal = root.querySelector("#om-sfx-val");
  const music = root.querySelector("#om-music");
  const musicVal = root.querySelector("#om-music-val");
  const muted = root.querySelector("#om-muted");
  const fps = root.querySelector("#om-fps");

  sfx.addEventListener("input", () => {
    saveSettings({ sfxVolume: parseInt(sfx.value, 10) / 100 });
    sfxVal.textContent = `${sfx.value}%`;
  });
  sfx.addEventListener("change", () => playSfx("hintReceived", { volume: 0.5 }));
  music.addEventListener("input", () => {
    saveSettings({ musicVolume: parseInt(music.value, 10) / 100 });
    musicVal.textContent = `${music.value}%`;
  });
  muted.addEventListener("change", () => saveSettings({ muted: muted.checked }));
  fps.addEventListener("change", () => saveSettings({ showFps: fps.checked }));
}

function syncSettingsWidgets() {
  const s = getSettings();
  const sfx = Math.round((s.sfxVolume ?? 0) * 100);
  const music = Math.round((s.musicVolume ?? 0) * 100);
  root.querySelector("#om-sfx").value = String(sfx);
  root.querySelector("#om-sfx-val").textContent = `${sfx}%`;
  root.querySelector("#om-music").value = String(music);
  root.querySelector("#om-music-val").textContent = `${music}%`;
  root.querySelector("#om-muted").checked = !!s.muted;
  root.querySelector("#om-fps").checked = !!s.showFps;
}

function renderControlsList() {
  const list = root.querySelector("#om-controls-list");
  if (!list) return;
  list.innerHTML = ACTIONS.map((a) => {
    const codes = codesFor(a.id);
    return `<li>
      <span class="om-controls-label">${a.label}</span>
      <button class="om-controls-key" data-action="${a.id}" data-slot="0">${formatCode(codes[0])}</button>
      <button class="om-controls-key" data-action="${a.id}" data-slot="1">${formatCode(codes[1])}</button>
    </li>`;
  }).join("");
  for (const btn of list.querySelectorAll(".om-controls-key")) {
    btn.addEventListener("click", () => beginRebindCapture(btn));
  }
}

function formatCode(code) {
  if (!code) return "—";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  return code;
}

function beginRebindCapture(btn) {
  cancelRebindCapture();
  rebindCapture = { action: btn.dataset.action, slot: parseInt(btn.dataset.slot, 10), btn };
  btn.classList.add("capturing");
  btn.textContent = "Press a key…";
  window.addEventListener("keydown", onCaptureKeydown, true);
}

function onCaptureKeydown(e) {
  if (!rebindCapture) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === "Escape") { cancelRebindCapture(); return; }
  const { action, slot } = rebindCapture;
  setBinding(action, slot, e.code);
  cancelRebindCapture();
  renderControlsList();
}

function cancelRebindCapture() {
  if (!rebindCapture) return;
  rebindCapture.btn?.classList.remove("capturing");
  rebindCapture = null;
  window.removeEventListener("keydown", onCaptureKeydown, true);
  if (screen === "controls") renderControlsList();
}

function injectStyles() {
  if (document.getElementById(STYLES_ID)) return;
  const css = `
    #online-menu .om-card {
      background: #181818;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 24px 28px;
      min-width: 320px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    }
    #online-menu h1 { margin: 0 0 16px; font-size: 18px; letter-spacing: 1px; }
    #online-menu .om-row { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
    #online-menu .om-stack { flex-direction: column; align-items: stretch; gap: 8px; }
    #online-menu label { color: #ddd; cursor: pointer; }
    #online-menu input[type="range"] { flex: 1; }
    #online-menu button {
      background: #2a2a2a; color: #eee; border: 1px solid #444;
      padding: 8px 12px; border-radius: 4px; cursor: pointer;
      font-family: inherit; text-align: left;
    }
    #online-menu button:hover { background: #353535; }
    #online-menu .om-hint { color: #888; font-size: 11px; margin: 14px 0 0; }
    #online-menu .om-version { color: #555; font-size: 10px; margin: 10px 0 0; text-align: right; }
    #online-menu .om-credits { font-size: 12px; line-height: 1.5; color: #ccc; margin: 0 0 10px; }
    #online-menu .om-credits a { color: #9ab1ff; text-decoration: none; }
    #online-menu .om-credits a:hover { text-decoration: underline; }
    #online-menu .om-controls-list { list-style: none; padding: 0; margin: 0 0 12px; min-width: 360px; }
    #online-menu .om-controls-list li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin: 4px 0; background: #1f1f1f; border: 1px solid #2e2e2e; border-radius: 3px; }
    #online-menu .om-controls-label { flex: 1; font-size: 12px; color: #ccc; }
    #online-menu .om-controls-key { min-width: 96px; text-align: center !important; font-family: monospace; font-size: 11px; padding: 4px 8px !important; }
    #online-menu .om-controls-key.capturing { background: #3a3a55; border-color: #5a5a88; color: #fff; }
  `;
  const style = document.createElement("style");
  style.id = STYLES_ID;
  style.textContent = css;
  document.head.appendChild(style);
}
