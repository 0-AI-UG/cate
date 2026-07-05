# Extension System

## Overview

An extension adds panels to Cate by shipping a **web frontend**, and optionally a **local server process** for backend work. Each panel renders on the canvas like any built-in panel (zooms, clips, composites). Extensions come in two shapes:

- **Frontend-only** (default) — just static web assets. Cate serves them and the panel talks to Cate solely through the `cateHost` bridge. No process, port, token, or lifecycle to manage. Best for tools that only need the Cate API (viewers, formatters, pickers, dashboards over `cate.storage`).
- **Server-backed** — also ships a local server for full OS access (filesystem, processes, sockets, network) without a capability broker. Cate spawns **one server per extension per workspace** and points every panel's webview at it. The relationship is always **n:1** — many panels, one server — and the server handles concurrent panels: routing state and events per panel id, isolating panel-local data, and tolerating panels opening and closing independently.

Cate only standardizes how it serves/launches an extension and a small reverse API back into Cate. The built-in agent panel is server-backed and is the canonical reference.

## Distribution & Trust

- Extensions live in a dedicated `cate-extensions` repo. New ones land via PR; CI builds each into an artifact.
- Cate ships a catalog index, fetches an extension's artifact on first enable, and caches it.
- A catalog source is a URL (or local path) to an index JSON: `{ "extensions": [ { "manifest": <full ExtensionManifest>, "artifactUrl", "sha256", "description" } ] }`. For a remote index `artifactUrl` must be an absolute `https://` URL — Cate treats any URL without an `http(s)` scheme as a local filesystem path. The artifact `.tgz` has `manifest.json` at its root.
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

- **Launch** — lazy spawn on the **first** panel open for an extension in a workspace; every later panel of that extension reuses the running server. Cate injects env: `PORT` (free port), `HOST=127.0.0.1` (the server **must** bind this — see Security Hygiene), `CATE_API`, `CATE_TOKEN`, `WORKSPACE_ROOT`. Cate probes `readyPath` before loading the first webview; on timeout/exit it shows an error state with captured stderr and a Restart action.
- **Multiplexing** — every panel webview connects to the one server identified by its `cate.panel.id`. The server must handle concurrent panels: keep panel sessions isolated, route per-panel state/events by id, and treat panel open/close as routine join/leave events (no server restart). Panel-scoped resources are cleaned up on leave.
- **Remount survival** — panels remount when moved between dock zones or windows, and these unmounts must not drop server state. A server registry keyed by `(extensionId, workspace)` keeps the server alive as long as **any** panel is open; on remount the panel rejoins by id. When the **last** panel closes, start a ~30s grace timer; reopening within it rejoins the live server, expiry terminates it (SIGTERM, then SIGKILL). Webview lifecycle is decoupled from server lifecycle.
- **Crash handling** — auto-restart with backoff up to 2 attempts per 60s, then stop and surface a manual Restart.
- **Reaping** — each live server's PID is recorded in `session.json` keyed by `(extensionId, workspace)` — the same key as the server registry and grace timer above. On startup Cate kills orphans from a prior crashed session; on app quit it terminates all.

## Security Hygiene

- Servers bind `127.0.0.1` only. Cate injects `HOST=127.0.0.1` into the server's environment and the server is expected to bind that host; a server that ignores `HOST` and binds `0.0.0.0` would expose itself on the network, defeating the token gate. Honoring `HOST` (alongside `PORT`) is part of the server contract.
- Per-server random port + shared token (`CATE_TOKEN`); the server requires the token on every panel connection so other local processes/tabs can't drive it. Panels authenticate with the token and identify themselves by `cate.panel.id`.
- Tight CSP on the webview.

## Reverse API

A `cateHost` bridge injected into the webview (postMessage), plus a token-gated local HTTP/WS endpoint (`CATE_API`) for server-side context and event streams. Because one server backs many panels, panel-scoped reverse-API calls and event subscriptions carry the originating `cate.panel.id`; workspace/theme-scoped calls are shared across panels.

This is the **complete** surface today. It is intentionally small; new methods and namespaces are added only as they're implemented (and demonstrated in an example), so everything listed here works.

