---
name: cate-extension
description: Build, test, and publish a Cate extension, a web panel (optionally backed by a local server) that runs on Cate's canvas. Use when the user wants to create or scaffold a Cate extension, add a panel to Cate, work with the extension manifest, cateApi scopes, or the window.cate host API, or submit an extension to the cate-extensions catalog.
user-invocable: true
---

# Authoring Cate Extensions

A Cate extension adds panels to Cate's infinite canvas by shipping a **web
frontend**, optionally plus a **local server process**. Panels render in
isolated webviews and talk to Cate only through the injected `window.cate`
bridge, gated by manifest-declared scopes.

Two shapes:

- **Frontend-only** (default): static web assets. Cate serves them and injects
  the `cate` bridge. No process, port, token, or lifecycle. Best for viewers,
  editors, formatters, dashboards over `cate.storage`.
- **Server-backed**: also ships a local server for full OS access (filesystem,
  processes, network). Cate spawns **one server per extension per workspace**;
  every panel webview of that extension connects to it (n:1).

Official extensions live in the catalog repo
**github.com/0-AI-UG/cate-extensions** (one folder per extension under
`extensions/<id>/`). The Cate repo carries an in-tree mirror at
`cate-extensions/` for offline dev and tests. When working inside either repo,
read a shipped extension as a live reference: `cate.mermaid` (frontend-only),
`cate.usage` (server-backed), `cate.frontendkit` / `cate.kitchensink`
(dev-only reference apps, not published).

## Creating a new extension: where to start

Two starting points; decide before scaffolding:

- **Clone the catalog repo** and scaffold at `extensions/<id>/` when the
  extension might be published later, should use the shared UI kit, or is more
  than a small one-off. The kit ships only by file copy inside that repo
  (there is no npm package), and starting there gives you `./build.sh`
  validation and the PR flow with no later migration.

  ```bash
  git clone git@github.com:0-AI-UG/cate-extensions.git
  ```

- **Scaffold inline in the current workspace** (any folder holding a
  `manifest.json`) for small, private, workspace-local tools. No kit: theme by
  hand from `cate.theme.get()`. If it outgrows this, move the folder into a
  catalog-repo clone and adopt the kit then.

Either way, the day-to-day loop is sideloading (see Local development loop);
the catalog repo additionally supports the local `file://` catalog flow.

## Project anatomy

Minimal frontend-only extension (build tool optional; plain static files work):

```
extensions/acme.example/
  manifest.json          # required, see below
  README.md              # first line becomes the catalog description fallback
  package.json           # only if it needs a build: must expose "build" script
  index.html             # or src/ + vite build -> dist/index.html
  src/
    main.ts
    _kit/                # synced copy of the shared UI kit (never edit; see Kit)
    cate-host.d.ts       # typings for window.cate
```

Packaging rule (`build.sh` in the catalog repo): if the extension directory
contains a `package.json` with a `build` script, CI runs `npm install` +
`npm run build`; if a `dist/` exists after that, the published artifact ships
**only `manifest.json` + `dist/`**, otherwise the whole folder. `manifest.json`
is always at the artifact root.

## Manifest (`manifest.json`)

```json
{
  "id": "acme.example",
  "name": "Example",
  "version": "1.0.0",
  "category": "development",
  "description": "One-line catalog description.",
  "frontend": "dist/index.html",
  "panels": [
    { "id": "main", "label": "Example", "icon": "<svg …>…</svg>",
      "defaultSize": { "width": 600, "height": 400 } }
  ],
  "server": { "command": "node dist/server.js", "readyPath": "/health", "portEnv": "PORT" },
  "cateApi": ["storage", "theme"]
}
```

