# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Before You Code

Read and follow the **karpathy-guidelines** skill (`.claude/skills/karpathy-guidelines`) when writing, reviewing, or refactoring code here — surface assumptions, make surgical changes, keep it simple, and define verifiable success criteria.

## Project Overview

Cate is a desktop application that provides an infinite zoomable canvas where
terminal, editor, browser, chat and review panels float spatially (similar to
Figma/Miro, but for coding), next to classic docked layouts. Built with
Electron + React + TypeScript, styled with Tailwind CSS.

Each open workspace is served by its own **runtime daemon**, which holds the
workspace's state and does all its work (files, git, terminals, agents, T3,
the `cate` API). The desktop app is a client of those runtimes; other devices
(and later a phone) connect to the same runtime after pairing, and every
client sees one live workspace.

`docs/architecture.md` is the model: what every module is, where it lives,
what it owns and how the pieces talk. Read the sections for the area you touch
before changing it. Where the code disagrees with the document, the document
wins.

## Build System

The Electron app lives at the project root. It uses **electron-vite** for the
desktop shell and **esbuild** for the daemon and the CLI.

```bash
npm install              # install dependencies (patches T3)
npm run dev              # bundle the daemon, then start the app with hot reload
npm run build            # production build of the desktop shell
npm run build:runtime    # bundle the daemon to dist-runtime/runtime.cjs
npm run runtime:tarball  # build the runtime tarball (daemon, Node, cate CLI, T3, skills)
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run lint:deps        # dependency-cruiser: layer, side and entry rules
npm test                 # vitest suite
npm run test:e2e         # playwright e2e suite (e2e/)
```

Tests use **Vitest** and live alongside the code they cover (`*.test.ts` runs
in node, `*.test.tsx` in jsdom). A few git-touching tests assume a clean
working repo and may fail when the dev tree has a branch named `main` or local
modifications: those failures are environmental, not regressions.

The daemon is a detached process that outlives the app. The app installs the
runtime tarball of its version into `~/.cate/runtime/<version>/` once (in a
checkout, the one `npm run runtime:tarball` left in `dist-runtime/`) and
starts workspaces from there. To iterate on runtime-side code, run the app
with `CATE_RUNTIME_BUNDLE=dist-runtime/runtime.cjs` (it then starts the daemon
from that bundle with your `node`), rebuild with `npm run build:runtime`, and
stop the running workspace runtime so the next open starts the new build.

## Dependencies

Managed via npm (`package.json`):
- **Electron**: desktop shell (Chromium + Node.js)
- **React 18** + **react-dom**: UI
- **xterm.js** (`@xterm/xterm`): terminal view; `@xterm/headless` + serialize addon keep each PTY's screen in the runtime
- **node-pty**: PTYs (runtime)
- **Monaco Editor** + **yjs** / **y-monaco**: editor, one shared Yjs buffer per open file
- **zustand**: client-side stores
- **@parcel/watcher**: workspace file watching; **chokidar**: state-file external-edit watching
- **simple-git**: git operations
- **@noble/curves**, **@noble/ciphers**, **@noble/hashes**: the Noise handshake for network connections
- **ws**, **bonjour-service**, **node-datachannel**: same-network WebSocket, mDNS, WebRTC (Cate Connect)
- **lucide-react** / **@phosphor-icons/react**: icons
- **electron-updater**: auto-update (GitHub Releases)

## Architecture

### Processes

- **Runtime daemon** (`src/runtime/daemon/`), one per workspace, on the
  machine that holds the workspace. The same program (`runtime.cjs`, installed
  under `~/.cate/runtime/<version>/`) runs on every machine. It serves the
  workspace over a local socket (`~/.cate/workspaces/<runtimeId>/runtime.sock`,
  which is also the one-daemon-per-workspace lock) and, with network access
  on, over the same network or Cate Connect, always inside a Noise handshake
  with pinned keys; only paired devices connect.
- **Desktop shell** (`src/shells/desktop/`):
  - `main/`: Electron main: windows, menus, native dialogs, updater (and
    installing the bundled runtime tarball), device files, the raw sockets
    for the client's transports (finding and starting local runtimes),
    webview partitions and the loopback web proxy, passkeys, capture, drag
    ghost.
  - `preload/`: `window.cateDesktop` (typed by `DesktopApi` in
    `shells/desktop/contract`). Desktop IPC only; no workspace work crosses
    it. Each preload entry must bundle self-contained (a test enforces it).
  - `renderer/`: mounts the portable client, installs the desktop
    `ClientUi` and ports, imports every panel's `view/` entry.
