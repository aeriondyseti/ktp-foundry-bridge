// ── Command Registry ────────────────────────────────────────────────────────

const commands = new Map();

function registerCommand(name, handler) {
  commands.set(name, handler);
}

// ── Built-in Commands ───────────────────────────────────────────────────────

// Handlers throw on failure (handleCommand turns that into a
// `command-error` reply) and may return an object whose fields are folded
// into the `command-ok` reply — that's how a caller gets a roll total or
// eval result back over the HTTP command path.

registerCommand("show-portrait", async ({ actorName }) => {
  const name = actorName.toLowerCase();

  // Check journal pages first (NPCs journal, then all journals)
  for (const journal of game.journal) {
    const page = journal.pages.find(
      (p) => p.name.toLowerCase() === name && p.type === "image" && p.src
    );
    if (page) {
      const ip = new ImagePopout({ src: page.src, window: { title: page.name } });
      ip.render(true);
      ip.shareImage();
      return;
    }
  }

  // Fall back to actor portrait
  const actor = game.actors.find((a) => a.name.toLowerCase() === name);
  if (actor) {
    const img = actor.img || actor.prototypeToken?.texture?.src;
    if (img) {
      const ip = new ImagePopout({ src: img, window: { title: actor.name } });
      ip.render(true);
      ip.shareImage();
      return;
    }
  }

  throw new Error(`No portrait found for "${actorName}"`);
});

registerCommand("execute-macro", async ({ macroName }) => {
  const macro = game.macros.find(
    (m) => m.name.toLowerCase() === macroName.toLowerCase()
  );
  if (!macro) throw new Error(`Macro "${macroName}" not found`);
  await macro.execute();
});

registerCommand("roll", async ({ formula }) => {
  const roll = await new Roll(formula).evaluate();
  await roll.toMessage({ flavor: `Bridge Roll: ${formula}` });
  return { formula, total: roll.total };
});

registerCommand("activate-scene", async ({ sceneName }) => {
  const scene = game.scenes.find(
    (s) => s.name.toLowerCase() === sceneName.toLowerCase()
  );
  if (!scene) throw new Error(`Scene "${sceneName}" not found`);
  await scene.activate();
});

registerCommand("send-chat", async ({ message }) => {
  await ChatMessage.create({
    content: message,
    style: CONST.CHAT_MESSAGE_STYLES.IC,
  });
});

registerCommand("eval", async ({ code }) => {
  const fn = new Function("game", "canvas", "ui", "ChatMessage", "Roll", code);
  const result = await fn(game, canvas, ui, ChatMessage, Roll);
  if (result !== undefined) return { result: String(result) };
});

// Open the hexploration map window on this client. Routed from the hub
// (e.g. the GM control surface saying "everyone, look at the map") —
// each connected Foundry client that receives it pops the window locally.
registerCommand("hex.show-area", async () => {
  openHexMap();
});

// ── Hexploration Map Window ─────────────────────────────────────────────────
//
// Embeds the hexploration player view (ktp.dyseti.net) in a Foundry popout
// so players don't need a separate browser tab. The iframe URL carries
// `?hud=1&token=…` — a read-only share token that replaces the session
// cookie (third-party iframes can't carry one). See hexploration's
// ROADMAP.md "Phase 2 — Foundry as the player surface".

function hexMapUrl() {
  const base = game.settings.get("ktp-foundry-bridge", "hexBaseUrl").replace(/\/$/, "");
  if (!base) return null;
  // GM users with a gm token configured get the read/write GM tool;
  // everyone else gets the read-only player view. The gm token is a
  // CLIENT-scoped setting — world settings sync to every connected
  // client, which would hand players a write credential.
  if (game.user.isGM) {
    const gmToken = game.settings.get("ktp-foundry-bridge", "hexGmToken").trim();
    if (gmToken) return `${base}/explore/gm/?hud=1&token=${encodeURIComponent(gmToken)}`;
  }
  const token = game.settings.get("ktp-foundry-bridge", "hexShareToken").trim();
  if (!token) return null;
  return `${base}/explore/player/?hud=1&token=${encodeURIComponent(token)}`;
}