| Field | Rules |
| --- | --- |
| `id` | Required. Must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` (it becomes a filesystem path). Convention: `publisher.name`, e.g. `cate.mermaid`. Invalid id rejects the whole manifest. |
| `name` | Display name; falls back to `id`. |
| `version` | SemVer-ish, must match `^[A-Za-z0-9][A-Za-z0-9.+_-]*$` or it is silently dropped (treated as `0.0.0`). The artifact is `<id>-<version>.tgz`; **bump it for every published change**. |
| `category` | Functional group the catalog filters by: `ai`, `development`, `data`, `design`, `productivity`, `communication`, `sales`, `other`. Pick by what the extension is *for*, not how it is built. Missing or unknown files it under **Other**; the catalog build rejects an unknown value. |
| `panels` | Required, non-empty. Every panel needs non-empty `id` and `label` or the whole manifest is rejected. `icon` is an inline SVG string. `defaultSize` needs both numbers. |
| `frontend` | Entry HTML for frontend-only extensions. Ignored when `server` is present (the server serves its own frontend). |
| `server` | Optional; makes the extension server-backed. `command` required; `readyPath` defaults to `/health`, `portEnv` to `PORT`. |
| `cateApi` | Scopes the extension uses (see next section). |
| `description` | Optional; wins over the README first line in the catalog. |
| `dev` | `true` excludes the extension from the published catalog (still built; for reference apps). |

## Scopes (`cateApi`)

Host-enforced, **default-deny**: any `cate.*` call outside the declared scopes
returns `{ error: 'scope-denied' }`. A bare namespace grants its sub-scopes
(`editor` grants `editor.read` + `editor.write`). Declare the minimum; scopes
are shown to the user as the extension's permissions.

| Scope | Unlocks |
| --- | --- |
| (none) | `cate.version`, `cate.panel.id`, `cate.panel.setTitle` |
| `workspace.read` | `cate.workspace.get()` |
| `theme` | `cate.theme.get()` |
| `ui` | `cate.ui.notify()` |
| `editor.read` | `cate.editor.*` except `openFile` |
| `editor.write` | `cate.editor.openFile()` |
| `storage` | `cate.storage.*` |
| `canvas` | `cate.canvas.createPanel()` |
| `panel` | `cate.panel.list()` / `focus()` / `close()` (steer panels beyond your own) |
| `files.drop` | `cate.files.onDrop()` |
| `agent` | `cate.agent.*` (plus first-use user consent per app session; one run at a time per extension, concurrent runs get `{ error: 'agent-busy' }`) |
| `browser` | `cate.browser.*` (plus first-use user consent per app session; acts on the user's real logged-in browser session) |

There is no `terminal` scope for extensions: `cate.terminal.*` (read a terminal
panel's screen, send keystrokes) serves the first-party `cate` CLI only and
returns `{ error: 'terminal-first-party-only' }` for extension callers.

## Host API (`window.cate`)

The complete surface today. Canonical typings: `src/shared/cate-host-api.d.ts`
in the Cate repo, mirrored as `kit/cate-host.d.ts` in the catalog repo and
synced into each extension's `src/_kit/`. Trust the `.d.ts` over any prose docs.

```ts
cate.version(): Promise<number>                    // API version int, feature detection
cate.panel.id: string                              // this panel instance's id (readonly)
cate.panel.setTitle(title: string): Promise<void>
cate.panel.list() => [{ panelId, type, title, focused, filePath?, url? }]  // panels across windows
cate.panel.focus(panelId)                          // reveal/focus a panel
cate.panel.close(panelId)                          // close without revealing first

cate.workspace.get(): Promise<{ rootPath, branch, worktree }>   // branch/worktree may be null
cate.theme.get(): Promise<{ id, type: 'dark'|'light', app, terminal }>

cate.editor.openFile(path, { line?, column? })     // path confined to workspace root
cate.canvas.createPanel(type, {                    // type: 'browser' | 'editor' | 'extension'
  position?: { x, y },                             // omit to follow the user's placement setting
  url?, filePath?,                                 // filePath confined to workspace root
  extensionId?, extensionPanelId? })               // 'extension': panelId required, id defaults to caller
cate.ui.notify(message, level?: 'info'|'warn'|'error')

cate.files.onDrop(cb): () => void                  // cb([{ name, path, text, size?, truncated? }])
                                                   // host reads the files; path may be null (OS drops);
                                                   // text is UTF-8, capped (truncated flags over-cap)

cate.storage.get/set/delete/keys                   // extension-scoped JSON KV
cate.storage.panel.get/set                         // panel-scoped slice, keyed by cate.panel.id
cate.storage.onChange(cb): () => void              // external edits + writes from other panels

cate.agent.open({ resume? }) => { sessionId } | { error }
cate.agent.send(sessionId, prompt) => { text, message } | { error }
cate.agent.dispose(sessionId)                      // no one-shot run: compose open -> send -> dispose
cate.agent.cancel()                                // abort this extension's in-flight turn