- **CLI** (`src/cli/`): the `cate` command in terminals the runtime spawns.

The client talks to a runtime only through the runtime protocol
(`kernel/rpc`): typed capabilities declared once with `defineCapability`, and
session channels for panels. There is no per-feature IPC.

### Layers and sides

`src/` is organised by **layer**, lowest first:

- `kernel/`: rpc, api, settings, lifecycle, state, log, ui (generic machinery)
- `runtime/`: daemon, data, transports, security, pairing, connect, server, tunnel, power
- `workspace/`: document, lifecycle (trust), canvas, files, repository, skills, relations
- `services/`: terminal, browser, t3, agents
- `client/`: connections, workspaces, document mirror, host, layout (dock, canvas, drag, windows), ui
- `panels/`: framework + terminal, editor, browser, chat, review, canvas, surface
- `shells/`: desktop
- plus `cli/`, `shared/` (generic pure utilities) and `test/` (test support)

and by **side** inside each module:

```
<module>/
  contract.ts   pure: types, pure logic; re-exports contract/
  contract/     capability.ts (defineCapability), api.ts (cate API specs),
                settings.ts (settings slice), other pure files
  runtime/      daemon side
  node/         Node code shared by the daemon and the desktop shell
  client/       portable client: no React, no DOM, no Node, no Electron
  ui/           React pieces that are not a panel view
  desktop/      desktop-shell-only pieces
```

Rules (enforced by `npm run lint:deps`, `.dependency-cruiser.cjs`):
- Contracts are pure (no Electron, Node built-ins, React, DOM or I/O) and
  import only contracts.
- `runtime/` imports contracts, `runtime/` and `node/`; `client/` and `ui/`
  import contracts, `client/` and `ui/`; `desktop/` and the desktop shell
  never import a `runtime/` side.
- A module imports only its own layer or lower. A lower layer that needs a
  higher one owns a slot the higher one fills (`runtimeFor` in `kernel/rpc`
  filled by `client/connections`; `registerPanelView` and
  `registerPanelCloseGuard` in `client/host` filled by each panel's view).
- Across modules, import a contract or a side's `index.ts`, never internals.
  `src/panels/{definitions,runtime,api}.ts` are public entries too.
- The daemon's composition root (`src/runtime/daemon/entry.ts`, `main.ts`,
  `compose/`) builds and wires every module's runtime side and is the only
  code exempt from these rules. Runtime sides export factories taking an
  explicit deps object (`createFilesRuntime(deps)`) and a
  `<name>CapabilityImpl`; no globals or singletons.

Path aliases: `@kernel/*`, `@runtime/*`, `@workspace/*`, `@services/*`,
`@client/*`, `@panels/*`, `@shells/*`.

Never branch on local versus remote, on desktop versus another client, or on
a panel type in generic code. Clients differ only by declared **client
features** (`webview`, `pageDriver`, `passkeys`, `windows`, `canvas`,
`fileDrop`, `osFiles`, `osNotifications`, `screenCapture`, `clipboard`,
`camera`); code asks `clientHas(feature)`.

### Panels

Each panel type is one folder, `src/panels/<type>/`:
- `definition.ts`: pure `definePanel({...})`: label, icon name, sizes,
  flags, the client features its view `requires`, record fields, the session
  channel schema, its API spec, `create(options, kit)`, and the hooks generic
  code asks instead of branching on the type (`checkoutPath`, `ownsKeyboard`,
  `claimsShortcuts`, `commands`, `describe`, `chrome`, `relation`).
- `contract.ts` / `contract/`: snapshot and op types, `contract/api.ts`.
- `session.ts`: the runtime session (`PanelSession` subclass): all
  behaviour, snapshot, typed op handlers, its `cate` API handlers; persists
  to `sessions/<panelId>.json`. Never asks the user: an op that would lose
  work without an explicit choice fails with `dirty`.
- `runtime.ts`: what the daemon needs to register the type.
- `view/`: the React view. `view/index.ts` calls `registerPanelView` (and
  `registerPanelCloseGuard` where closing can lose work). Views render the
  snapshot, send ops, and ask the user through `ClientUi` before destructive
  ops. The terminal view reads bytes from `process.attach` and the editor view
  its Yjs buffer from `file.buffer`; session channels carry JSON only.