let hexMapApp = null;

function openHexMap() {
  const url = hexMapUrl();
  if (!url) {
    ui.notifications?.warn(
      "Hex map is not configured — set the hexploration URL and share token in the KTP Hub Bridge module settings."
    );
    return;
  }
  // Re-focus the existing window instead of stacking duplicates.
  if (hexMapApp?.rendered) {
    hexMapApp.bringToFront?.() ?? hexMapApp.bringToTop?.();
    return;
  }
  hexMapApp = new HexMapApplication(url);
  hexMapApp.render(true);
}

// The iframe wrapper window. ApplicationV2 on Foundry v13+, classic
// Application on v12 — same markup either way.
const HEX_MAP_CONTENT = (url) => `
  <div class="ktp-hex-map-body" style="display:flex; flex-direction:column; flex:1; min-height:0;">
    <iframe src="${url}"
            style="flex:1; width:100%; border:0; background:#1a1a1a;"
            allow="fullscreen"></iframe>
    <div style="flex:0 0 auto; padding:2px 6px; font-size:11px; opacity:0.6; text-align:right;">
      Map not loading? <a href="${url}" target="_blank" rel="noopener">Open in a browser tab</a>
    </div>
  </div>`;

const HexMapApplication = (() => {
  const AppV2 = foundry?.applications?.api?.ApplicationV2;
  if (AppV2) {
    return class HexMapAppV2 extends AppV2 {
      constructor(url) {
        super();
        this.url = url;
      }
      static DEFAULT_OPTIONS = {
        id: "ktp-hex-map",
        window: { title: "Hex Map", resizable: true },
        position: { width: 1000, height: 700 },
      };
      // No Handlebars template — we hand back a plain element.
      async _renderHTML() {
        const div = document.createElement("div");
        div.innerHTML = HEX_MAP_CONTENT(this.url);
        const el = div.firstElementChild;
        return el;
      }
      _replaceHTML(result, content) {
        content.replaceChildren(result);
        // Let the iframe fill the window's content box.
        content.style.display = "flex";
        content.style.flexDirection = "column";
      }
      _onClose(options) {
        super._onClose?.(options);
        hexMapApp = null;
      }
    };
  }
  // v12 fallback: classic Application with inline content.
  return class HexMapAppV1 extends Application {
    constructor(url) {
      super();
      this.url = url;
    }
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: "ktp-hex-map",
        title: "Hex Map",
        resizable: true,
        width: 1000,
        height: 700,
        template: null,
      });
    }
    async _renderInner() {
      return $(HEX_MAP_CONTENT(this.url));
    }
    close(options) {
      hexMapApp = null;
      return super.close(options);
    }
  };
})();

// ── WebSocket Connection ────────────────────────────────────────────────────

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function getServerUrl() {
  return game.settings.get("ktp-foundry-bridge", "overlayServerUrl");
}

function connect() {
  const url = getServerUrl();
  if (!url) return;

  cleanup();

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error("[KTP Bridge] WebSocket creation failed:", e);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    console.log("[KTP Bridge] Connected to ktp-hub");
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: "identify", peer: "foundry" }));
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "peer-command" && msg.target === "foundry") {
        handleCommand(msg);
      }
    } catch (e) {
      console.error("[KTP Bridge] Failed to parse message:", e);
    }
  });

  ws.addEventListener("close", () => {
    console.warn("[KTP Bridge] Disconnected from ktp-hub");
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // close event fires after this, triggering reconnect
  });
}