cate.browser.open({ url, panelId? }) => { panelId, url }   // point a panel at url (or open one)
cate.browser.reload({ panelId? }) => { ok: true }
cate.browser.screenshot({ panelId? }) => { path }  // host filesystem path (OS temp dir)
cate.browser.snapshot({ panelId? }) => { url, title, refs: [{ ref, role, name, value? }] }
cate.browser.click({ ref, panelId? }) => { ok: true }      // ref from a recent snapshot
cate.browser.type({ ref, text, panelId? }) => { ok: true }
cate.browser.wait({ panelId?, timeoutMs? }) => { url, title, loading: false }  // load settled (cap 8s)
cate.browser.press({ key, ref?, panelId? }) => { ok: true }   // TRUSTED key input (Enter submits)
```

Agent turns are long-lived (minutes); they resolve on the agent's terminal
`agent_end`. Do not wrap them in short timeouts.

`cate.storage` persists as hand-editable JSON under
`<project>/.cate/extensions/<extensionId>/`. Frontend and server share the same
store, so it is the supported channel for cross-panel and panel-to-server
state. JSON-serializable values only; anything large or binary belongs in a
server-backed extension's own filesystem.

## UI kit and theming

The catalog repo ships a shared kit at `kit/` so extensions look native to
Cate:

- `cate-kit.css`: design tokens (`--cate-*`) + component classes (`cate-*`) for
  app shell, buttons, inputs, cards, banners, drawer, empty state, spinner.
- `theme.ts`: `initTheme()` / `applyTheme()`, maps `cate.theme.get()` onto the
  tokens (declare the `theme` scope).
- `service-connection.ts`: `ServiceConnection`, a state-machine widget
  (idle / provisioning / connecting / needs-connection / ready / error) that
  gates the panel behind a connection card. Use it for extensions wrapping a
  bring-your-own external service.
- `server/http.ts`: Node HTTP scaffolding for server-backed extensions.
- `api-client.ts`: `proxyBasePath()` / `apiFetch()` for panel-to-server calls
  through Cate's proxy (the webview never holds the token; fetch relative
  paths and the proxy injects the bearer token).

There is no monorepo: the kit is **copied** into consumers at `src/_kit/` by
`node scripts/sync-kit.mjs`, and the copies are committed. To adopt it, add
your extension id to `KIT_CONSUMERS` (and `SERVER_CONSUMERS` if server-backed)
in `scripts/sync-kit.mjs`, run the sync, and never edit `src/_kit/` directly
(CI runs `sync-kit.mjs --check` and fails on stale copies).

## Server-backed contract

Only relevant when the manifest has `server`. Cate injects env on spawn:

- `PORT`: free port to listen on. `HOST=127.0.0.1`: the server **must** bind
  this, never `0.0.0.0` (a wider bind exposes it on the network and defeats
  the token gate).
- `CATE_TOKEN`: shared secret; require it on every panel connection.
- `CATE_API`: token-gated local HTTP/WS endpoint for server-side reverse-API
  calls and event streams.
- `WORKSPACE_ROOT`: the workspace the server belongs to.

Lifecycle: lazy spawn on first panel open per `(extensionId, workspace)`; Cate
probes `readyPath` before loading the webview (timeout/exit shows captured
stderr + Restart). Many panels share the one server: route state and events by
`cate.panel.id`, treat panel open/close as join/leave, and survive panel
remounts (dock moves) without dropping state. When the last panel closes there
is a ~30s grace window, then SIGTERM/SIGKILL. Crashes auto-restart with backoff
(2 attempts per 60s), then require a manual restart.

## Local development loop

Two ways to run an in-progress extension, both from Settings -> Extensions:

1. **Sideload a folder** (fastest): "Add local folder…" pointing at the
   extension directory (the one containing `manifest.json`; build first if it
   needs `dist/`). On a local workspace the folder is served in place, so
   frontend edits only need a rebuild + panel reload. On a remote workspace it
   is re-uploaded on every re-provision.
2. **Local catalog**: in a checkout of the catalog repo run `./build.sh` (with
   `CATALOG_BASE_URL` unset it writes `dist/catalog/index.json` with `file://`
   artifact URLs), then add the absolute path to that `index.json` as a
   catalog source. Local catalog entries always re-provision on panel open, so
   edits land without version bumps.

Write tests where logic allows (vitest is the convention; see `cate.mermaid`'s
`src/*.test.ts`), and give the extension a `typecheck` script against the kit
typings.

## Publishing to the catalog

The trust boundary is PR review; merging to `main` publishes automatically.

1. Fork/clone `github.com/0-AI-UG/cate-extensions` and add
   `extensions/<your-id>/` (move the folder in, if it was scaffolded inline in
   a workspace) with `manifest.json` and a `README.md` whose first line is a
   good one-line description (used by the catalog when the manifest has no
   `description`).
2. If using the kit, add the id to the consumer lists in
   `scripts/sync-kit.mjs` and commit the synced `src/_kit/`.
3. Verify locally: `./build.sh` must succeed end to end (it builds every
   extension, tars artifacts, and generates the index).
4. Open a PR. CI runs `./build.sh` to validate. Expect the review to be a
   security review: servers run unsandboxed on user machines.
5. On merge, CI rebuilds with `CATALOG_BASE_URL` pointing at the rolling
   `catalog` GitHub Release and uploads `index.json` plus every
   `<id>-<version>.tgz` as release assets. Users get it from the default
   catalog source `https://github.com/0-AI-UG/cate-extensions/releases/download/catalog/index.json`.

For updates: bump `version` in both `manifest.json` and `package.json`, since
the artifact name embeds it and installed copies are keyed by it.

## Pre-submit checklist

- `id` matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`; `panels` non-empty, each with
  `id` + `label`.
- `cateApi` is minimal; no bare namespace when one sub-scope suffices.
- Frontend degrades gracefully when a call returns `{ error: 'scope-denied' }`
  or `undefined` (older hosts); gate features on `cate.version()`.
- Theme scope declared and `initTheme()` wired, so the panel matches light and
  dark themes.
- Server (if any): binds `HOST`, honors `PORT`, rejects connections without
  `CATE_TOKEN`, routes per-panel state by `cate.panel.id`, and tolerates
  panels joining/leaving without restarting.
- `files.drop` users also handle native webview `drop` events as a fallback
  for windows where the host overlay is not active.
- `./build.sh` passes; artifact contains `manifest.json` at the root.
- README first line reads well as a catalog description.
