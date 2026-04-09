// ── Command Registry ────────────────────────────────────────────────────────

const commands = new Map();

function registerCommand(name, handler) {
  commands.set(name, handler);
}

// ── Built-in Commands ───────────────────────────────────────────────────────

registerCommand("show-portrait", async ({ actorName }) => {
  const actor = game.actors.find(
    (a) => a.name.toLowerCase() === actorName.toLowerCase()
  );
  if (!actor) {
    console.warn(`[KTP Bridge] Actor not found: ${actorName}`);
    sendEvent("command-error", {
      command: "show-portrait",
      error: `Actor "${actorName}" not found`,
    });
    return;
  }

  const img = actor.img || actor.prototypeToken?.texture?.src;
  if (!img) {
    console.warn(`[KTP Bridge] No portrait for: ${actorName}`);
    sendEvent("command-error", {
      command: "show-portrait",
      error: `No portrait for "${actorName}"`,
    });
    return;
  }

  const ip = new ImagePopout({
    src: img,
    window: { title: actor.name },
  });
  ip.render(true);
  ip.shareImage();
});

registerCommand("execute-macro", async ({ macroName }) => {
  const macro = game.macros.find(
    (m) => m.name.toLowerCase() === macroName.toLowerCase()
  );
  if (!macro) {
    sendEvent("command-error", {
      command: "execute-macro",
      error: `Macro "${macroName}" not found`,
    });
    return;
  }
  await macro.execute();
});

registerCommand("roll", async ({ formula }) => {
  const roll = await new Roll(formula).evaluate();
  await roll.toMessage({ flavor: `Bridge Roll: ${formula}` });
  sendEvent("roll-result", { formula, total: roll.total });
});

registerCommand("activate-scene", async ({ sceneName }) => {
  const scene = game.scenes.find(
    (s) => s.name.toLowerCase() === sceneName.toLowerCase()
  );
  if (!scene) {
    sendEvent("command-error", {
      command: "activate-scene",
      error: `Scene "${sceneName}" not found`,
    });
    return;
  }
  await scene.activate();
});

registerCommand("send-chat", async ({ message }) => {
  await ChatMessage.create({
    content: message,
    style: CONST.CHAT_MESSAGE_STYLES.IC,
  });
});

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
    console.log("[KTP Bridge] Connected to overlay server");
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: "identify", client: "foundry" }));
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "foundry-command") {
        handleCommand(msg);
      }
    } catch (e) {
      console.error("[KTP Bridge] Failed to parse message:", e);
    }
  });

  ws.addEventListener("close", () => {
    console.warn("[KTP Bridge] Disconnected from overlay server");
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
  const { type, command, ...params } = msg;
  const handler = commands.get(command);
  if (!handler) {
    console.warn(`[KTP Bridge] Unknown command: ${command}`);
    sendEvent("unknown-command", { command });
    return;
  }
  try {
    await handler(params);
    sendEvent("command-ok", { command });
  } catch (e) {
    console.error(`[KTP Bridge] Command "${command}" failed:`, e);
    sendEvent("command-error", { command, error: e.message });
  }
}

// ── Upstream Events ─────────────────────────────────────────────────────────

function sendEvent(event, data = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "foundry-event", event, ...data }));
}

// ── Settings & Lifecycle ────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register("ktp-foundry-bridge", "overlayServerUrl", {
    name: "Overlay Server WebSocket URL",
    hint: "WebSocket URL of the KTP overlay server (e.g. ws://localhost:3001/ws)",
    scope: "world",
    config: true,
    type: String,
    default: "ws://localhost:3001/ws",
    onChange: () => reconnect(),
  });
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
  get connected() {
    return ws?.readyState === WebSocket.OPEN;
  },
};