function cleanup() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`[KTP Bridge] Reconnecting in ${reconnectDelay / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}

function reconnect() {
  reconnectDelay = 1000;
  connect();
}

// ── Command Dispatch ────────────────────────────────────────────────────────

async function handleCommand(msg) {
  // `target`/`type` are routing metadata; `requestId` is echoed back so the
  // hub can match this command's reply to a waiting HTTP request. The rest
  // are the handler's params.
  const { type, target, requestId, command, ...params } = msg;
  const handler = commands.get(command);
  if (!handler) {
    console.warn(`[KTP Bridge] Unknown command: ${command}`);
    sendEvent("unknown-command", { command, requestId });
    return;
  }
  try {
    const result = await handler(params);
    sendEvent("command-ok", { command, requestId, ...(result || {}) });
  } catch (e) {
    console.error(`[KTP Bridge] Command "${command}" failed:`, e);
    sendEvent("command-error", { command, requestId, error: e.message });
  }
}

// ── Upstream Events ─────────────────────────────────────────────────────────

// Emit a peer-event to the hub. `source` identifies us; an optional
// `requestId` (present in command replies) lets the hub resolve a waiting
// HTTP command. Spontaneous events (no requestId) are just broadcast.
function sendEvent(event, data = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "peer-event", source: "foundry", event, ...data }));
}

// ── Settings & Lifecycle ────────────────────────────────────────────────────

Hooks.once("init", () => {
  // Setting key stays `overlayServerUrl` so existing worlds keep their saved
  // value across this rename; only the display text refers to ktp-hub.
  game.settings.register("ktp-foundry-bridge", "overlayServerUrl", {
    name: "ktp-hub WebSocket URL",
    hint: "WebSocket URL of the ktp-hub server (e.g. ws://localhost:3001/ws)",
    scope: "world",
    config: true,
    type: String,
    default: "ws://localhost:3001/ws",
    onChange: () => reconnect(),
  });

  game.settings.register("ktp-foundry-bridge", "hexBaseUrl", {
    name: "Hexploration base URL",
    hint: "Base URL of the hexploration server (e.g. https://ktp.dyseti.net). Used for the Hex Map window.",
    scope: "world",
    config: true,
    type: String,
    default: "https://ktp.dyseti.net",
  });

  game.settings.register("ktp-foundry-bridge", "hexShareToken", {
    name: "Hexploration share token",
    hint: "Read-only share token for the embedded player map (server's share-token.txt or HEXPLORATION_SHARE_TOKEN). Leave blank to disable the Hex Map button.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  // CLIENT scope, deliberately: world settings are synced to every
  // connected client, and this token carries write access. Client scope
  // keeps it in the GM's browser only. Each GM machine sets it once.
  game.settings.register("ktp-foundry-bridge", "hexGmToken", {
    name: "Hexploration GM token (this browser only)",
    hint: "Read/write token for the embedded GM tool (server's gm-token.txt or HEXPLORATION_GM_TOKEN). When set and you are a GM, the Hex Map button opens the GM tool instead of the player view. Stored only in this browser.",
    scope: "client",
    config: true,
    type: String,
    default: "",
  });
});

// Toolbar launcher: a "Hex Map" button under the token (default) scene
// controls. v13 passes `controls` as a record keyed by control name with
// a `tools` record; v12 passes an array with a `tools` array — handle both.
Hooks.on("getSceneControlButtons", (controls) => {
  const tool = {
    name: "ktp-hex-map",
    title: "Hex Map",
    icon: "fa-solid fa-map-location-dot",
    button: true,
    onChange: () => openHexMap(),  // v13
    onClick: () => openHexMap(),   // v12
  };
  if (Array.isArray(controls)) {
    controls.find((c) => c.name === "token")?.tools.push(tool);
  } else {
    const tools = controls.tokens?.tools;
    if (tools) tools[tool.name] = { ...tool, order: Object.keys(tools).length };
  }
});

Hooks.once("ready", () => {
  connect();
  console.log("[KTP Bridge] Module loaded");
});

// Expose for macro/module use
globalThis.ktpBridge = {
  registerCommand,
  sendEvent,
  reconnect,
  openHexMap,
  get connected() {
    return ws?.readyState === WebSocket.OPEN;
  },
};