- `parts/`: supporting modules, split by side.

The panel index files: `src/panels/definitions.ts` (`PANEL_DEFINITIONS`),
`src/panels/runtime.ts` (`PANEL_RUNTIMES`, read by the composition root) and
`src/panels/api.ts` (`CATE_API`). Adding a type = its folder, its name in
`PANEL_TYPES` (`workspace/document/contract`), an entry in each index file
that applies, and its `view/` import in the shell
(`shells/desktop/renderer/registrations.tsx`). Create panels with
`createPanel(workspaceId, type, options)` from `@client/host`; close them with
`closePanels`, which runs the close guards and sends one `removePanels` op.

### State

Every piece of state is in exactly one class (`docs/architecture.md` section 5):
- **Document** (runtime, shared): panel records, windows and dock trees,
  canvases and nodes, relations, worktree metadata. Changed only by document
  ops (`workspace/document/contract`); clients hold an optimistic mirror
  (`client/document`: `documentStoreFor(workspaceId)`, `useDocument`).
- **Session** (runtime, per panel): terminal screen, editor buffer, browser
  tabs, chat binding, review state.
- **Workspace data** (runtime): workspace settings, secrets, trust, grants,
  pairings, T3 state, browser data, skill sources.
- **Device** (one client device): client settings, workspace list, known
  runtimes, device key, main window bounds, through the `DeviceStore` port.
- **Client** (in memory): viewport, zoom, active tab, focus, selection, undo
  (`createClientStateStore`, `useClientState`).

Settings: each module declares a slice with `defineSettings` in
`contract/settings.ts`, scope `client` (device `settings.json`) or `workspace`
(the workspace's `settings.json`, served by the `settings` capability).

Persisted state is hand-editable JSON written through `kernel/state`
(in-memory authority, debounced atomic write, external-edit watcher,
corrupt-file quarantine); every file has one writer process.
- Workspace data: `~/.cate/workspaces/<runtimeId>/` on the runtime's machine
  (`document.json`, `sessions/`, `buffers/`, `settings.json`, `secrets.json`,
  `pairings.json`, `trust.json`, `grants.json`, `skills/`, `browser/`, `t3/`,
  `agents/`, `terminal-logs/`, `screenshots/`, `logs/`).
- Project `<root>/.cate/`: only `skills.json`, `drafts/`, `worktrees/` and its
  `.gitignore`.
- Device (Electron `userData`): `settings.json`, `ui-state.json`, `boot.json`,
  `workspaces.json`, `known-runtimes.json`, `device-key.json`, ...

Agent CLIs keep their own logins in their own files; Cate writes only
repo-local agent files, never user-global ones.

### The `cate` API and CLI

Everything outside the UI that drives Cate goes through one router
(`kernel/api`) in the runtime. Each module declares its methods once with
`defineCateApi` in `contract/api.ts` (access `read` or `control`, handler
`service` or `session`, args, timeout, output format, CLI words);
`src/panels/api.ts` lists them. The CLI (`src/cli/engine.ts`) generates its
commands, help and argument parsing from those specs.

Terminals get `CATE_SOCKET` (the workspace's local socket) and a per-PTY
`CATE_TOKEN` that names the calling panel; T3 harnesses get the same with a
per-harness token. CLI and harness calls are gated by the workspace settings
`cliEnabled` and `cli*Enabled` (per area, read or control). Session methods
target a panel through the reserved `panelId` argument (`--panel` on the CLI),
or the caller's sticky target (`cate panel set`).

### Key Patterns

- **Functional React** with hooks for views and UI; no React in contracts,
  `runtime/` or `client/`.
- **The runtime is the application**: anything that is not rendering, input
  or a native OS primitive goes into a module's `runtime/` side, never into
  the desktop shell.
- **Views ask, sessions act**: dialogs and confirmations only in views,
  through `ClientUi`; the answer travels in the op (`close {discard: true}`).
- **Records are state, never commands**: a record change never kills or
  restarts a resource; resource work is an explicit op or capability call.
- **Declare once**: capabilities, API methods, settings and panel types are
  declared in contracts and consumed generically.
- **Clean cuts**: no migration code, no shims or re-exports from old paths.
- Keyboard shortcuts come from the shortcut registry (`kernel/ui`) and
  `client/ui` bindings.
- **Tailwind CSS** for styling.
