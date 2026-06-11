# ktp-foundry-bridge

Foundry VTT module (v12/v13) that connects to **ktp-hub** over
WebSocket and exposes a command registry. Lets the GM drive Foundry
from the hub's control surface and lets Foundry push events out to
other connected peers.

Published via GitHub Releases at
[`aeriondyseti/ktp-foundry-bridge`](https://github.com/aeriondyseti/ktp-foundry-bridge).
The Foundry manifest URL in `module.json` auto-resolves to the latest
release, so updates flow through Foundry's built-in module updater.

## Sibling repos

Lives in `~/Development/ktp/` alongside:

- **`../ktp-hub/`** — the WebSocket hub this module connects to.
  See `../ktp-hub/CLAUDE.md` for the wire protocol.
- **`../hexploration/`** — TTRPG hexploration tool; will also connect
  to ktp-hub as a peer.

## Layout

```
ktp-foundry-bridge/
├── module.json            — Foundry manifest, version, compat range
└── scripts/
    └── bridge.js          — entry point, command registry, WS client
```

## Built-in commands

| Command           | Params                | Effect                                          |
|-------------------|-----------------------|-------------------------------------------------|
| `show-portrait`   | `actorName`           | Opens an ImagePopout and shares to all players  |
| `execute-macro`   | `macroName`           | Runs a Foundry macro by name                    |
| `roll`            | `formula`             | Rolls dice via `new Roll(formula)`, posts result|
| `activate-scene`  | `sceneName`           | Activates a scene by name                       |
| `send-chat`       | `message`             | Posts an IC chat message                        |
| `eval`            | `code`                | Runs arbitrary JS (GM-trust only)               |
| `hex.show-area`   | —                     | Opens the Hex Map popout on this client         |

Adding a command: call `registerCommand(name, handler)` in `bridge.js`.
The handler receives the params object and may call `sendEvent(...)` to
push a `peer-event` back to the hub.

## Protocol

Speaks ktp-hub's v1.4 generalized protocol:

- Outbound (responses to commands):
  `{type: "peer-event", source: "foundry", event, requestId, ...data}`
- Inbound (commands from the hub):
  `{type: "peer-command", target: "foundry", command, requestId, ...params}`

Identifies on connect with `{type: "identify", peer: "foundry"}`.

## Hex Map window

Embeds hexploration's player view (`/explore/player/?hud=1&token=…`) in a
resizable Foundry popout so players don't need a separate browser tab.
Three ways in: the "Hex Map" button in the token scene-controls toolbar,
the `hex.show-area` peer command (hub-pushed), or `ktpBridge.openHexMap()`
from a macro. Requires both hex settings below; warns and does nothing if
either is blank. The share token is read-only by construction (see
hexploration's CLAUDE.md "Share token") so embedding it in world settings
is safe. ApplicationV2 on Foundry v13+, classic Application on v12.

## Settings (in Foundry)

- **Overlay Server WebSocket URL** — defaults to `ws://localhost:3001/ws`.
- **Hexploration base URL** — defaults to `https://ktp.dyseti.net`.
- **Hexploration share token** — read-only token for the embedded map;
  blank disables the Hex Map button. World-scoped (players need it).
- **Hexploration GM token** — read/write token; when set and the user
  is a GM, the Hex Map button opens the GM tool instead of the player
  view. **Client-scoped on purpose**: world settings sync to every
  connected client, which would hand players a write credential. Each
  GM browser sets it once.

## Release procedure

1. Update `module.json` `version`.
2. Commit + push.
3. Cut a GitHub Release; attach a `ktp-foundry-bridge.zip` of the repo
   contents (excluding `.git`).
4. Foundry users get the update on next "Check for Module Updates."

## Things to know

- **Module ID** is `ktp-foundry-bridge` — used in `game.settings.register`
  calls. Don't rename without updating Foundry world settings.
- **`globalThis.ktpBridge`** is exposed for macros: `registerCommand`,
  `sendEvent`, `reconnect`, `.connected`.
- **Reconnect** is automatic with 1s → 30s backoff on disconnect.