```
cate.version()                                 // API version (int), for feature detection
cate.panel.id                                  // this panel instance's id
cate.panel.setTitle(title)
cate.workspace.get()                           // { rootPath, branch, worktree }  (branch/worktree null for now)
cate.theme.get()                               // { id, type, app, terminal } theme tokens
cate.editor.openFile(path, { line?, column? }) // path is confined to the workspace root
cate.canvas.createPanel(type, {                // type: 'browser' | 'editor' | 'extension'
  position?, url?, filePath?,                  // filePath confined to the workspace root
  extensionId?, extensionPanelId? })           // 'extension': panelId required, id defaults to caller
cate.ui.notify(message, level?)
cate.files.onDrop(cb)                          // files dropped on this panel: [{ name, path, text, size?, truncated? }]
cate.storage.get(key) / set(key, value) / delete(key) / keys()   // JSON KV, extension-scoped, persisted to <project>/.cate
cate.storage.panel.get(key) / set(key, value)  // panel-scoped slice, keyed by cate.panel.id
cate.storage.onChange(cb)                       // fires on external edits and writes from other panels
cate.agent.open({ resume? }) => { sessionId }   // open (or resume) an agent session
cate.agent.send(sessionId, prompt) => { text, message }   // run one turn on an open session
cate.agent.dispose(sessionId)                   // tear down the live session (its file stays; reopen via resume)
cate.agent.run(prompt) => { text, message }     // one-shot sugar: open -> send -> dispose
cate.agent.cancel()                             // abort this extension's in-flight turn
```

`cateApi` scopes in the manifest declare which namespaces an extension uses; the host enforces them (default-deny) and Cate surfaces them as the extension's permissions in Settings → Extensions.

### Agent (`agent` scope)

`cate.agent` lets an extension drive Cate's bundled pi agent, using the user's configured default model and credentials. It is turn-based and session-oriented: `open` starts (or, with `resume`, reopens) a session and returns its handle, `send` runs one turn and resolves with the final assistant text plus the raw final message, `dispose` tears the live session down (pi's session file stays, so a conversation can be resumed later with nothing persisted on Cate's side), and `run` is one-shot sugar over open/send/dispose. The run is a real, visible Agent-panel-style session bound to the active window — the user can watch and interrupt it. Guardrails are deliberately minimal in v1:

- A dedicated **`agent` scope** (default-deny, shown at install) — never folded into another namespace.
- **First-use consent**: the first agent call per extension prompts the user; the grant lasts the app session.
- **One live session per extension, one turn in flight**: a concurrent turn returns `{ error: 'agent-busy' }`. This is the whole anti-runaway-loop guard for v1; token/cost budgets and rate limits are intentionally deferred.

Turns are long-lived (minutes); `send`/`run` resolve on the agent's terminal `agent_end`, so callers must not impose a short timeout.

### File drops (`files.drop` scope)

An extension that declares the **`files.drop`** scope receives files dropped onto its panel — from the OS file manager or from Cate's own file explorer. Because the panel is an isolated webview, Cate intercepts the drop on the host side, reads each file (the user's drag is the authorisation, so the extension never gets raw filesystem access), and hands the guest the content via `cate.files.onDrop(cb)`. The callback fires with an array of `{ name, path, text, size?, truncated? }`; `path` is the absolute path when resolvable (null for some OS drops) and `text` is the UTF-8 content, capped by the host (`truncated` flags an over-cap file). Extensions should also handle native webview `drop` events themselves as a fallback for windows where the host overlay isn't active.

## Persistence

`cate.storage` writes hand-editable JSON under `<project>/.cate/extensions/<extensionId>/`: a `storage.json` for the extension-scoped KV map and per-panel slices keyed by `cate.panel.id`. Cate owns the files — same model as the rest of `.cate` state (sync load, in-memory authority, debounced atomic write, chokidar external-edit watcher feeding `onChange`, corrupt-file quarantine). Both the frontend (via `cateHost`) and a server-backed extension (via `CATE_API`) read and write the same store, so it's the supported channel for sharing state across an extension's panels and its server. Values must be JSON-serializable; for anything large or binary, an extension uses its own server and filesystem access instead.
