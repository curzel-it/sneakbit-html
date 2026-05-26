// HTML party panel — online-mode only. Lives outside the canvas so the
// inputs are real DOM widgets, not painted text. Toggled by a small
// floating button in the top-right; once open it shows the party code,
// member list, an input for joining another party, and a leave button.
//
// The panel is created on demand by online.js; offline mode never
// imports this module. Callers hand in two callbacks (onJoin / onLeave)
// — the panel knows nothing about the WebSocket.

const STYLES = `
  #party-toggle {
    position: fixed; top: 12px; right: 12px;
    z-index: 25;
    padding: 6px 10px;
    background: rgba(0,0,0,0.6); color: #eee;
    border: 1px solid #555; border-radius: 4px;
    font-family: monospace; font-size: 14px;
    cursor: pointer;
  }
  #party-toggle:hover { background: rgba(60,60,60,0.85); }
  #party-panel {
    position: fixed; top: 0; right: 0; bottom: 0;
    width: 320px;
    z-index: 30;
    background: rgba(20,20,20,0.95); color: #eee;
    border-left: 1px solid #555;
    padding: 16px;
    font-family: monospace;
    transform: translateX(100%);
    transition: transform 180ms ease;
    overflow-y: auto;
  }
  #party-panel.open { transform: translateX(0); }
  #party-panel h2 { margin: 0 0 12px; font-size: 16px; }
  #party-panel .party-row { margin-bottom: 14px; }
  #party-panel .party-code {
    display: inline-block;
    padding: 4px 8px;
    background: #2a2a2a; border: 1px solid #555;
    font-size: 18px; letter-spacing: 2px;
    margin-right: 8px;
  }
  #party-panel .party-members {
    list-style: none; padding: 0; margin: 0;
  }
  #party-panel .party-members li {
    padding: 4px 0;
    border-bottom: 1px solid #333;
  }
  #party-panel .party-members li.self { color: #6cf; }
  #party-panel input[type="text"] {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    background: #1a1a1a; color: #eee;
    border: 1px solid #555; border-radius: 3px;
    font-family: monospace; font-size: 14px;
    text-transform: uppercase;
  }
  #party-panel button {
    padding: 6px 10px;
    background: #333; color: #eee;
    border: 1px solid #555; border-radius: 3px;
    cursor: pointer;
    font-family: monospace; font-size: 13px;
    margin-top: 8px;
  }
  #party-panel button:hover { background: #444; }
  #party-panel .party-close {
    position: absolute; top: 8px; right: 12px;
    background: transparent; border: none;
    color: #999; font-size: 20px;
    cursor: pointer; padding: 4px 8px;
  }
  #party-panel .party-hint {
    font-size: 12px; color: #999; margin-top: 6px;
  }
`;

export function installPartyPanel({ onJoin, onLeave }) {
  if (document.getElementById("party-panel")) {
    return document.getElementById("party-panel");
  }
  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.appendChild(style);

  const toggle = document.createElement("button");
  toggle.id = "party-toggle";
  toggle.textContent = "Party ▸";
  document.body.appendChild(toggle);

  const panel = document.createElement("div");
  panel.id = "party-panel";
  panel.innerHTML = `
    <button class="party-close" aria-label="Close">×</button>
    <h2>Party</h2>
    <div class="party-row">
      <div>Your code:</div>
      <span class="party-code" id="party-code">—</span>
    </div>
    <div class="party-row">
      <div>Members:</div>
      <ul class="party-members" id="party-members"></ul>
    </div>
    <div class="party-row">
      <div>Join another party:</div>
      <input type="text" id="party-join-input" maxlength="5" placeholder="ABCDE" autocomplete="off" />
      <button id="party-join-btn">Join</button>
      <div class="party-hint">5-character code, case insensitive.</div>
    </div>
    <div class="party-row">
      <button id="party-leave-btn">Leave party</button>
      <div class="party-hint">Returns you to a solo party-of-one.</div>
    </div>
  `;
  document.body.appendChild(panel);

  function close() { panel.classList.remove("open"); toggle.textContent = "Party ▸"; }
  function openPanel() { panel.classList.add("open"); toggle.textContent = "Party ◂"; }
  function isOpen() { return panel.classList.contains("open"); }

  toggle.addEventListener("click", () => (isOpen() ? close() : openPanel()));
  panel.querySelector(".party-close").addEventListener("click", close);

  // Expose imperative open/close so the pause menu's "Party…" entry can
  // surface the same panel without having to know about the DOM ids.
  panel.__open = openPanel;
  panel.__close = close;

  const input = panel.querySelector("#party-join-input");
  const joinBtn = panel.querySelector("#party-join-btn");
  const submit = () => {
    const code = input.value.trim().toUpperCase();
    if (code.length === 0) return;
    onJoin?.(code);
    input.value = "";
  };
  joinBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });

  panel.querySelector("#party-leave-btn").addEventListener("click", () => onLeave?.());

  return panel;
}

export function openPartyPanel(panel) {
  panel?.__open?.();
}

export function updatePartyPanel(panel, party) {
  if (!panel || !party) return;
  const codeEl = panel.querySelector("#party-code");
  if (codeEl) codeEl.textContent = party.code ?? "—";
  const list = panel.querySelector("#party-members");
  if (!list) return;
  list.innerHTML = "";
  for (const m of party.members ?? []) {
    const li = document.createElement("li");
    li.textContent = m.name + (m.self ? " (you)" : "");
    if (m.self) li.classList.add("self");
    list.appendChild(li);
  }
}
