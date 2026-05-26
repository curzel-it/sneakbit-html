// HP bar for online mode. Reads `hp` / `hpMax` off the local mirror player
// (session.self) each frame. Lives in the DOM, not the canvas, per the
// project UI rule.
//
// Offline's `client/healthHud.js` subscribes to onPlayerHealthChange — that
// fires when the per-index records in shared/playerHealth.js change. Online
// has no per-index records on the client side: HP lives on the mirror
// player updated by deltas, so the loop polls each frame. Cheap; render
// only mutates the bar when the value changes.

let root = null;
let label = null;
let fill = null;
let lastWidth = -1;
let lastText = "";

const COLOR = "linear-gradient(90deg, #b13 0%, #e54 100%)";

export function installOnlineHealthHud() {
  if (root) return root;
  root = document.createElement("div");
  root.id = "online-health-hud";
  Object.assign(root.style, {
    position: "fixed",
    top: "12px",
    left: "12px",
    width: "180px",
    padding: "6px 10px",
    background: "rgba(10, 10, 10, 0.7)",
    border: "1px solid #333",
    borderRadius: "6px",
    color: "#eee",
    fontFamily: "monospace",
    fontSize: "12px",
    zIndex: "11",
    pointerEvents: "none",
    userSelect: "none",
    WebkitUserSelect: "none",
  });

  label = document.createElement("div");
  label.style.marginBottom = "4px";

  const bar = document.createElement("div");
  Object.assign(bar.style, {
    width: "100%",
    height: "8px",
    background: "#222",
    border: "1px solid #444",
    borderRadius: "3px",
    overflow: "hidden",
  });

  fill = document.createElement("div");
  Object.assign(fill.style, {
    width: "100%",
    height: "100%",
    background: COLOR,
    transition: "width 120ms linear",
  });
  bar.appendChild(fill);
  root.appendChild(label);
  root.appendChild(bar);
  document.body.appendChild(root);
  return root;
}

export function updateOnlineHealthHud(self) {
  if (!root) return;
  if (!self || typeof self.hp !== "number" || typeof self.hpMax !== "number") {
    if (root.style.display !== "none") root.style.display = "none";
    return;
  }
  if (root.style.display === "none") root.style.display = "";
  const max = Math.max(1, self.hpMax);
  const hp = Math.max(0, Math.min(max, self.hp));
  const pct = (hp / max) * 100;
  const text = `HP ${Math.ceil(hp)} / ${max}`;
  if (text !== lastText) {
    label.textContent = text;
    lastText = text;
  }
  if (pct !== lastWidth) {
    fill.style.width = `${pct}%`;
    lastWidth = pct;
  }
}
