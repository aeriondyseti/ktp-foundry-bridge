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
