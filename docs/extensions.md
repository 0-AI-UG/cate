# Extension System

## Overview

An extension adds panels to Cate by shipping a **web frontend**, and optionally a **local server process** for backend work. Each panel renders on the canvas like any built-in panel (zooms, clips, composites). Extensions come in two shapes:

- **Frontend-only** (default) — just static web assets. Cate serves them and the panel talks to Cate solely through the `cateHost` bridge. No process, port, token, or lifecycle to manage. Best for tools that only need the Cate API (viewers, formatters, pickers, dashboards over `cate.storage`).
- **Server-backed** — also ships a local server for full OS access (filesystem, processes, sockets, network) without a capability broker. Cate spawns **one server per extension per workspace** and points every panel's webview at it. The relationship is always **n:1** — many panels, one server — and the server handles concurrent panels: routing state and events per panel id, isolating panel-local data, and tolerating panels opening and closing independently.

Cate only standardizes how it serves/launches an extension and a small reverse API back into Cate. The built-in agent panel is server-backed and is the canonical reference.

## Distribution & Trust

- Extensions live in a dedicated `cate-extensions` repo. New ones land via PR; CI builds each into an artifact.
- Cate ships a catalog index, fetches an extension's artifact on first enable, and caches it.
- Users can also point Cate at a local folder for development/sideloading.
- No marketplace. The trust boundary is **PR review** (official) and **self-authorship** (local). Servers run unsandboxed, so reviewing an extension PR is a security review.
- Official extensions are JS/TS built in CI. Local extensions own their own runtime.

## Manifest

```json
{
  "id": "acme.example",
  "name": "Example",
  "panels": [
    { "id": "main", "label": "Example", "icon": "...", "defaultSize": { "width": 600, "height": 400 } }
  ],
  "frontend": "dist/index.html",
  "server": { "command": "node dist/server.js", "readyPath": "/health", "portEnv": "PORT" },
  "cateApi": ["workspace.read", "editor.write", "storage"]
}
```

`server` is **optional** — omit it for a frontend-only extension, where Cate serves the `frontend` entry statically and injects only the `cateHost` bridge. When `server` is present it serves the frontend itself at `PORT` and `frontend` is ignored.

## Lifecycle

Applies only to **server-backed** extensions. Frontend-only panels are plain webviews with no process, so none of the spawn/grace/crash/reaping rules apply.

- **Launch** — lazy spawn on the **first** panel open for an extension in a workspace; every later panel of that extension reuses the running server. Cate injects env: `PORT` (free port), `CATE_API`, `CATE_TOKEN`, `WORKSPACE_ROOT`. Cate probes `readyPath` before loading the first webview; on timeout/exit it shows an error state with captured stderr and a Restart action.
- **Multiplexing** — every panel webview connects to the one server identified by its `cate.panel.id`. The server must handle concurrent panels: keep panel sessions isolated, route per-panel state/events by id, and treat panel open/close as routine join/leave events (no server restart). Panel-scoped resources are cleaned up on leave.
- **Remount survival** — panels remount when moved between dock zones or windows, and these unmounts must not drop server state. A server registry keyed by `(extensionId, workspace)` keeps the server alive as long as **any** panel is open; on remount the panel rejoins by id. When the **last** panel closes, start a ~30s grace timer; reopening within it rejoins the live server, expiry terminates it (SIGTERM, then SIGKILL). Webview lifecycle is decoupled from server lifecycle.
- **Crash handling** — auto-restart with backoff up to 2 attempts per 60s, then stop and surface a manual Restart.
- **Reaping** — each live server's PID is recorded in `session.json` keyed by `(extensionId, workspace)` — the same key as the server registry and grace timer above. On startup Cate kills orphans from a prior crashed session; on app quit it terminates all.

## Security Hygiene

- Servers bind `127.0.0.1` only.
- Per-server random port + shared token (`CATE_TOKEN`); the server requires the token on every panel connection so other local processes/tabs can't drive it. Panels authenticate with the token and identify themselves by `cate.panel.id`.
- Tight CSP on the webview.

## Reverse API

A `cateHost` bridge injected into the webview (postMessage), plus a token-gated local HTTP/WS endpoint (`CATE_API`) for server-side context and event streams. Because one server backs many panels, panel-scoped reverse-API calls and event subscriptions carry the originating `cate.panel.id`; workspace/theme-scoped calls are shared across panels.

```
cate.version                                  // API version, for feature detection
cate.workspace.get() / onChange               // { rootPath, branch, worktree }
cate.theme.get() / onChange                   // theme tokens
cate.panel.id                                  // this instance's id
cate.panel.onResize / onVisibilityChange / onBeforeUnload
cate.panel.setTitle(s) / setBadge(status)
cate.editor.openFile(path, { line? })
cate.editor.getActiveFile() / getSelection() / revealInTree(path)
cate.commands.register(id, handler) / invoke(id)   // palette integration
cate.ui.notify(message, level)
cate.storage.get(key) / set(key, value) / delete(key) / keys()   // JSON KV, extension-scoped, persisted to <project>/.cate
cate.storage.panel.get(key) / set(key, value)  // panel-scoped slice, keyed by cate.panel.id
cate.storage.onChange(key)                      // fires on external edits and writes from other panels
cate.canvas.createPanel(type, { position, size, props })
cate.canvas.listPanels() / onPanelsChange
cate.canvas.movePanel(id, position)
cate.canvas.drawRegion(rect, { label }) / connect(panelA, panelB)
cate.canvas.viewport.get() / panTo(rect)
```

`cateApi` scopes in the manifest declare which namespaces an extension uses.

## Persistence

`cate.storage` writes hand-editable JSON under `<project>/.cate/extensions/<extensionId>/`: a `storage.json` for the extension-scoped KV map and per-panel slices keyed by `cate.panel.id`. Cate owns the files — same model as the rest of `.cate` state (sync load, in-memory authority, debounced atomic write, chokidar external-edit watcher feeding `onChange`, corrupt-file quarantine). Both the frontend (via `cateHost`) and a server-backed extension (via `CATE_API`) read and write the same store, so it's the supported channel for sharing state across an extension's panels and its server. Values must be JSON-serializable; for anything large or binary, an extension uses its own server and filesystem access instead.
