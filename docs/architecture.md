# Cate architecture

This document is the model Cate is built on. It says what every system is,
where it lives, what it owns, and how the pieces talk. Where the code
disagrees with it, the document wins: fix the code, or change the document
first. It describes the architecture: what each piece owns and the rules
between them. Exact method lists, fields and constants live in the
contracts it names (a module's `contract/`), not here.

Three ideas shape everything below:

1. **The runtime is the application.** Everything that is not rendering, input
   or a native OS primitive runs in the runtime daemon of the workspace. A
   desktop window or a phone is a client: it renders what the runtime holds
   and forwards input.
2. **One obvious home.** Every piece of code has one place it belongs, every
   boundary (runtime protocol, the `cate` API, settings) is declared once, and
   generic code never branches on a specific panel type, or on whether a
   runtime is local or remote.
3. **Shared workspaces and a mobile client.** Several people, and phones, work
   in the same workspace at the same time. Because the application is in the
   runtime, that is a second client connecting.

The guiding rule for every decision: state lives where it is most natural, and
the model stays simple and complete. State is shared; clients render it. Every
client is the same to the runtime. Connections are secure: every network
connection is encrypted and mutually authenticated, and only known devices
connect. Once connected, a client has full access; per-person state and
permissions are deliberately left for later, and nothing here makes them
harder to add.

## Decisions

The choices this document is built on.

| # | Decision |
|---|---|
| D1 | One daemon per workspace, on every machine. No shared local daemon. |
| D2 | Everything that is not rendering, input or a native OS primitive runs in the daemon. |
| D3 | Every client is the same to the runtime. No roles, no per-client permissions. |
| D4 | Every network connection runs inside a Noise handshake with pinned keys; only known devices connect (section 7.6). The local transport is protected by the OS user (a `0600` socket); a caller there (the CLI, by its token) reaches only the `api` capability. Every client is a device of the workspace, whatever let it in. |
| D5 | All workspace state lives in the workspace data directory on the runtime's machine. The repository's `.cate/` holds only skills, temporary files and worktree checkouts. |
| D6 | Nothing is shared between workspaces. A new workspace starts from defaults. |
| D7 | Native OS primitives stay on the client's desktop side (the desktop shell, and a module's `desktop/` side such as the page driver and passkeys in `services/browser/desktop`): windows, webviews and the page driver, the loopback web proxy, passkeys, native dialogs, notification display, drag ghost, screenshot capture, the updater. |
| D8 | Clean cuts: no migration code, no old formats read, no shims (section 18). |
| D9 | Clients share one core, not a UI. Every client runs the same client core (connections, the document mirror, client state, panel and action logic; no UI), and each shell draws it with its own UI: the desktop shell in React, the iOS app in SwiftUI. Shared code never draws and never asks for a platform; where the runtime or the core must know what a client can do, it asks for a client feature (section 12.2). |
| D10 | In the browser panel, `localhost` always means the runtime's machine, on every client, routed through the workspace connection (section 12.3). A loopback URL opened from anywhere else (terminal links, a URL opened with the app) opens in a browser panel of the workspace, never in the client's system browser. |

## 1. What we build

- **One daemon per workspace.** A workspace is served by its own runtime
  daemon. The same daemon program runs on every machine, and no code asks
  whether a daemon is local or remote.
- **Everything belongs to a workspace.** Settings, credentials, browser data,
  skills, trust and pairings are workspace state, held by that workspace's
  runtime. A client keeps only what is about its own screen and device: how
  Cate looks and feels, its list of workspaces, its main window's bounds and
  its device key.
- **Thin clients.** A client connects directly to the runtime of each
  workspace it has open and renders it.
- **Collaborative workspaces.** Several people work in the same workspace at
  the same time and see one live state. Whoever shares a workspace shares it
  only with trusted people, so every participant has full access.
- **A mobile app.** The iOS app connects to a workspace and shows and drives
  its panels with its own native UI, on the same client core as the desktop
  app (section 15).
- **Two ways to connect over the network, one flow.** Same network, or Cate
  Connect. Either way the user scans a QR code (or types its code) and is
  connected directly and securely to the workspace.
- **Work that can outlive the window.** Terminals and agents live in the
  runtime, and a workspace setting decides whether the runtime keeps
  running without clients.

There is one client core and one UI per shell. The core is everything a
client does that is not drawing: connecting and pairing, the document mirror,
client state, panel creation and close rules, actions. The desktop shell draws
it with React; the iOS app draws it with SwiftUI and runs the core headless.
No UI is shared between shells.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Daemon** | The one Cate runtime program. The same build runs on every machine and has the same modules everywhere. |
| **Runtime** | One running daemon serving one workspace. It executes all of that workspace's work: files, git, search, processes, panel sessions, agents, the `cate` API, and holds its state. |
| **Machine** | A computer that runs runtimes. Runtimes on one machine share only the installed daemon program. |
| **Workspace** | A project (a root path) with its worktrees, panels and layout, served by one runtime. |
| **Workspace data** | A workspace's own state directory on the runtime's machine (section 7.2). |
| **Transport** | How a client reaches a runtime: `local` (a socket on the same machine), `machine` (the local socket carried over a command the client runs on the runtime's machine: SSH, WSL) or `network` (same network, or Cate Connect). A transport never changes what the runtime is or does. |
| **Cate Connect** | A coordination service we host. It passes connection setup messages so a client and a runtime connect directly, and runs a TURN relay for when they cannot. It never sees workspace traffic in the clear and is never trusted with it. |
| **Pairing** | Connecting a device to a workspace for the first time with a QR code or pairing code. Afterwards both sides know each other's key. |
| **Capability** | A typed group of runtime methods and streams (`file`, `vcs`, `process`, `tunnel`, `power`, ...), declared once with `defineCapability`. |
| **Document** | The shared structure of a workspace: panel records, windows and their dock trees, canvases, relations, worktree metadata. The runtime holds it and orders every change to it. |
| **Op** | One change: a document op (section 9.1), sent by a client, a session or a `cate` API handler, or a session op, sent to one panel session (section 11.2). |
| **Panel session** | A panel's live state and behaviour. Runs in the runtime. |
| **Client** | One running instance of a Cate app (the desktop app, the iOS app): the client core plus its shell's UI. Renders the document and session snapshots of the workspaces it has open. |
| **Client core** | The shared, UI-free part of every client: connections, pairing, the document mirror, client state, panel and action logic (section 12). |
| **Client feature** | Something a client can do that not every client can (host a webview, drive a page, passkeys, ...), from one closed list (section 12.2). The runtime and the core ask for features; a shell's UI knows its own platform. |
| **Device** | The machine a client runs on, identified by its device key. |
| **Shell** | A platform app around the client core, with its own UI and native primitives: desktop (Electron and React) or iOS (SwiftUI). |
| **Service** | Infrastructure more than one panel or caller uses: terminal, browser, agents. |
| **Panel** | A session in the runtime, drawn by each shell's own view: terminal, editor, browser, review, canvas, surface. |
| **Caller** | Whoever calls the `cate` API: the CLI in a terminal, a client. |

### Agents

"Agent" means exactly one thing: a provider CLI identity.

| Concept | Meaning | Examples |
|---|---|---|
| **Agent** | A provider identity, static data in one registry (`AGENTS`). | claude-code, codex, cursor, grok, kiro, opencode |
| **Agent session** | One conversation of an agent CLI running in a terminal panel's PTY, observed through injected hooks and pid presence: `{agentId, sessionId, cwd, worktreeId}`. It reports status, takes a prompt, reads its conversation, lists its changes and resumes. | "claude-code in a terminal" |

Every agent runs as its CLI in a terminal panel; the terminal panel shows
its session.

## 3. Layers

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ shells     desktop (window host, native OS, React UI) · mobile (iOS core) │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ panels     framework + terminal · editor · browser · review · canvas ·   │
 │            surface                                                       │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ client     core · connections · workspaces · document mirror · host      │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ services   terminal · browser · agents                                   │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ workspace  document · lifecycle · canvas · files · repository ·          │
 │            skills · relations · notifications                            │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ runtime    daemon · data · transports · security · pairing · connect ·   │
 │            push · host capabilities                                      │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ kernel     rpc · api · settings · lifecycle · state · log ·              │
 │            interaction (ClientUi port, actions, shortcuts, themes)       │
 └──────────────────────────────────────────────────────────────────────────┘
```

Code is organised along two axes: the **layer** (above) and the **side**
(`contract`, `runtime`, `node`, `client`, `desktop`). Everything outside
`shells/` is shared and holds no UI; the desktop UI is `shells/desktop/ui`
(section 15), the iOS UI is `ios/`. The rules:

- **Sides first.** Contracts (`contract.ts` and the files of a `contract/`
  folder) are pure (types, data and pure functions; no Electron, no Node
  built-ins, no React, no DOM, no assets, no I/O) and may be imported from
  anywhere; a contract imports only other contracts. A `runtime/` folder
  imports only contracts, other `runtime/` folders and `node/` folders. A
  `node/` folder is shared Node code (state files, sockets, installs) that
  both the daemon and the desktop shell use; it imports only contracts
  and other `node/` folders. A `client/` folder imports only contracts and
  other `client/` folders, and never Node built-ins, Electron, React or the
  DOM. A `desktop/` folder (desktop-only code that is not UI: the webview
  host, the page driver, preloads) and all of `shells/desktop` may import
  everything but a `runtime/` side. React, the DOM and the UI libraries
  (xterm, Monaco, icon sets) are imported only in `shells/desktop`. The
  daemon never bundles `client/` or `desktop/`; a client never bundles
  `runtime/`.
- **Layers second.** Within a side, a module imports only from its own layer
  or layers below. Where a lower layer needs something a higher one provides
  (reaching the current workspace's runtime, a shell's UI asking before a
  panel closes), the lower layer owns a slot and the higher layer registers
  into it. `kernel/rpc` owns the "runtime for this workspace" slot;
  `client/core` fills it. `client/host` owns the slots a shell's UI fills:
  close guards (`registerPanelCloseGuard`), page operation handlers
  (`registerSurface`), reveal hooks and the canvas target picker.
- **Public entries only.** Across modules, import a module's contract (its
  `contract.ts` or a file of its `contract/` folder) or a side's `index.ts`,
  never its internals. A desktop side split by Electron process exports
  from `desktop/{main,preload,renderer}/index.ts`; the client layer's modules,
  client core as a whole with no side folders, export from their module's
  `index.ts`, and so does `kernel/interaction` for its client core part
  beside its `contract/`. The panel index files
  `src/panels/definitions.ts`, `src/panels/runtime.ts`, `src/panels/api.ts`,
  `src/panels/capabilities.ts` and `src/panels/settings.ts` are public
  entries too.
- **One composition root.** The daemon's composition root
  (`src/runtime/daemon/entry.ts`, `main.ts` and `compose/`) builds every
  module's runtime side and wires them together, so it is exempt from the
  layer, side and entry rules. Nothing else is.
- **Every file is on a side.** A panel's `definition.ts` is a contract; its
  `session.ts` and `runtime.ts` are its runtime side; its `parts/` are split
  into side folders. The `cate` CLI (`src/cli`) imports only contracts,
  `kernel/rpc/client`, `src/panels/definitions.ts` and `src/panels/api.ts`.
- **Services point one way.** `services/terminal` never imports
  `services/agents` (nor does its desktop UI import its UI); agents plugs
  into its extension points (section 10.3).
- dependency-cruiser enforces these rules in CI (`.dependency-cruiser.cjs` at
  the root, run by `npm run lint:deps`); `src/test/depcruise.test.ts` proves
  the main rules (runtime sides, contract purity, layers, the CLI zone,
  services one way) reject a fixture that breaks them
  (`test/depcruise-fixtures/`).

**The client test.** If it is not rendering, input, or a native OS primitive,
it runs in the runtime. A phone has no Electron main and no Node, so anything
a client needs beyond drawing and input comes from the runtime over the
protocol. `shells/desktop/main` holds only what is inherently a desktop window
host (D7).

**The one-daemon test.** No module branches on local versus remote. A local
runtime is found and started the same way on every machine and reached
through the `local` transport. Where behaviour must differ by transport (for
example how a client reaches a port on the runtime's machine), the connection
object implements it; callers do not ask.

**The one-core test.** Shared code (everything outside `shells/`) holds no
UI: no React, no DOM, nothing laid out for one kind of screen. Logic two
shells need lives in the client core, never inside a UI; a shell's UI only
draws, takes input and asks the user.

**The no-platform test.** No shared module branches on desktop versus mobile,
or on any platform. Where the runtime or the core needs to know what a client
can do, it asks for a client feature (section 12.2). A shell's UI knows its
own platform and does not adapt itself to others.

### Module shape

Every module that crosses a process boundary has the same shape and only the
folders it needs.

```
<module>/
  contract.ts   pure: types and pure logic both sides run (the document
                reducer, the canvas model); re-exports its contract/ folder
  contract/     pure files contract.ts re-exports, by convention:
    capability.ts   the module's defineCapability declarations
    api.ts          its cate API specs (defineCateApi)
    settings.ts     its settings slice (defineSettings)
  runtime/      daemon side
  node/         Node code shared by the daemon and the desktop shell
  client/       client core side: typed clients, stores, logic; no React,
                no DOM
  desktop/      desktop-only code that is not UI (webview host, CDP driver,
                preloads, native addons)
```

A module's UI is not in the module: its desktop UI is
`shells/desktop/ui/<layer>/<module>/`, its iOS UI is in `ios/`.

Each side may have an `index.ts`, its public entry. A runtime side exports a
factory that takes an explicit deps object (`createFilesRuntime(deps)`) and a
`<name>CapabilityImpl(service)` for the rpc server; it never reaches for
globals, singletons or Electron. Needs from a higher layer are declared as a
minimal interface in the deps, and the composition root passes them.

## 4. What runs where

The split follows the client test (section 3).

### 4.1 In the runtime

| What |
|---|
| Files: read, write, watch, search (ripgrep) |
| Path validation and granted paths |
| Importing dropped files onto the host |
| Open file buffers (editor text as a Yjs document, one per file) |
| Git: operations, worktrees, status monitors, PRs, `gh` |
| Worktree lifecycle (create, remove, panel binding) |
| Terminals: PTYs, shell resolution, login env, activity, ports, cwd, idle suspend |
| Terminal screen state and scrollback (headless terminal per PTY) |
| Terminal logs, shell env |
| Agents: hook ingestion, pid presence, change history, session stores, conversation reads |
| Agents: status state machine, resume stamps, driver selection |
| Starting agents in a terminal panel |
| Browser data: history, bookmarks, passwords, downloads |
| Browser session: tabs, URLs, navigation state, titles |
| The document: panel records, docks, canvases, detached windows, relations, worktree metadata |
| Panel sessions |
| The `cate` API router |
| The CLI endpoint |
| Workspace settings (section 8) |
| Skills: installs, mirror, sources, registry |
| Trust, granted paths, terminal logs, screenshots |
| Keeping the workspace running and its machine awake (`keepRunningWhile`) |
| Notification events (deciding that something happened) and the warnings kept for later clients |
| Presence: which clients view and focus which panel |
| Pairing, the network transports, the security layer, Cate Connect registration |
| The workspace data directory and the local socket that keeps one runtime per workspace |

### 4.2 In the client

Each row is in the client core (shared, no UI), in a shell's UI, or in a
shell's native side.

| What | Where |
|---|---|
| Rendering the document: docks, canvas view, nodes, minimap, territory layer, relation drawing | shell UI |
| Panel views: xterm, Monaco, diff views (desktop); native views (iOS) | shell UI |
| Input, drag and drop | shell UI |
| Dialogs, confirmations, notification display, clipboard (`ClientUi`, including the in-app save-path dialog over the workspace's files) | shell UI |
| Webviews, browser partitions, the page driver (CDP), guest preloads | shell native |
| Passkeys (macOS `ASAuthorizationController`, needs the signed app and a window) | shell native |
| The upstream browser proxy (`browserProxyUrl`) and the loopback web proxy (section 12.3) | shell native |
| Windows, menus, the drag ghost, updater, crash reporting, analytics | shell native |
| Client features (section 12.2) | declared by the shell |
| Client state: viewport, zoom, active tabs, maximize, focus, selection, per-panel view state, undo history, one-shot intents | core |
| Document mirror with optimistic ops | core |
| Transports: finding and starting local runtimes, machine bridges, dialing the network, the security layer and pairing, with the device key (`ShellTransports`, over shared `runtime/*/client` code, 7.5) | shell native (desktop main; the iOS core) |
| Connections: one per open workspace, reconnect, status, the typed proxies, loopback routing | core |
| Workspace list, known runtimes | core (stored through the shell's `DeviceStore`) |
| Onboarding | shell UI |
| Where each window sits on screen (main and detached) | shell native (stored in the device's `boot.json`) |
| Client settings (section 8) | core |
| Panel creation and placement, close guards, actions and shortcuts (section 12.4) | core |

### 4.3 Not in the model

- No panel moves between windows or processes. Detaching a panel is a
  placement op (section 9.1); windows and canvases are document data, and the
  cross-window panel index is derived from the document in the client.
- No runtime id inside a path string. The connection a path came through is
  the routing.
- No session asks for UI (section 11.2, rule 6).
- No shared local daemon, no protocol of its own for SSH or WSL (a machine's
  bridge carries the local transport over the command's stdio, sections 7.1
  and 7.5), no project lock file, no
  reverse tunnel for the CLI, no per-feature IPC between the desktop shell's
  main process and its renderer for workspace work.
- No client served differently for how it arrived. The transport decides who
  is admitted (7.5, 7.6); after `hello` every client is the same to the
  runtime (D3), and nothing past the door knows the transport.
- No state shared by the workspaces of a machine: settings, skills,
  browser data, trust, grants, agent hooks and agent changes all belong to one
  workspace.
- No skill installed into a user-global agent directory. Bundled skills
  install into the workspace like any other skill (section 9.6).

## 5. State classes

Every piece of state belongs to exactly one class.

| Class | Owner | Examples | Shared with |
|---|---|---|---|
| **Document** | the runtime | panel records, windows and dock trees, canvases, nodes and geometry, node mini docks, relations, worktree metadata | every client of the workspace |
| **Session** | a panel session | terminal screen and scrollback, editor buffer and whether a conflict's diff is shown, browser tabs, URLs and viewport preset, a review's comparison, notes and agent review, agent status and the prompts on their way to the agent | every client viewing the panel |
| **Resource** | runtime capabilities | PTYs, files, git, agent processes, agent changes | through the runtime |
| **Workspace data** | the runtime | workspace settings, secrets (browser passwords, the runtime key), browser history and bookmarks, skill sources, trust, granted paths, devices | every client of the workspace |
| **Device** | one client device | client settings, workspace list, known runtimes, device key, main and detached window bounds, onboarding progress, per-workspace browser partitions (cookies) | never |
| **Client** | one running client, in memory | viewport, zoom, active tab per stack, the maximized stack of a window, the tab a browser panel shows and its page zoom, an editor's source or preview, a review's file filter, focused file, collapsed and expanded files and context lines, focus, selection, undo history, open overlays, a drag in progress, one-shot intents (reveal a line), mounted webviews | never |

Rules:

- Document changes are ops (section 9.1). Records are state, never commands: a
  record change may make a client follow it (reload a view) but never kills,
  restarts or discards a resource. Resource work is always an explicit
  operation.
- Placement is shared. A panel docked, detached or moved by one person moves
  for everyone. Where a detached window sits on screen is not: each device
  puts it where it likes. Which tab of a stack is active is client state, and
  so is maximize: it changes what one client draws, never the document.
- How a client looks at a panel is its own: which tab of a browser panel it
  shows and the page's zoom, whether an editor shows a markdown file as
  source or preview, and a review's filter, focused file and expansions. What
  the panel is stays shared: the browser's tabs, URLs and viewport preset, the
  file and whether a conflict's diff is shown, the review's comparison and
  notes. A request to show something (reveal a line, open a review at a file)
  is a one-shot `reveal` in the snapshot that each view applies once. How a
  client shows a review (split, wrap, whole files) is a client setting.
- Undo is per client, over that client's own document ops (section 13.6).
- A developer adding a feature declares which class its state is in and never
  writes sync code.
- Nothing in a runtime is shared with another workspace. A new workspace
  starts from defaults.
- Agent CLIs keep their own logins in their own files (`~/.claude`,
  `~/.codex`). Those belong to the CLI, not to Cate, and Cate never writes
  user-global agent files, so a terminal agent is logged in wherever the
  machine user is. Cate writes only repo-local agent files (hooks, skills).

## 6. Kernel

Generic machinery. The kernel knows no feature.

- **`kernel/rpc`**: the runtime protocol (section 7.8).
  - `defineCapability(name, { methods, streams })` declares a capability once,
    with typed named parameters. The daemon serves declared capabilities
    generically, to clients only unless the declaration says `callers`
    (only `api` does: a caller hello reaches nothing else); the client side is a generic typed proxy that queues calls
    until connected. There are no hand-written method tables, switch
    statements or per-capability client classes.
  - **Session channels**: the generic mechanism for one subscription that
    carries a snapshot, its changes and byte or Yjs streams, plus typed ops
    sent back. `panels/framework` serves it as the `session` capability
    (`session.subscribe(panelId)`, `session.op(panelId, op)`); snapshot and op
    schemas are declared in each panel's definition. There is no per-panel
    RPC surface. A stream that already has its own capability is not copied
    into the channel: a terminal view reads its PTY through `process.attach`
    and an editor view its buffer through `file.buffer` (sections 10.1, 9.4).
  - **The runtime slot**: `runtimeFor(workspaceId)` returns the typed proxy
    of an open workspace, whose calls wait until it connects
    (`tryRuntimeFor` when it may not be open). `startClientCore` fills it;
    the desktop UI reads it through its `useRuntime` hook.
  - Framing, version negotiation and error codes (section 7.8).
- **`kernel/api`**: `defineCateApi`, the router and targeting (section 14).
- **`kernel/settings`**: `defineSettings` for a module's settings slice (keys,
  defaults, validation, scope `client` or `workspace`), `composeSettings`,
  and the stores and mirror over a composed table, which they are given: the
  kernel composes no slice (section 8). Serves the `settings` capability for
  workspace scope.
- **`kernel/lifecycle`**: a bus for `onShutdown`, `onClientConnected` and
  `onClientGone`, so generic lifecycle code never names a feature.
- **`kernel/state`**: hand-editable JSON state files: in-memory authority,
  debounced atomic write, external-edit watcher, corrupt-file quarantine,
  keyed locks. The engine is pure; the files are its `node/` side, used by
  the daemon for workspace data and by the desktop shell for device files. Every state file has exactly one writer process.
  Files that are not live state (small self-contained files such as the
  install id, and caches the owner rebuilds when missing, such as
  `agents/usage/`) use the same `node/` side's one-shot helpers instead
  (`writeJsonAtomic`, `readJsonFile`): the same atomic write, no in-memory
  authority or watcher. Client
  core code never touches files: it reads and writes device state through
  the `DeviceStore` port, which each shell implements (the desktop shell with
  these files).
- **`kernel/log`**: structured logging for every process: the logger in its
  contract, a rotating file sink (`node/`) and Electron sinks (`desktop/`).
  Tests replace electron-log with a stub (`src/test/electronLogStub.ts`).
- **`kernel/interaction`**: the client core's side of interaction, with no UI in it:
  the `ClientUi` port (what the core and a shell's views ask the user), the
  theme schema, the action catalog and the shortcut registry (section 12.4).
  Its `contract/` (the theme schema and built-in themes, action and shortcut
  declarations, the appearance and shortcut settings slices) is pure, so the
  daemon reads it through panel definitions and the settings composition;
  the daemon never imports the rest. The React components that draw these (buttons,
  modal, popover, tooltip, error boundaries, the theme manager) are the
  desktop UI's (`shells/desktop/ui/kernel/interaction`).

## 7. Runtime

The runtime is one daemon serving one workspace, plus its workspace data and
the pieces that make it reachable and secure.

### 7.1 Daemon

- **`runtime/daemon`**: the program (`main.ts`, bundled as `runtime.cjs`),
  release and install layout, lifetime, update, and the composition root:
  `entry.ts` builds the daemon around one workspace (data directory, socket,
  keys, pairing, network access, host capabilities) and
  `compose/workspace.ts` builds and registers every workspace, service and
  panel module. Its `node/` side installs releases and spawns the detached
  daemon; its `desktop/` side starts a local runtime for the desktop shell.
- **One workspace.** One daemon serves exactly one workspace root, with all its
  worktrees. It validates every path against that root, its worktree
  checkouts, its granted paths and, read-only, the screenshots and downloads
  of its workspace data (9.4). There is no scope id on calls: the connection
  is the scope.
- **Identity.** `runtimeId` is the first 16 characters of the lowercase base32
  SHA-256 of the canonical root (`realpath`), so socket paths stay short. It is
  stable across restarts and names the workspace data directory and the local
  socket only; it never leaves the machine. Moving the project folder gives a
  new `runtimeId` and a fresh workspace. On the network (mDNS, Cate Connect,
  pairing codes, `known-runtimes.json`, pushes) a runtime is known by its
  **network id**, the first 16 base32 characters of the SHA-256 of its static
  key (`networkIdOf`, same format): only the key's holder can claim it, the
  same path on two machines never collides, and the path does not leak. A
  runtime whose key is lost (`secrets.json` deleted) gets a new network id,
  and devices pair again.
- **Install.** One layout everywhere: `~/.cate/runtime/<build>/` holds the
  daemon, its Node, ripgrep, the `cate` CLI, bundled skills and native
  addons; `<build>` is the build id (section 7.10), which the tarball
  carries in its `BUILD` file. An install is complete once its `.ok` marker
  is written, last. An install is never replaced in place, and a daemon
  keeps the tree it started in. `~/.cate/runtime/current` names the last
  install made or updated to. The desktop app ships this tarball and
  installs it there on start (again if it is gone). On any other machine
  one command installs it (`curl -fsSL <install url> | sh`, checked against
  the `.sha256` published beside the tarball) with a `cate` launcher that
  runs the current install.
- **`cate serve [path] [--connect]`** shares a workspace of the machine it
  runs on. It runs the install's `runtime.cjs bridge <root>` (7.3), which
  starts the runtime when nothing answers, and over it, as a local client,
  does what Share does in the app: trusts the workspace, sets
  `runtimeNetwork` (`sameNetwork`, or `cateConnect` with `--connect`) and
  prints a pairing QR code and pairing code (one JSON line with `--json`).
  The setting is saved like any other. It refuses to run inside a Cate
  terminal (7.7). `serve` is a command of the CLI, not a `cate` API
  method; the daemon program itself has only `serve <root> [--detach]` and
  `bridge <root>`.
- **Machines (SSH, WSL).** The desktop app opens folders on machines it runs
  commands on, picked in "Open…" (12.5): SSH machines (saved in the client
  setting `sshMachines` once they answer, offered from the hosts of
  `~/.ssh/config` and its includes, or added by an ssh command; the Open
  picker adds and removes them), and on Windows the
  WSL distros (`wsl.exe --list`). A machine is `{kind: 'ssh', target}` or
  `{kind: 'wsl', distro}` (`runtime/daemon/contract/machine.ts`). The main
  process runs the system `ssh` without a tty (`StrictHostKeyChecking=accept-new`;
  a keepalive that notices a dead link within 45 s). What ssh asks (a
  password, a passphrase, a one-time code) goes through `SSH_ASKPASS` to a
  helper (`runtime/daemon/desktop/askpass.ts`: Electron as Node, a socket in
  the private `~/.cate/ssh/`) and is asked in the app's last focused main
  window; every command for a machine shares one connection
  (`ControlMaster`, `ControlPersist` 10 minutes), so a password is asked once,
  not per command, and dials to one machine run one at a time so the first
  signs in for the rest; a prompt ssh stops waiting for is withdrawn. On
  Windows, whose OpenSSH shares no connections, ssh runs with `BatchMode`
  (keys and the agent only) or `wsl.exe -d <distro>`, and runs
  small scripts with the machine's `sh` (`runtime/daemon/contract/ssh.ts`):
  `ensureRuntime` looks for this app's build in `~/.cate/runtime/<build>/` and
  only when it is missing streams this build's runtime tarball for the
  machine's target into its `tar` (glibc Linux and macOS, x64 or arm64), so
  the machine needs no network of its own. The tarball is one the app ships
  when the target is its own, else that release's, downloaded by the app; a
  checkout matches no release and pushes the one `npm run runtime:tarball --
  --target <target>` built. A tarball of another build is refused. A folder
  browser lists and creates folders. Opening a folder records it as
  a workspace on that machine (`{machine, root}` in the workspace list); its
  connection runs `runtime.cjs bridge <root>` of that build on the machine
  (7.3, 7.5). Nothing needs to listen on the network and no pairing happens:
  SSH (or the Windows user, for WSL) is the trust boundary, as the OS user is
  for the local socket. The command line is built in main from validated
  fields (destination, port, identity file, jump host, distro), never from
  text the renderer passes.
- **Pruning.** A daemon started from a release install (built with
  `CATE_RELEASE=1`, the release workflow) removes installs nothing uses:
  not its own, not the current one, not one a live daemon runs (the `build`
  in its `runtime.json`, or an `in-use/<pid>` marker its spawner wrote).
  Clients never prune. In a checkout, `npm run runtime:dev` installs the
  checkout's build and removes the other installs of the same version that
  no live daemon runs, so a checkout and the packaged app of one version do
  not keep both; the app installs its own again when it starts.
- **Paths.** Inside the runtime every path is a plain absolute path on its
  machine. Clients know which runtime a path belongs to from the connection it
  came through.
- **Process model.** The daemon is a detached process, not a child of any
  client. Its PTYs and agent processes are its children and live as
  long as it does.

### 7.2 Workspace data

**`runtime/data`** owns the directory `~/.cate/workspaces/<runtimeId>/` on the
runtime's machine. It holds everything in the workspace data class and every
persisted session and document file. It is created with mode `0700`.

```
~/.cate/workspaces/<runtimeId>/
  runtime.sock          the local transport on macOS and Linux; binding it is
                        the lock (7.3). When its path is too long for a socket
                        (a long HOME), clients and the daemon reach it as
                        /tmp/cate-<uid>/<runtimeId>/runtime.sock, through a
                        symlink to this directory in a private (0700) dir;
                        the socket file stays here
  runtime.json          { runtimeId, root, pid, version, build, protocol, endpoints }
  document.json         the document (9.1)
  sessions/<panelId>.json   persisted session state
  sessions/removed/     state of removed panels, kept a day for undo
  buffers/<hash>.bin    unsaved editor buffers (Yjs updates)
  settings.json         workspace settings (hand-editable)
  secrets.json          0600: browser passwords, runtime key pair
  devices.json          0600: every device that has opened the workspace: public
                        key, name, how it was admitted, added at, last seen
  push.json             0600: devices registered for pushes: key fingerprint,
                        delivery target (opaque), the key pushes are sealed with
  trust.json            { trusted, decidedAt }
  grants.json           granted paths outside the root
  skills/sources.json   the workspace's skill sources
  browser/              history.json, bookmarks.json, downloads/
  agents/               hooks/ (hook bridges), changes/ (change history), stamps.json (resume stamps),
                        usage/ (model-rates.json, the LiteLLM rate snapshot; scan-cache.json,
                        transcripts parsed for usage, by size and mtime)
  terminal-logs/
  screenshots/
  logs/                 daemon.log (the daemon's log, rotated) and
                        daemon.out.log (the detached daemon's stdout and
                        stderr)
```

- **Outside the repository.** A repository controls everything it commits: a
  cloned repo could otherwise ship trust, layout that auto-runs commands, or
  credentials, and `git clean -xdf` would delete logins and passwords.
- `<project>/.cate/` holds only what belongs in the tree: `skills.json`,
  `tmp/` (temporary files: connected-editor drafts and files copied in from
  another workspace or the OS, section 9.4), `worktrees/` (checkouts) and
  its `.gitignore`.
- **Secrets.** `secrets.json` is the only file with secret material Cate
  owns. It is `0600`. There is no
  OS keychain dependency, so the same code runs on a headless Linux machine.
  Protection is the machine user's file permissions.

### 7.3 Finding and starting a runtime

- **The socket is the lock.** A starting daemon removes a stale
  `runtime.sock` only after a connect to it fails, then binds it. Binding is
  atomic: a second daemon for the same workspace fails to bind and exits. The
  OS releases it when the daemon dies. On Windows the socket is a named pipe
  `\\.\pipe\cate-<user key>-<runtimeId>`, with the same rule; a pipe that is
  taken but does not answer belongs to a daemon still stopping, and is taken
  over once it is gone.
  A stopping daemon closes its socket before it lets go of the workspace's
  files, so before removing a stale socket a starting daemon waits for the
  daemon that last owned it (the pid in `runtime.json`) to exit. Every daemon
  exits within 5 s of starting to stop, even when a shutdown step is stuck;
  off Windows, one still alive after that is killed (a reused pid running
  another program is left alone); on Windows the start waits for the pipe to
  come free and gives up when it does not. So a stop writes the state files (settings, devices, push,
  secrets, document) first, before any step that can stall, and a starting
  daemon removes the temporary files a killed writer left in its data dir.
- **Workspaces never nest.** After binding, a daemon whose root contains, or
  lies inside, the root of a live runtime on the machine (its `runtime.json`
  pid alive and its socket answering; a `runtime.json` left by a killed
  runtime does not count) serves nothing: it refuses every hello with the
  reason for 10 s, then exits. The refusal names the open workspace, in its
  message and as `data: {nested: {root}}`; clients show it and offer to open
  that workspace instead. Nothing else checks for nesting.
- After binding, the daemon writes `runtime.json`.
- **A client on the runtime's machine** computes the `runtimeId` from the root,
  connects to the socket, and if nothing answers runs
  `~/.cate/runtime/<build>/runtime/bin/node
  ~/.cate/runtime/<build>/runtime.cjs serve <root>` (its own build) as a
  detached process, stdio to `logs/daemon.out.log`, and retries
  until connected (10 s budget). It also starts the runtime of the last
  selected workspace when the app launches, before the window asks for it.
- **A client that runs commands on the runtime's machine** (SSH, WSL; 7.1)
  runs `runtime.cjs bridge <root>` there. The bridge does what a client on
  the machine does (connect, or start the runtime and retry), then prints
  `CATE-BRIDGE-READY` and carries the socket over its stdin and stdout until
  either side closes; output before that line (a chatty login file) is
  ignored. So a stopped runtime on such a machine starts again when the
  workspace opens, as a local one does.
- **A client on another machine** that cannot run commands there (a phone, a
  teammate's device) finds the runtime through the network transport (7.5)
  using the network id it paired with (7.1).

### 7.4 Lifetime

What keeps a workspace available is one workspace setting,
`keepRunningWhile`: a list of triggers. While a picked trigger holds, the
runtime keeps running and keeps its machine awake (`power`, 7.9); the same
rule for every client, wherever it runs.

| Trigger | Holds while | Default |
|---|---|---|
| `agents` | an agent runs a turn (one waiting at its prompt does not count) | on |
| `commands` | a terminal runs a program other than its shell and other than an agent | on |
| `clients` | a client is in use: it has the person's attention (`attentive`) and acted in the last 10 minutes (`lastActiveAt`, presence, 9.1) | on |
| `always` | always | off |

A connected client keeps the runtime running too (its views need it), but
not the machine awake: a window left open overnight lets the machine sleep.
With no client connected and nothing holding, the runtime stops after a 5
minute grace period. A keep-awake request (`power.set`) holds like `always`
until it lapses. Clients report input as presence activity (`active`,
throttled to once a minute), so typing in a terminal counts. A stopped
workspace is started by a client on its machine when it opens or restores
the workspace.

"Stop workspace runtime" lists the running terminals and agents, asks for
confirmation in the view, and then sends `runtime.stop`. Before its connections
close the runtime tells every client why (`runtime.lifecycle`): after a
deliberate stop each client shows the workspace as stopped and does not
reconnect (or start it) until the person starts it again there; after a crash,
an update or an idle stop clients reconnect as usual. Stopping hangs up every
shell like a closing window (their jobs, background ones included, end), then
kills what is left. Idle suspend inside a running runtime still parks idle
PTYs.

### 7.5 Transports

**`runtime/transports`**. Every transport carries the same frames (7.8).

**The transport decides who is admitted, never how a client is served.**
Each transport has its own door (the OS user, SSH, Noise with a paired key);
behind it every client is the same client connection (`clientId`, device,
features; `ClientConnection` in `kernel/lifecycle`) with no transport in it, and nothing in the runtime branches on how
a client arrived. A client asks for what differs between clients through
client features (12.2). A test runs one scenario over the local socket, a
machine's bridge and the network and requires the same result
(`src/test/shared/transports.test.ts`).

- **`local`**: the Unix socket in the workspace data directory, or the named
  pipe `\\.\pipe\cate-<user key>-<runtimeId>` on Windows. Access is the OS
  user: the directory is `0700` and the socket `0600`. Node cannot set a
  pipe's ACL, so the pipe name carries a random key kept in
  `~/.cate/pipe-key`, which only the user can read: another user cannot
  guess the name to take it first, but can see it once the pipe exists
  (Windows lists pipe names to every user), so the name is not a secret.
  No handshake beyond the protocol
  `hello`. Used by clients on the same machine and by the `cate` CLI in
  terminals the runtime spawned. Anything running as
  the same OS user can connect; that is the trust boundary (D4).
- **`machine`**: the local transport carried over the stdio of a command the
  client runs on the runtime's machine (`ssh`, `wsl.exe`): `runtime.cjs
  bridge` (7.3). Same frames and framing as the socket; the door is SSH or
  the Windows user.
- **`network`**, established one of two ways, always wrapped by the security
  layer (7.6):
  - **Same network**: the runtime listens for WebSocket connections on a
    port on every interface (path `/cate/<network id>`), but serves only
    private addresses: `10/8`, `172.16/12`, `192.168/16`, `100.64/10`
    (carrier NAT, which Tailscale uses), `169.254/16`, `127/8`, `::1`,
    `fe80::/10` and `fc00::/7` (`isPrivateAddress` in
    `runtime/transports/contract`). A connection from any other address is
    closed before anything is read. It advertises `_cate._tcp` over mDNS
    with its network id in the TXT record. The pairing payload also carries its
    addresses, so a client that cannot use mDNS still connects. Both carry
    only private addresses, so a machine with none (a cloud VM) advertises
    nothing and is reached through Cate Connect. One rule holds on every
    machine; the cost is that a LAN with only global IPv6 addresses falls
    back to Cate Connect too.
  - **Cate Connect**: the runtime listens on the LAN exactly as for same
    network (private addresses only), and also keeps a registration with the service, so a device on
    the same network still connects directly. A client asks the service for the runtime; the service relays the WebRTC
    offer, answer and ICE candidates, and a STUN server lets both sides find
    their public address. Client and runtime then talk over a WebRTC data
    channel. The service hands both sides the session's ICE servers: STUN
    and its TURN relay, with credentials of their own per session (below).
- **The client side** of every transport is shared, pure code
  (`runtime/{transports,security,pairing,connect}/client`) that each shell
  runs behind one port, `ShellTransports` (`dialLocal`, `dialMachine`,
  `dialNetwork`, `pair`), next to its device key. The desktop runs it in
  main (Node sockets, ssh and wsl.exe, WebSocket, mDNS, and WebRTC through
  `node-datachannel`) and hands the renderer each connection as a finished,
  already secured pipe; the iOS core runs it in its web view (WebSocket and
  `RTCPeerConnection`, mDNS from the app). The client core above it sees
  only frames.
- **Relay.** ICE prefers a direct path and falls back to the TURN relay on
  its own when none works (typical on mobile data behind carrier NAT); there
  is no Cate logic choosing between them. The relay forwards only the
  Noise-encrypted data channel, so it is trusted no more than the signaling
  (7.6). Credentials follow the TURN REST API scheme: the username is the
  expiry time (an hour ahead), the credential an HMAC-SHA1 of it under a
  secret the service and the relay share. The runtime logs each session's
  path (`direct` or `relay`) and, when it ends, the bytes it carried. Only
  when ICE finds no path at all, relay included, does the client say it
  could not connect (a firewall in the way, 7.5 failures).
- **Dialing a paired runtime** tries the same network (its stored
  addresses and mDNS), then Cate Connect, whatever endpoints the device
  stored: a device paired on the same network still reaches a runtime that
  turned Cate Connect on later. The pinned key keeps that as safe as a LAN
  dial; a runtime not on Cate Connect just answers `offline`. Pairing tries
  Cate Connect unless the code is for the same network only.
- **Failures explain themselves.** A dial that fails says what each way
  found, in words (`networkFailureMessage` in
  `runtime/transports/client`): on the same network nothing found, no
  answer, or another machine at the address; from Cate Connect the workspace
  not online, the service unreachable, or no path. Each points at what to
  change, such as choosing "Anywhere" for a network that keeps devices apart
  (eduroam, guest and public Wi-Fi). A failed join and the status of a
  paired workspace show it as it is.
- **The runtime's machine checks itself.** A same-network pairing code from
  a machine with a public IPv4 address (its network refuses same-network
  peers) or no private address carries `sameNetworkProblem`
  (`sameNetworkProblem` in `runtime/transports/node`), and Share warns and
  offers "Anywhere" before anyone scans it. A shown code carries the access
  it was made for, so Share makes a new one when the access changes.
- `node-datachannel` (libjuice), the WebRTC of the runtime and the desktop,
  uses TURN over UDP only; the iOS web view also uses TURN over TCP.
- **Paired endpoints follow the runtime.** `runtime.info` carries the
  runtime's current network endpoints; on every connect a client stores them
  with the paired workspace and dials them next time, since a machine's
  private addresses change (DHCP, a WSL restart).
- **Liveness.** A peer that slept or changed networks never says goodbye. The
  same-network listener pings every WebSocket peer every 30 s and drops one
  that missed the previous ping (every WebSocket client answers pings on its
  own). A client checks its connections when the machine wakes (a timer that
  fired late), when the network comes back, and when the iOS app returns to
  the front (`checkAlive`): one that does not answer `runtime.info` within
  5 s is dropped and dialed again.
- **`localhost` on the runtime's machine** (the `tunnel` capability and the
  local loopback dial, 12.3) tries `127.0.0.1`, then `::1`: a dev server
  bound to `localhost` listens on either.

### 7.6 Security

**`runtime/security`** is one layer used by both network transports. Its
`client/` and `runtime/` sides share one pure-JS Noise implementation, and
each shell's transports run the client side (7.5), so the desktop and the
iOS app use the same code.

- **Keys.** Each runtime has a long-lived X25519 static key pair, created on
  first start and stored in `secrets.json`. Each device has one, created on
  first launch and stored in the device's `device-key.json` (`0600`). The
  fingerprint of a key is the first 20 base32 characters of its SHA-256.
- **Handshake.** Every network connection starts with
  `Noise_XX_25519_ChaChaPoly_BLAKE2b`. After it, both sides know the other's
  static public key and every frame is encrypted and authenticated. Frames
  larger than a Noise message are split.
- **Known peers only.** After the handshake the client checks that the
  runtime's key is the one it pinned for that network id and that the key
  derives the id, and aborts otherwise. Pairing checks the key against the
  code instead (below).
- **The opening.** The client's first frame after the handshake says what it
  wants (`runtime/pairing/contract`): `pair` with a code's proof, or
  `connect` by key. The runtime acts on that and on whether the key is in
  `devices.json` (`PairingService.admit`, `NetworkPeers`):

  | Opening | Key paired | Key not paired |
  |---|---|---|
  | `pair` | pairs again (a device that lost the runtime's pin) | pairs |
  | `connect` | serves the protocol | answers the hello with a refusal |

  A `pair` is answered and ends the connection, whatever the answer; the
  device then connects by key. A `connect` has no answer: the protocol's
  frames follow it at once. Anything else ends the connection. Every
  refusal is logged with its reason.
- **Why not transport security alone.** WebRTC's DTLS authenticates whatever
  fingerprint the signaling carried, and Cate Connect does the signaling.
  Running Noise inside the channel with pinned keys means a compromised or
  impersonated Cate Connect can deny service but cannot read or inject
  anything. The same holds for its TURN relay: a relayed session is the same
  Noise channel, so the relay sees only ciphertext, sizes and timing. The LAN WebSocket needs no TLS certificates for the same reason.
- **Before a connection is admitted.** Until its opening admits it, the
  runtime accepts frames of at most 16 KiB, enough for an opening or a
  `hello`, and raises the limit to the default (64 MiB) for a paired
  device's `connect`. It holds at most 32 such connections per transport (so the
  peers anyone can send through Cate Connect never lock out the same
  network), and at most 4 from one remote address on the same-network
  listener; more are closed at once. A connection has 5 s to finish its
  handshake and 10 s to send its opening, and leaves the count once it is
  served or ended. The refusal to an unpaired device names no version. Each Cate Connect session costs a WebRTC peer
  connection before any handshake, so the runtime keeps at most 8 in setup
  at once and ignores more until one opens or times out.
- **Every client is a device.** The workspace's devices are every device
  that has opened it, whatever let it in: one that paired over the network
  (`admittedBy: pairing`), and one that connected as a user of the runtime's
  machine, over the local socket or a machine's bridge (`machineUser`). A
  client's hello names its device key; the runtime adds an unknown key when
  the client connects (only the local socket can bring one: an unknown key on
  the network is refused before its hello) and marks a known one seen. A connection
  that names no key (`cate serve`) is no device. On the local socket the key
  is taken as given: its door is the machine's user, who can already create
  a pairing secret. A device admitted as the machine's user is known on the
  network too, like a paired one.
- **Revocation.** The workspace's settings page lists its devices live
  (`pairing.watch`, so a device paired, connected or removed from another
  client shows at once), with the one viewing marked and those connected.
  Removing one deletes it from `devices.json` and drops its live connections
  on every transport. A paired device stays out until it pairs again; one
  admitted as the machine's user is added again when it next connects, since
  its door is still open. A device can forget a workspace, which deletes its
  pinned key.
- **After connecting**, a client has full access (D3). The runtime knows which
  device each connection is (its key and name), which is what
  presence shows and what later permissions would build on.

### 7.7 Pairing and Cate Connect

**`runtime/pairing`**: network access is the workspace setting
`runtimeNetwork` (`off`, `sameNetwork`, `cateConnect`). `cateConnect` means
the LAN listener plus the Cate Connect registration; `off` closes the
listeners and drops every network connection. Turning it on is done from a
connected client or by `cate serve`, which refuses to run inside a Cate
terminal (`CATE_TOKEN` or `CATE_SOCKET` set): there, whatever drives the
terminal could share the computer.

- **Pairing payload.** With network access on, "Share" (12.5) creates a one-time
  pairing secret (10 random bytes, 80 bits, valid for 10 minutes, single use)
  with a random id of 4 base32 characters (which live secret an attempt is
  for; no secret itself) and shows it as:
  - a QR code encoding
    `cate://pair?r=<network id>&k=<runtime key fingerprint>&s=<secret>&i=<secret id>&m=<mode>&a=<lan addresses>`;
  - a pairing code of 36 base32 characters in groups of four (the network
    id, the secret id and the secret), for typing on a desktop. A typed code has no key
    fingerprint and no addresses: the client finds the runtime by network id
    over mDNS or Cate Connect and refuses a key that does not derive that
    id; the proofs below bind the handshake, and 80 bits keep a captured
    proof safe from offline guessing.
- **The `pairing` capability**: `createSecret {mode, acknowledged: true}`
  (for "Share"; refused without `acknowledged`, the person's confirmation
  that whoever joins can use this computer as them; running `cate serve` by
  hand is that confirmation),
  `list`, the `watch` stream, `revoke {deviceKey}`. `pair` itself is an
  opening (7.6), not a capability method.
- **Pair message.** The joining client connects (7.5), completes the Noise
  handshake, and opens with `pair { deviceName, secretId, proof }` where
  `proof = HMAC-SHA256(secret, "cate-pair-client" || handshakeHash)`. The
  runtime answers with `HMAC-SHA256(secret, "cate-pair-runtime" ||
  handshakeHash)`. Each side verifies the other's proof, which binds the
  secret to this exact encrypted session, so a party in the middle learns
  nothing usable. The runtime then stores the device key in `devices.json`
  (replacing the entry of a key already there) and burns the secret; the
  client checks that the runtime key derives the
  network id it paired with and pins the key under it in
  `known-runtimes.json`, refusing another key for an id already pinned. The
  runtime checks the proof only against the secret `secretId` names. A wrong
  proof (`invalid-proof`) or an unknown id (`no-secret`) burns nothing: the
  id is short enough to walk, so burning on a wrong proof would let anyone
  on the network spoil a code, while the 80-bit secret cannot be guessed
  online. Nobody who does not hold a code can spoil another one.
- **Afterwards** the device connects by key (`connect`); no code is needed
  again.
- **No pairing for the machine's user.** A client that reaches the runtime
  over the local socket or a machine's bridge does not pair: it is added to
  the devices when it connects (7.6).
- **Cate Connect** (registry, signaling, STUN, TURN relay) lives in its own repository and
  is deployed separately. This repository holds only its client,
  **`runtime/connect`**: the runtime's registration and connection setup on
  both sides, written against the service's protocol. The runtime registers
  over a Noise connection to the service under its network id; the service
  refuses an id its static key does not derive and keeps no bindings. Even
  if that failed, clients would refuse any key but the one they pinned. Tests run against a
  local stand-in for the service.
- **Pushes.** A service with an APNs key says so when the runtime
  registers. A registered runtime then sends a push (target, sealed payload,
  collapse id) for a paired device and gets its result back (`sent`,
  `unavailable`, `bad-target`, `rate-limited`, or `failed`, also for no
  answer in time). The target is the
  one the device registered (section 7.9, `push`) and only the service reads
  it (`apns:<sandbox|production>:<token>` today); the payload is sealed for
  the device. The service adds only a generic alert and delivers it, at most
  120 per runtime per hour. Pushes therefore need network access
  `cateConnect`.

### 7.8 Protocol

**One way to talk to the runtime.**

1. Clients call typed capabilities and session ops, never `api.call`.
2. The `cate` API serves CLI callers; its handlers call the same
   service functions and session ops clients use, never a second
   implementation.
3. State a client watches across reconnects is a resumable `channelStream`
   (a snapshot, then changes).
4. One input path per resource (a terminal: its `process.attach` stream).
5. Session channels carry JSON only.

- **Frames.** Every transport carries frames: a JSON message, or a binary
  chunk `{streamId: u32, bytes}`. Over the local socket they are
  length-prefixed; over WebSocket and WebRTC one frame is one message (inside
  Noise, section 7.6).
- **Messages.** `hello`, `req {id, cap, method, params, opId?}`,
  `res {id, result | error}`, `evt {stream, data}`, `cancel {id}`,
  `ack {stream, bytes}` (flow control for byte streams). Parameters are named
  objects, never positional arrays.
- **Hello.** Both sides send their `protocol: [major, minor]` and version. A
  client also sends its `clientId`, `device {name, publicKey}` (checked
  against the handshake on network transports) and `features`
  (section 12.2), fixed for the life of the connection. A caller (the CLI)
  sends its token instead (section 14). The runtime also sends its `epoch`,
  new at every daemon start. Same major is
  compatible; a method or stream the other side does not have fails with
  `unsupported`, so additions are always optional. A different major is
  incompatible (7.10).
- **Client identity and op ids.** A client picks a random `clientId` when it
  starts and keeps it across reconnects. Every call that changes something
  carries an `opId = clientId:counter`, and the runtime ignores an `opId` it
  has already applied (it keeps the highest counter per `clientId`), so a
  resent call is never applied twice within one runtime run. The counter
  belongs to the identity, not to a connection or a document mirror:
  reopening a workspace continues it. A resent op whose outcome the runtime
  no longer keeps fails with `duplicate`. The runtime keeps opIds in memory
  only: a call unanswered when it restarted (a new `epoch`) fails with
  `interrupted` instead of going again, except a method declared
  `idempotent` that dedupes itself across restarts (document ops, whose
  counters are in `document.json`).
- **Error codes.** `gone` (the panel or thing no longer exists), `conflict`
  (the write's base is stale), `dirty` (unsaved work; retry with an explicit
  choice), `rejected` (invalid op), `untrusted` (section 9.2), `unsupported`,
  `no-renderer` (section 10.2), `timeout`, `duplicate` (an op already
  handled whose outcome is no longer kept), `interrupted` (the runtime
  restarted while the op was in flight; it may or may not have run).

### 7.9 Host capabilities

Capabilities not owned by a feature module, in `runtime/`:

- `tunnel`: `tunnel.connect {port}` opens a TCP connection to a loopback port
  (`127.0.0.1` or `::1`) of the runtime's machine as a flow-controlled byte
  stream. It backs loopback routing (section 12.3): every connection but
  the local one reaches a port on the runtime's machine only through it (a
  local client is on that machine). It never connects to other hosts.
- `power`: keep the machine awake while a `keepRunningWhile` trigger holds
  (7.4), or for a time a person asks for (`set {duration}`, watched through `subscribe`),
  through a platform helper process (`caffeinate -i -w <pid>` on macOS,
  `systemd-inhibit` on Linux, `SetThreadExecutionState` through PowerShell on
  Windows).
- `push` (`runtime/push`): a paired device registers where its pushes go
  (`target`, opaque to the runtime) and a 32-byte key (`register`,
  `unregister`, `status`; the device is the caller's key fingerprint). Every
  notification event (section 10.4), with the workspace's name and its
  title and body cut to size, is sealed for each registered
  device with ChaCha20-Poly1305 under its key and handed to the Cate Connect
  registration (section 7.7); only the device opens it and decides how to
  show it. One collapse id per panel (`pushCollapseId`, in the contract),
  which clients use for their own banners too, so a push replaces a banner
  about the same agent. Nothing is queued: with no way out a push is
  dropped. A target the service no longer delivers to, and an unpaired
  device, are removed.
- `runtime`: `stop`, `update`, `updateProgress` (where a running update is,
  for a progress bar), `info`, `perf`; the `lifecycle` stream.

Feature capabilities are declared in their module's `contract/capability.ts`,
implemented in its `runtime/` folder and registered by the composition root:
`settings` (kernel/settings), `api` (kernel/api, for client callers),
`pairing` (runtime/pairing), `document` and `presence` (workspace/document),
`workspace` (workspace/lifecycle: info and trust), `file` and `search`
(workspace/files), `vcs` (workspace/repository), `skills`
(workspace/skills), `notifications` (workspace/notifications: the `events`
stream, section 10.4), `process` (services/terminal), `browserData` (services/browser), `agents`
(services/agents), and `session` and `surface` (panels/framework: session
channels, and page operations sent to the driving client, section 10.2). A client lists every capability it proxies
in `RUNTIME_CAPABILITIES` (`src/panels/capabilities.ts`, an index file next
to the panel ones, handed to every connection by the shell's boot), which
fails to compile when a registered capability is missing.

### 7.10 Versions

- The client and runtime compare protocol majors on `hello`: that alone
  decides compatibility, so clients of different releases or builds of one
  protocol (the App Store iOS app, teammates' desktops) share a runtime.
  The runtime also sends its build: the version plus a hash of what the
  install is made of (the sources, bundled skills and the lockfile)
  (`scripts/build-id.mjs`), baked into the daemon bundle and the desktop
  app. A runtime of another build of the same protocol connects as
  `stale` and is fully usable. The desktop restarts a stale runtime into its
  build once per connection, whatever the transport, and only while nothing
  else uses it (`ifIdle`, below) and its machine can get that build;
  otherwise it keeps running as it is.
- Another protocol major answers only `crossMajor` methods. The fix is
  `runtime.update { version, build }` with the client's own
  version and build: the daemon restarts into the install of that build, or
  downloads release `version` from GitHub Releases (checked against its
  `.sha256`) when the build is not on its machine, refusing a release of
  another build. It restarts too when the versions are equal (a stale build).
  A local runtime always finds the install the desktop app made. Updating
  stops the runtime's terminals and agents.
- When nothing else uses the runtime the client updates it without asking:
  it sends `ifIdle`, which the daemon refuses (`dirty`) while another client
  is connected or work runs. Otherwise the workspace's cover shows both
  versions and says what updating ends before it acts (an incompatible runtime
  answers only `crossMajor` methods, so it cannot list them). A runtime newer
  than the app is never moved back to the app's version: the cover asks to
  update the app. The question is asked in that workspace only, never in a
  dialog over the app.
  Concurrent updates to one target share one install; another target fails
  `conflict`.
- While an update runs, the cover shows its progress: the client polls
  `runtime.updateProgress` (also `crossMajor`: the download's bytes, then
  the install) for a progress bar. The client that asked keeps the cover
  through the restart, saying it is restarting, until the new runtime
  answers (or does not within a minute), instead of the offline cover.
- A workspace whose connection is not `connected`, for any reason, is
  covered and inert until it is: the cover names the state and offers its
  fix (retry, or the update question). It covers that workspace only: the
  sidebar notes the state under the workspace's row and stays usable.
- Runtimes never update on their own; a client asks. A local runtime started
  by the desktop app runs the app's build, so it matches the app after its
  next start.

## 8. Settings

Each module declares its settings slice with `defineSettings`, and each slice
has one of two scopes. The rule: a setting about a person's screen, keyboard,
fonts, device or network is a **client** setting. A setting the runtime needs,
or that changes shared state, is a **workspace** setting.

- **Client settings** live in the device's hand-editable `settings.json` and
  apply in every workspace. Custom themes are the `customThemes` key inside
  it. Canvas background images are copied into the device's
  `canvas-backgrounds/`.
- **Workspace settings** live in the workspace data's hand-editable
  `settings.json`. The `settings` capability serves them to every client and
  edits them one key at a time (last write wins), so a change by one person
  applies for everyone. A new workspace starts from defaults.
- Secrets never live in a workspace settings file, which every client of
  the workspace reads. A client setting never leaves its device, so the
  client's own upstream proxy (`browserProxyUrl`) may carry its
  credentials.
- **Composition.** `src/panels/settings.ts` composes the slices every client
  and the runtime share into `WorkspaceSettings` and the shared client
  settings; each shell adds its own client slices (the desktop's in
  `shells/desktop/settings.ts`), so a client never carries another shell's
  settings and the kernel names no feature.
- The settings window has two tabs: Device (the client settings) and
  Workspace (the active workspace's, for everyone connected to it), each
  listing its pages in groups. Each page is one scope and never mixes the
  two; a module with keys of both has a page in each. With no workspace open
  (the welcome screen), only the device pages exist and the tabs are hidden.
  A search spans both.

| Slice (owner) | Client keys | Workspace keys |
|---|---|---|
| Appearance (`kernel/interaction`) | `activeThemeId`, `systemLightThemeId`, `systemDarkThemeId`, `customThemes`, `uiScale` | |
| Editor (`panels/editor`) | `editorFontSize`, `editorFontFamily`, `filesTreeOnOpen`, `filesTreeOpenFileIn` | |
| Canvas (`shells/desktop`) | `zoomSpeed`, `canvasGridStyle`, `canvasBackgroundImagePath`, `canvasBackgroundImageOpacity`, `showWorktreeTerritory`, `snapToGrid`, `placementPicker`, `autoFocusLargestVisibleNode` | |
| Relations (`workspace/relations`) | `savedPanelRelationLabels` (a personal label library) | `panelRelationsEnabled` |
| Terminal (`services/terminal`) | `terminalFontFamily`, `terminalFontSize`, `terminalScrollSpeed`, `terminalContrast`, `terminalCursorBlink`, `terminalOptionIsMeta` | `defaultShellPath`, `terminalScrollback` (kept by the headless terminal), `autoSuspendIdleTerminals` |
| Browser (`services/browser`) | `browserProxyUrl` (the client's own upstream proxy; may hold credentials), `linkOpenTarget` (where clicked web links open on this device, section 12.3) | `browserHomepage`, `browserSearchEngine`, `browserNewTabBehavior` |
| Review (`panels/review`) | `reviewSplitDiff`, `reviewWordDiff`, `reviewWrapLines`, `reviewFullFiles`, `reviewImagePreviews` | |
| Sidebar (`shells/desktop`) | `sidebarTintOpacity`, `showSkillsInWorkspaceOverview` | |
| Notifications (`workspace/notifications`) | `notificationsEnabled`, `notifyOnlyWhenUnfocused` | |
| Machines (`shells/desktop`) | `sshMachines` | |
| Shortcuts (`kernel/interaction`) | `customShortcuts` | |
| Desktop (`shells/desktop`) | `warnBeforeQuit`, `betaUpdatesEnabled`, `disableGpuRasterization` (applies after restart) | |
| Repository (`workspace/repository`) | | `closeWorktreePanelsOnDelete` |
| Runtime (`runtime/daemon`) | | `keepRunningWhile`, `runtimeNetwork` |
| `cate` API (`kernel/api`) | | `cliEnabled`, `cliSkillInstallEnabled`, `cliBrowserReadEnabled`, `cliBrowserControlEnabled`, `cliBrowserPasswordsEnabled`, `cliTerminalReadEnabled`, `cliTerminalInputEnabled`, `cliPanelReadEnabled`, `cliPanelControlEnabled`, `cliEditorReadEnabled`, `cliEditorControlEnabled`, `cliAgentReadEnabled`, `cliAgentControlEnabled` |
| Agents (`services/agents`) | | `agentHookInjection` (a hook mode per agent: `auto`, `on`, `off`), `usagePriceOverrides` (custom model prices for usage, USD per million tokens, by model id) |

## 9. Workspace

A project, served by its runtime.

### 9.1 Document

**`workspace/document`**: the document schema, its ops, and the runtime side
that holds, orders, persists and broadcasts it.

**Schema and reducer** (in `contract.ts`; the pure `applyOp` runs in the
runtime and in every client's mirror, so both apply ops the same way):

```ts
interface WorkspaceDocument {
  panels: Record<PanelId, PanelRecord>      // type, title, worktreeId, type fields
  windows: Record<WindowId, DocWindow>      // 'main' always exists
  canvases: Record<CanvasId, CanvasModel>   // nodes: rect, mini dock tree
  relations: Record<RelationId, PanelRelation>
  worktrees: Record<WorktreeId, WorktreeMeta> // status: creating | ready | removing
}
interface DocWindow {
  id: WindowId; kind: 'main' | 'detached'; dock: DockNode | null
}
```

- Every panel has exactly one placement: a tab in a dock stack of a window, or
  a tab in the mini dock of a canvas node. The placement index is derived,
  never stored twice.
- A canvas panel's record names its `canvasId`. A canvas is created with its
  canvas panel (`addPanel`) and removed with it (`removePanels` removes the
  canvas and the panels on it; the view asks first). A canvas panel cannot
  be placed on a canvas.
- Viewport, zoom, active tab, maximize and selection are client state and
  not in the document (`docs/dock-rules.md`).
- A detached window is shared: that it exists and its dock tree. Its bounds are not in the document; every window's bounds are
  device state. The client that detaches a panel opens the window where the
  person dropped it; another client opens it where it last had that window,
  else where its shell puts a new window.

**Ops** (each carries an `opId`; several can be sent as one atomic `batch`):

| Group | Ops |
|---|---|
| Records | `addPanel(record, at)`, `replacePanel(record, discard?)` (a surface becoming the picked type: same id, the old session is disposed and the new one started), `updatePanel(id, patch)`, `removePanels(ids, discard?)` |
| Placement | `placePanel(id, at)`, where `at` is a tab in a stack (`{to: 'stack', dock, stackId, after?}`), a new stack beside a stack or split (`{to: 'split', dock, beside, side, stackId, splitId}`), a new canvas node (`{to: 'canvas', canvasId, nodeId, stackId, rect}`) or a new detached window (`{to: 'window', windowId, stackId}`). `dock` is a window's dock or a canvas node's mini dock. Placing an already placed panel moves it. |
| Containers | `setSplitRatio(splitId, ratios)`, `setNodeRects(canvasId, [{nodeId, rect}])`, `closeWindow(windowId, discard?)` (removes its panels; the view asks first) |
| Relations | `addRelation`, `updateRelation`, `removeRelation` |
| Worktrees | `setWorktree(meta)`, `removeWorktree(id)` (metadata only; the repository service does the resource work and writes these) |

**Rules:**

- Ops name what they change by id, never by position: "put tab P after tab Q",
  not "set the dock tree".
- The runtime applies ops one at a time in arrival order. An op that names a
  missing id fails with `gone`; `after` naming a missing tab appends. Empty
  stacks, splits, nodes and detached windows are removed by the runtime as
  part of the op that emptied them.
- Unknown panel types are rejected with `rejected`.
- A removal or replacement that would lose a session's unsaved work fails
  with `dirty` unless `discard` names the panel (section 11.2, rule 6).
- Container values (split ratios, rects, record fields) are last write
  wins.
- Rules that need a module above the document are change guards: the
  runtime holds every op, a client's and its own, to each guard
  (`guardChanges`), change by change through a batch, and a change a guard
  names a problem for fails with `rejected`. The composition root fills the
  slot; the relations rule is one (section 9.7). Clients ask the same pure
  rules before proposing, so their mirror rarely has to roll back.

**Runtime side:** holds the document in memory, persists it to
`document.json` (debounced, atomic, through `kernel/state`), assigns each
applied op a sequence number, keeps the last 10 000 applied ops for
reconnects, and broadcasts every applied op to every client.

**Presence** (the `presence` capability): the connected clients (device name
and key, `clientId`, declared features), the panel each one views and
focuses, which client was active last (the `cate` API's targeting reads it,
section 14), and whether the client's app has the user's attention (the
terminal service scans at a background cadence when no client does). Clients
report their own view, focus and attention, and that the person gives
input (throttled; a client in use keeps the workspace running, 7.4);
presence is never persisted.
The client core watches the other clients of each open workspace
(`otherClientsOf` in `client/document`), and each shell shows them: the
desktop as small avatars on the workspace's sidebar row, iOS as an "Also
here" row in the workspace.

### 9.2 Lifecycle and trust

**`workspace/lifecycle`**:

- **Open and close.** Opening a workspace is connecting to its runtime (and
  starting it on this machine if needed). Closing it in a client disconnects;
  the runtime follows `keepRunningWhile` (7.4).
- **Trust** is one decision per workspace, stored in `trust.json`. Until the
  workspace is trusted, the runtime serves the document and files, but runs
  no process at all (terminals, agents, hooks, content search, and git,
  whose config and hooks a repository controls) and applies nothing from `<project>/.cate/`
  (skills); those calls fail with `untrusted`. The gate sits inside each
  runtime that runs processes, not at its capability: the repository runtime
  hands out only a `git` and `gh` that refuse while untrusted, and its status
  monitors read nothing and watch nothing until trust is granted, so an
  in-process caller (a panel session) cannot skip it. Revoking trust ends
  what runs: every terminal's process (and its `CATE_TOKEN`) and the git
  monitors' polling. The
  first client to open an
  untrusted workspace shows the trust dialog once it is connected (an
  incompatible runtime is updated first, 7.10); the answer is
  `workspace.setTrust`. `cate serve` trusts the workspace it serves. Because
  every client is the same, one person's decision applies to everyone.
- The client's workspace list entry (section 12) is written by the client, not
  the runtime.

### 9.3 Canvas

**`workspace/canvas`**: canvas geometry in `contract.ts`: rects, free-slot
placement (finding a rect for a new node), arrangement, and the curves
between two rects that relations draw (`panelConnectionCurve`: the curve as
data, cubic segments and its midpoint, which every shell draws as it is; the
desktop as an SVG path). It imports nothing. The canvas model
itself (`CanvasModel`, `CanvasNode`: nodes with a rect and a mini dock) is
part of the document schema; the reducer only checks its rects, and
placement code (panel creation in the core, each shell's canvas) runs this
geometry over it, snapping to the grid where the shell asks. All of it
treats a record that carries a `canvasId` as one that shows a canvas, never
testing the type name. Each shell draws it
(the desktop: `shells/desktop/ui/client/layout/canvas`).

### 9.4 Files

**`workspace/files`**:

- **runtime**: the `file` capability (reading, writing and managing files
  and folders, watching, granting a path outside the root, importing
  dropped entries, the `buffer` stream of an open file with its save and
  conflict resolution, and the
  `storeDownload` and `storeScreenshot` byte streams that write a client's
  finished browser download to `browser/downloads/` and an annotated
  screenshot to `screenshots/` in the workspace data, `tempDir`, the
  checkout's `.cate/tmp`, and `serveUrl`, which serves a workspace file over
  HTTP on a random `127.0.0.1` port of the runtime's machine behind a random
  token bound to the served file's folder, every request checked against
  that folder (after symlinks) and the path scope, so a browser panel loads
  it through loopback routing, 12.3, and a page reaches only its own folder;
  while the workspace is untrusted, HTML, XHTML, XML and SVG are served as
  plain text, so a page of an untrusted repo runs no script) and the
  `search` capability (file names in the runtime's own process; content
  through ripgrep on the host, which needs trust); path validation against the root, worktree checkouts,
  grants and, read-only, the two folders of the workspace data clients are
  handed (`screenshots/`, `browser/downloads/`, which only the runtime writes,
  through `storeScreenshot` / `storeDownload`); the rest of the workspace data
  (secrets, pairings, ...) is outside the scope; exclusions.
- **Open buffers**: one Yjs document per open file, however many editor
  panels show it. Loaded on first open, saved (`file.saveBuffer`) with the
  hash of the content it was loaded from (a stale hash fails with `conflict`), persisted
  to `buffers/` while it has unsaved edits, dropped when no editor shows it
  and it is clean.
- **External changes**: the watcher reloads a clean buffer, and marks a dirty
  buffer as conflicting; any viewer resolves it with `file.resolveBuffer`
  (reload, keep, or a three-way merge the runtime runs; the editor view
  shows the result).
- **client**: the fs client, the refcounted watch manager, `attachBuffer`,
  which binds a `file.buffer` stream to a local Yjs document, the file tree
  and search models, recent files, and the file-ref resolver (below).
- **Desktop UI** (`shells/desktop/ui/workspace/files`): the file explorer, the search view, the save-path dialog and the
  drop helpers (`takeFileDrop`, `resolveFileDrop`).
- **File refs.** A file handed from one view to another is a `FileRef`
  `{ workspaceId, path }` (text form `cate-file://<workspace id>/<path>`),
  never a bare path: every file drag carries one payload
  (`application/cate-file-refs`, with an optional line), and Copy / Paste of
  files puts refs on the system clipboard. One resolver, `fileRefs`, makes a
  ref usable in a target workspace, the same way for every runtime wherever
  it runs: a ref of the target is its path; a ref of any other workspace is
  copied in through the two runtimes (`readBinary` on the source,
  `importEntries` on the target), never moved. A drop that names no folder
  (a dock, canvas or terminal) copies into the temporary folder of the
  target checkout (`<checkout>/.cate/tmp`, from `file.tempDir`), which also
  holds connected-editor drafts; files from the OS are uploaded the same
  way. Files brought in (an upload, a copy, a move, the temporary folder)
  land only inside a checkout: the runtime refuses any other destination
  (the workspace data, a granted path, a terminal's folder outside the
  workspace) with `rejected`, so no target redirects a drop elsewhere. The explorer moves within its workspace and copies otherwise. There
  are no OS file actions on workspace files (reveal, open in another app):
  they would need the runtime's disk. Save dialogs are the in-app save-path
  dialog over the workspace's files, never a native one.

### 9.5 Repository

**`workspace/repository`**:

- **runtime**: the `vcs` capability (git, `gh` on the host, file web URLs for Open on GitHub, worktrees, PRs,
  merge), git status (one monitor per checkout; clients subscribe), and the
  worktree lifecycle: create and remove as runtime operations that write
  `WorktreeMeta` status ops, and move or close bound panels
  (`closeWorktreePanelsOnDelete`). Once the workspace is trusted it
  reconciles: git worktrees made outside Cate are adopted, and interrupted
  creates and removes finish. Checkouts live under `<repo>/.cate/worktrees/<slug>`; panels bind by
  `worktreeId`.
- **client**: the git status store, the repository flows (worktrees, pull
  requests, branches, switching a panel's checkout) and worktree status
  and pull request fetches. A new panel takes its checkout from the panel
  it is made from, in the client core: `createPanel` takes the worktree of
  the panel it goes `near`, and `inheritedCheckout` (`client/host`, over the
  pure `inheritWorktree`) gives a shell the checkout of the panel it creates
  from.
- **Desktop UI** (`shells/desktop/ui/workspace/repository`): source control view, repository and PR overviews, worktree menus and
  forms, GitHub settings.
- A second identical create or remove joins the running one.

### 9.6 Skills

**`workspace/skills`**:

- **runtime**: the `skills` capability: installs into the workspace's agent
  directories (`.claude/skills`, `.codex/skills`, ... derived from the agent
  registry), the manifest `.cate/skills.json`, the per-worktree mirror
  (`<checkout>/.cate/skills-mirror.json`), the workspace's skill sources
  (`skills/sources.json`), the curated registry and GitHub crawl, and bundled
  skills (`cate-cli`, `cate-theme`) installed from the runtime tarball like any
  other source (once trusted and with `cliSkillInstallEnabled`, into the
  agent directories that exist, never over an edited copy).
- **Desktop UI** (`shells/desktop/ui/workspace/skills`): the skills dialog, the workspace skills tree, skills settings.

### 9.7 Relations

**`workspace/relations`**:

- **contract**: the typed relation graph between panels (`use`, `context`,
  `verify`, `trigger`; each panel type's role in it comes from its
  definition; a type without one, a canvas or a surface, is never a
  relation's end), `relationReach` (the flow from an execution surface up to the
  next ones), `compileRelationContext` over it, which the agents service
  uses for prompt context, and the relation context mode (`once`, `always`,
  `off`: a record field with its one parser). It imports only contracts.
  What a prompt would take is the runtime's own preview
  (`agents.previewContext`); clients never compile it themselves, and count
  connected panels with `relationReach`. The relation rule
  (`newRelationProblem`: both ends take part in relations, no cycle) is
  here too: the runtime enforces it as a document change guard
  (`relationChangeProblem`), and clients ask it before offering a target or
  proposing a relation.
- **runtime**: **connected editors**: an editor connected to an execution
  panel (a terminal)
  shares a working file with the agent (an untitled editor gets
  `.cate/tmp/<id>.md`), autosaves, and is flushed before a prompt is
  submitted (`docs/connected-editors.md`).
- **client**: the relation edits every client makes on its document mirror
  (add or re-point, meaning, its own words, waypoint, remove, context mode),
  the panels a panel can connect to (`relationTargets`), and the edits of
  the personal label library (`savedPanelRelationLabels`: remember, rename,
  forget) over a client's settings.
- **Desktop UI** (`shells/desktop/ui/workspace/relations`): the relation handle, selector and context toggle. Relation drawing
  is in the desktop UI (`shells/desktop/ui/client/layout/canvas`).

## 10. Services

Panel infrastructure used by panels, by the `cate` API and by other services.
Service logic runs in the runtime; the client side is a typed client and UI.

### 10.1 Terminal

- **runtime**: the `process` capability: node-pty, shell resolution, login
  env, activity, ports, cwd (ps/lsof, or `/proc` on Linux), idle suspend, the
  terminal log. A headless terminal (`@xterm/headless` with the serialize
  addon) per PTY keeps screen state and scrollback, so the session serializes
  the screen for any client that attaches and for restore.
- Output fans out to every viewing client as a byte stream with flow control:
  the `process.attach` stream, which starts with the serialized screen (a
  viewer that keeps less scrollback asks for at most its own `scrollback`). A
  terminal view attaches to it directly with the PTY id from its session's
  snapshot; the session channel carries no bytes.
  Input from every viewer goes to the same PTY, as in a shared tmux session.
  The PTY's size changes only through a fit (`process.fit`): a viewer asks
  for the grid its frame holds, and the PTY takes it whole. Attaching,
  hiding or leaving never resizes it. The desktop view fits on every change
  of its panel's grid and from the tab menu; the phone fits when the person
  taps Fit. Every viewer is told the PTY's size (the `size` event) and draws
  the PTY's grid at its own font, scaled down to its frame when bigger, in
  the corner of its frame when the frame holds more.
- **Extension points** (so terminal never imports agents): PTY env
  contributors (the `cate` CLI on PATH with `CATE_SOCKET` and `CATE_TOKEN`,
  agent hook env), output, input, activity and exit observers, launch
  intents (including the restore launch of a restored panel).
- **Links**: `process.links` gives the links on a row of the headless
  screen (web URLs, and paths that name an existing file, resolved against
  the PTY's cwd), so every client finds the same ones. A view names the row
  counted up from the buffer's last line, with the text it shows there:
  views keep different scrollbacks of the same output, and a view behind or
  ahead of the runtime's screen gets nothing for that row (section 12.3).
- **client**: the xterm binding: it writes the serialized screen, then the
  stream, and forwards keystrokes and resizes; and the status store of every
  PTY (ports, cwd, activity; `process.statuses`). Drawing and clicking links,
  OSC 8 hyperlinks (the view's terminal holds them), search, OSC 52
  clipboard and keymaps are view concerns.
- **Consumers**: the terminal panel, the agents service's terminal agents, `cate.terminal.*`.

### 10.2 Browser

A page lives in a webview on a client. Everything else about the browser lives
in the runtime.

One module holds agent control of pages; the browser panel
(`panels/browser`) holds only tabs, URLs, navigation, viewport, the
downloads list and its views, and hands page work to it.

- **contract**: the `cate.browser.*` spec (`contract/api.ts`; its page
  methods are session methods of the browser panel), the page operations a
  session sends its driving client (`contract/surface.ts`: `page.*`), the
  page protocol (observations, actions, results), locators (finding an
  element by the role and name a snapshot shows), the agent cursor and the
  text the CLI prints for observations.
- **runtime**: the `browserData` capability used by the browser panel's
  session (which holds tabs, URLs, navigation state and titles): history,
  bookmarks, saved
  passwords (in `secrets.json`), downloads (the client uploads each finished
  download to `browser/downloads/` with `file.storeDownload`, so agents find
  it) and uploads (moved from the host to the client for a file input).
  **Page control** (`createPageControl`): the `cate.browser.*` page methods
  of one panel, built by its session over a port (its tabs, `withSurface`,
  the agent cursor); it binds each call to the active tab and picks the
  saved login for `login`.
- **desktop**: the webview, one partition per workspace
  (`persist:ws-<runtimeId>`, cookies are per device) routed through loopback
  routing (section 12.3), the **page ops** (`desktop/renderer`: a `page.*`
  request run on the guest the panel's page host has ready, staging a
  file input's uploads on this client and returning the person's focus),
  the **page driver** (the CDP engine: accessibility
  snapshots, actions, screenshots, waits, file choosers and uploads, the
  page's console and network log, locators), the guest preload, the password
  autofill bridge, JavaScript dialogs, and **passkeys**.
  A page whose script never yields answers no CDP command: after 10 s its
  calls fail with `browser-page-unresponsive`, and reloading or navigating
  the tab restarts its renderer.
  A guest's `alert`, `confirm` and `prompt` wait on desktop main through the
  guest preload (Electron shows none itself); the panel shows the dialog and
  an agent may answer it (`cate browser dialog`). An agent's `login` needs a
  CLI opt-in (`cliBrowserPasswordsEnabled`, off by default) on top of browser
  control: the
  runtime picks the one saved login for the page the driving client shows
  and hands the credential to the page driver, never to the agent. Its
  `signup`, behind the same opt-in, has the runtime generate a password,
  the driver fill it into the sign-up form's empty password fields, and the
  runtime then save it as the login for the username the agent names. The driver
  fills it only while the page still shows the login's origin. Passkeys are
  never stored by Cate: the native addon calls the OS, which keeps them in
  the user's keychain. It needs the signed app's entitlement, a window and
  macOS, so the desktop shell declares the `passkeys` feature only on macOS.
- **Every client loads the page itself.** `localhost` pages come from the
  runtime's machine through loopback routing, a typed path or `file://` URL
  is a workspace file the session turns into its `file.serveUrl` URL (never
  the client's disk; the page reaches only its own folder, and shows as
  text while the workspace is untrusted, 9.4), everything else from the
  client's own network, so a URL means the same page on every client.
  Navigating in any client changes the session's URL, and every client
  follows. What lives inside the page (scroll, form input, login cookies) is
  per client.
- **Own tab, shared target.** Each client shows its own tab. The session's
  active tab is the one the last selection named (a person's tab click, a
  new tab, a `cate.browser.*` call): it is what page operations act on, and a
  person picking another tab cancels page work bound to it. A client follows
  only its own selections and callers' ones, never another client's; the
  driving client shows the active tab while a page operation runs.
- **Tabs for agents.** Tabs have short handles unique in their panel (`t1`,
  `t2`, never reused) and remember who opened them: the person, a page of
  another tab (`window.open`, target=_blank, which becomes a new tab of the
  same panel and is shown), or a `cate` caller. Each `cate.browser.*`
  session result carries `notices`: what happened to the tabs since the
  caller's last call (a page opened a tab, the person switched or closed
  one), so an agent learns of a popup from the call that caused it, and of
  a person's tab switch before it acts. A call bound to a tab that stopped
  being the active one fails with `browser-tab-changed`, which says why.
- **Shared passwords, own sessions.** The runtime remembers passwords, so any
  client can autofill them; each client keeps its own logged-in session.
  Importing Chrome passwords into a runtime the client's connection does not
  put on its own network (`reachesClientNetwork`) asks first: they are stored
  on that machine.
- **The driving client.** Each panel definition lists its page operations
  and the client feature each needs (`surface.ops`: browser `page.*` needs
  `pageDriver`). An op
  runs on the connected client with that feature that most recently showed
  or used the panel, or else the most recently active client with it. The runtime never asks
  what kind of client it is, only which features it declared. On the client,
  one registry in `client/host` (`registerSurface`) holds every view's
  handler and mounts a panel on demand while an operation waits. With no
  such client connected, page operations fail with `no-renderer`.
- **Consumers**: the browser panel, `cate.browser.*`.

### 10.3 Agents

Owns the agent vocabulary of section 2. All of it runs in the runtime.

- **contract**: the `AGENTS` registry. Each `AgentDef` declares its CLI
  (`command`, `resume`, `sessionStore`, `promptArgs`, `interruptKeys`), its
  skills targets, process matching and prompt-context hooks; its hook spec is
  `AGENT_HOOK_SPECS`. Per-agent tables are total `Record<AgentId, …>` (an
  agent without an entry says so with `null`), so a new agent is a compile
  error until every table has it; a reader only some agents need (their
  approval config) is the exception. Also the session,
  the start launch command, and the `cate.agent.*` API specs.
  `PanelAgentState` carries what views show (`label`, `contextPolicy`),
  computed in the runtime. Recorded changes reach consumers
  resolved to the panels that showed their session (`panelIds`); they never
  see terminals.
- **runtime**: one entry, `createAgentsRuntime`, the only owner of agent
  state. It builds the core (with the terminal agents) and the starter; other modules
  call only `start`, `send`, `busy`, `changes`, `readiness` and
  `onSessionEnded`, and the composition root takes its capability and
  `cate.agent.*` handlers. It publishes notification events through a port
  it is given.
  Inside:
  - hook bridges and repo hook files (per `agentHookInjection`), hook
    ingestion and normalization, pid presence;
  - the **status** state machine, driven by hook events, pid presence (or
    the process alone for a CLI without hooks), the input the runtime sends
    to the PTY (for a CLI with no hook for an approval reply), and the
    transcript where a CLI pushes no hook for a user's interrupt; there is
    no screen scraping;
  - approval detection per agent (whether it is asking for a permission),
    and the tool steps its hooks report, kept in memory and sent with the
    conversation;
  - change history per checkout (from terminal hooks) in
    `agents/changes/`;
  - session store readers per agent, conversation reads;
  - resume stamps, persisted in `agents/stamps.json` with the checkout each
    was taken in: a restored terminal panel spawns with the terminal
    service's restore launch, which the terminal agents resolve to the
    stamped session's resume command;
  - live conversations (the `conversation` channel): one watch per panel
    reads the conversation together with the agent's state, so a turn that
    ended goes out with its reply; it looks again on every state change and
    while the agent works, reading the store only when its files moved, and
    sends the messages from the first one that changed, with the panel's
    prompts on their way as they change;
  - the **prompts** on their way to each panel's agent (`prompts.ts`), in
    memory, since the agents run in this process. Every prompt takes one
    path, `sendToAgent`: `cate agent send`, the capability's `send` (every
    client) and other modules (the review). It refuses only when nothing
    could ever take the prompt (no agent, one still starting, untrusted,
    invalid attachments) and otherwise answers at once with the prompt's id;
    a busy agent is no refusal. From then on the runtime alone owns the
    prompt, so no caller guesses its fate from the transcript, and its
    outcome is state every caller observes: the conversation channel, and
    the `prompts` of `cate agent list / read / wait`. Each has a runtime id,
    its text and attachments and a state: `queued` (in order, first in
    first out), `sending` (typed, waiting for its turn to start; one at a
    time) or `failed` (typed and no turn started within the confirm window,
    with the error). The first queued prompt goes out when the agent can
    take one, nothing is on its way and no prompt failed, with no caller
    connected; refused before it was typed, it waits again first in line.
    A failed prompt's text may still be in the CLI's input, so nothing more
    is typed into it until a turn starts (someone pressed Enter: the input
    went with that turn) or it is withdrawn (`withdraw`, which also takes
    back a queued prompt, with its text and attachments). A prompt that was
    taken is gone: the conversation shows it. A panel whose agent is gone
    loses its prompts. `cate agent wait` waits for an agent at its prompt
    with its prompts gone out, or one failed;
  - the panel states (`panels.ts`): what each terminal panel hosts, with
    when relation context last went with its prompt, published as changes;
  - prompt context from relations, and agent notification events;
  - **usage** (`usage/`, the `usage`, `refreshUsageRates` and `usageLimits`
    methods): what the agent CLIs used in this workspace. Each session store
    declares where its CLI records usage (`AgentSessionStore.usage`):
    append-only transcripts with a line parser (Claude Code, Codex, Grok),
    a store queried per window (OpenCode), or none, with a note on
    what it keeps instead (Kiro's credits, Cursor). The engine reads them
    all with no per-agent code, keeps the records whose session cwd is the
    root or under it (its worktrees), drops repeats, and prices and buckets
    them by day or hour: a custom price, else a cost the CLI recorded, else
    LiteLLM's rate (`agents/usage/model-rates.json`, refreshed daily), then
    totals them per agent, model and period with their shares.
    Transcripts are cached per file with the parser's state, so a file
    that grew is read from where the last scan stopped
    (`agents/usage/scan-cache.json`). A store may also probe its CLI for the
    account's subscription limits without a prompt (Claude Code's
    `get_usage` control request, `codex app-server`'s
    `account/rateLimits/read`); the report carries what each window has
    left and its pace against the clock.
- **Starting an agent** (`cate.agent.start`): its CLI, with or without a
  first prompt, in a new terminal panel (a hook-ready agent, launched in
  place of the shell) or an idle one the caller names, in the
  caller's checkout, an existing worktree or a new one, next to the calling
  panel or where the call places it. Panels and worktrees come through ports
  the composition root fills. Once
  started it is an agent panel like any other: `cate.agent.*` reads,
  prompts and interrupts it by its panel. `types` lists the agent CLIs and
  whether each can start in a terminal here. The review panel starts its
  reviewers the same way (`start.ts`).
- **terminal agents** (`terminal.ts`): plug into the terminal service (hook env on PTY spawn,
  status, resume, prompt submission into the PTY, interrupt with the CLI's
  own key).
- **client**: the agent panel states mirror, an agent chat
  (`watchAgentChat`: the conversation channel mirrored across reconnects,
  shown as the runtime says, with its prompts on their way; prompts are
  sent and withdrawn through the capability), and a workspace's
  usage and limits reports, kept per workspace and window
  (`createUsageReports`).
- **Desktop UI** (`shells/desktop/ui/services/agents`): the changes pill, activity title, logos, hook settings, the
  relation context transport (`useAgentContextTransport`), and the usage
  overview (the Usage overlay, `openUsage`): cost, tokens and limits of the
  shown workspace, with its custom model prices.
- **Consumers**: the terminal panel, review (changes), sidebar and dock
  tabs (status), `cate.agent.*`.

Dependencies point one way: `agents → terminal`. Terminal never imports
agents.

### 10.4 Notifications

`workspace/notifications` owns notification events (a kind, the panel,
a title and a body: an agent needs input or a permission, or a
`runtime.warning` the runtime raises itself). Agents publish through the
runtime side (`publish`), and the composition root keeps (`keep`) a warning raised before any client
was there, such as a state file `kernel/state` quarantined; clients follow
the `notifications` capability's stream, and the composition root hands
every event to push delivery for devices that are away (section 7.9).

Every client consumes them the same way, from the client side:
`attachNotifications` (one subscription per open workspace) feeds a
`createNotificationGate`, which waits a moment for a newer event or a
cancel and then shows one only when the client's notification settings
(`notificationsEnabled`, `notifyOnlyWhenUnfocused`, a shared client slice)
and its own focus allow; each shell gives the gate its `show` (the desktop:
an OS notification or a toast; iOS: a banner through the app). When a
panel's agent works again (`onAgentsWorking`, `services/agents/client`),
the pending event for it is cancelled.

## 11. Panels

### 11.1 Framework

`panels/framework`: `definePanel`, `PanelSession`, the session host, the
panel registry and factory and the surface broker (runtime), `createPanel`,
records, session persistence. The client core half (`createPanel`, close
guards, actions) is `client/host` (section 12.1). Views are each shell's own:
the desktop's are `shells/desktop/ui/panels/<type>/`, the iOS app's are in
`ios/`.

Each panel type is one folder, `panels/<type>/`:

- `definition.ts`: pure. What the type is (label, icon **name**, tint, sizes,
  flags), its record
  fields, its session channel schema (snapshot, changes and ops), its
  `cate.<type>.*` API spec, `create(options, kit)`, and the hooks generic code
  asks instead of branching on the type: `checkoutPath`, `ownsKeyboard`,
  `claimsShortcuts`, `commands` (actions of the focused panel, each a
  session op to send, with the features it `requires`), `creation` (how
  people create one: its order in every creation menu, the default key of
  its "New" action, a canvas toolbar button, whether it is created in a
  checkout), `opens` (what generic "open" actions create it for: a file, a
  folder, a URL), `describe`, `chrome` (dock chrome flags), `relation` (its
  role in the relation graph, section 9.7), plus flags such as `surface`,
  `placeholder` (the surface picker), `navigable`, `canLiveOnCanvas` and
  `switchesWorktree`.
  The daemon imports definitions, so they hold no components and no functions
  that touch a session object.
- `contract.ts` and `contract/`: the snapshot and op types, the API spec
  (`contract/api.ts`), a settings slice or a capability where the type has one.
- `session.ts`: the runtime session, a `PanelSession` subclass. All
  behaviour, the snapshot, the op handlers and the session's `cate.<type>.*`
  handlers.
- `runtime.ts`: what the daemon needs to register the type: the definition
  and a session factory over the services it takes as deps, plus any service
  `cate` handlers or capability of its own.
- `client/`, where the type has client core logic of its own (what a shell
  needs to drive it beyond its session channel).
- `desktop/`, where the type has desktop-only code that is not UI (the
  browser's page host).
- `parts/`: supporting modules, split by side (`parts/runtime/`, pure files
  at the top). No UI.

The type's views are not in its folder. The desktop view is
`shells/desktop/ui/panels/<type>/`: it renders the snapshot, sends ops, holds
one-shot intents, asks the user before destructive ops (registering a close
guard with `registerPanelCloseGuard` where closing can lose work), and owns a
native surface where the type has one. The desktop renderer imports every
view and maps each type to its view. The iOS app draws every type with its
own SwiftUI views over the core's panel API (`panel.*` and the type's own
calls in `shells/mobile/contract.ts`).

Three of the index files at the top of `src/panels/` list the types, so no
generic code names one (`capabilities.ts` and `settings.ts` list
capabilities and settings slices):

- `definitions.ts`: `PANEL_DEFINITIONS` (every definition, pure; clients read
  it for actions and creation menus (12.4), the surface picker and fresh
  records).
- `runtime.ts`: `PANEL_RUNTIMES`, one entry per type adapting the daemon's
  services to the type's `runtime.ts`; the composition root imports it.
- `api.ts`: `CATE_API`, every `cate` API namespace; the daemon's router and
  the CLI both read it.

Adding a type is its folder, its name in `PANEL_TYPES`
(`workspace/document/contract`), one entry in each index file that applies,
and a view in each shell that shows it. No generic code branches on
`panel.type`.

### 11.2 The panel contract

Every panel type meets the same contract.

1. **The session owns the panel, and the session runs in the runtime.** It
   owns all live execution and state and keeps working with no client
   connected. Constructors have no side effects; work starts in `start()`.
   Sessions persist their own state to `sessions/<panelId>.json` through the
   kit. Removing a panel sets its file aside in `sessions/removed/` (pruned
   after a day at start); a panel added again under that id (undo) starts
   from it.
2. **Views render snapshots and send ops.** A snapshot is plain JSON (no
   class instances, no `Map`). A view talks to its session channel through
   the session handles of `client/host` (`acquireSession`); in the desktop UI
   `PanelSessionBoundary` is the only place a view attaches to it. A
   connection shares one channel per panel and closes it a while
   (`SESSION_LINGER_MS`) after the last handle is released, so the next view
   of the panel starts from its snapshot. Where a
   service already serves the stream a view needs, the view attaches to that
   stream directly, named by its snapshot: the terminal view to
   `process.attach` (the PTY's bytes) and the editor view to `file.buffer`
   (the file's Yjs updates). The session channel stays JSON.
3. **One set of operations.** UI, other sessions and the `cate` API call the
   same typed session ops. Sessions may send document ops.
4. **Native surfaces.** The one thing a session cannot hold is a native
   surface (a webview). Operations that need it run through `withSurface()`,
   which reaches the driving client (section 10.2), chosen by client feature.
5. **Records are state, never commands** (section 5). One-shot intents (reveal
   a line, focus) are client state in the view.
6. **Only views reach the user, and only through `ClientUi`.** Dialogs,
   confirmations, errors, pickers, notifications, clipboard and external links
   go through the port. A view asks its user before it sends
   the op and passes the answer in the op (`close {discard: true}`,
   `saveAs {path}`). Sessions never ask: an op that would lose work without
   an explicit choice fails with `dirty`. `cate` API callers pass the same
   choices as arguments. Each shell installs its own `ClientUi`. Closing
   panels (`closePanels` in `client/host`, from a tab's close button, a window
   closing) runs the close guard each type's view registered, with a session
   handle whether or not the view is mounted, and then sends one
   `removePanels` op carrying the panels the user chose to discard
   (`removePanels {ids, discard}`; `closeWindow` likewise). The runtime asks
   every session in the removal set (`closeBlocker`, which sees the whole
   set, so two editors of one dirty file closing together count as losing
   it) and refuses a removal that would lose work outside `discard` with
   `dirty`, whichever client or undo sent it. Sessions keep no discard
   state between the question and the removal.
   `clientUi.contract.test.ts` fails on a native call outside the port and on
   any `clientUi()` call in a session or runtime file.
7. **Explicit lifecycle.** A session is disposed only when its panel is
   removed (`removePanels`) or replaced (`replacePanel`). Ops that arrive for
   a removed panel fail with `gone`.

### 11.3 Panel types

| Panel | Session built on | Session state (snapshot) | View | Notes |
|---|---|---|---|---|
| terminal | services/terminal, services/agents | pty status, title, cwd, activity, exit; screen as serialized stream | xterm | shows agent sessions (their state comes from the agents service's panel states, not the snapshot) |
| browser | services/browser | tabs, URLs, titles, viewport preset, navigation state, loading, downloads | webview | each client loads the page itself; page zoom is per client |
| editor | workspace/files, workspace/relations | file, dirty, conflict and whether its diff is shown, connected draft, reveal; buffer as Yjs stream | Monaco (y-monaco) | one buffer per file; three-way merge; source or markdown preview is per client; the open file is session state (the record's `filePath` mirrors it, and a record change never switches it) |
| review | workspace/repository, services/agents | source (git diff or agent changes), file list, notes, agent review, status, reveal | diff views | filter, focused file, collapsed and expanded files and context lines are per client |
| canvas | workspace/canvas | none; renders its canvas from the document | the canvas view (`shells/desktop/ui/client/layout/canvas`) | cannot sit on a canvas |
| surface | framework | none | picker | becomes the picked type through `replacePanel` |

## 12. Client

The client core: everything a desktop app or the iOS app needs that is not
drawing, with no Electron, no Node, no React and no DOM. It holds the
runtimes' state as the client sees it, device state and client state, and
runs the client's logic. Each shell draws it with its own UI (section 15):
the desktop shell in React, the iOS app in SwiftUI over the core running
headless.

### 12.1 Modules

- **`client/core`**: the one entry every shell calls, `startClientCore`, with
  its transports, device, declared features, device store and the panel and
  capability lists. It registers the panel definitions and the client
  identity, fills the runtime slot, opens the connections, and attaches
  documents, sessions (`attachSessions`) and page operations
  (`serveSurfaces`) itself. A shell fills only the UI slots of `client/host`
  (section 3).
- **`client/connections`**: one connection per open workspace runtime over
  the shell's transports (`ShellTransports`, section 7.5): the typed
  capability proxies, session channel subscriptions, reconnect with backoff
  (also when the machine wakes),
  the "offline" state (last-seen time, retrying in the background) and the
  "stopped" state (stopped on purpose, no retrying until started again);
  `eachConnection` runs something per open connection.
  Each connection implements `dialLoopback(port)` (section 12.3).
  `connectionStatus(state, {startsRuntime})` is the one table of what a state
  means and what can be done about it, which every shell shows: a title, a
  message without socket paths, errno codes or timings, and its remedies,
  main one first (try again; start again, only where the transport starts the
  runtime; close the workspace; pair again
  after a refusal of this device; open the workspace a folder is nested in;
  resolve an update). A folder that is gone says so and offers closing it.
- **`client/workspaces`**: the device's workspace list, the workspaces open
  on this device: local ones, ones on machines (`{machine, root}`), paired
  workspaces and their pinned keys (`known-runtimes.json`) and the machine
  name their runtime reports (`runtime.info`), sidebar order. A workspace
  is in it from opening until closing, across restarts; closing one
  disconnects it and drops it (a paired one with its pinned key); the machine
  each workspace lives on (`machineOf`, `groupByMachine`) for lists grouped
  by machine;
  joining with a code (`joinWorkspace`); and the trust question
  (`trustStore`, `openTrusted`): opening an untrusted workspace queues one
  question, every shell shows its head, and
  the answer is `workspace.setTrust` for everyone. Opening is one flow
  (`opening.ts`): connect, receive the first document, settle trust; until
  then the workspace is `opening` (`workspacePhase`), and a shell shows its
  windows only once it is `ready`, never an empty document or a layout the
  trust answer takes away.
- **`client/document`**: the client's mirror of each open workspace's
  document, with optimistic ops (section 13.5) and subscriptions, the client
  state store of each workspace (section 5), and presence: what this client
  reports and the other clients it sees. The stores that show records, docks
  and canvases are selectors over it.
- **`client/host`**: the panel side of the core: `createPanel`, panel
  targeting (`pickPanelPlace`, `createPanelFrom`), opening links
  (`openLink`, 12.3), session handles (`acquireSession`), closing
  (`registerPanelCloseGuard` and `closePanels`, which asks every guard before
  one `removePanels` op), focus and reveal, the checkout hooks derived from
  the definitions (`panelCheckoutHooks`) and the checkout a new panel
  inherits (`inheritedCheckout`), page operation handlers
  (`registerSurface`), the action registry and the panel types' actions
  (`registerPanelActions`), and the creation menus (12.4).

Logic a view needs that every shell's view would need too sits in the
`client/` side of its module, never in a view: the browser tab follower (`panels/browser/client`),
the file tree and search models (`workspace/files/client`), and the
repository flows (`workspace/repository/client`: opening a pull request,
discarding a worktree, switching a panel's checkout).

How a shell lays the document out (docks, the canvas view, dragging, windows)
is its UI: the desktop's is `shells/desktop/ui/client/layout` (section 15).

### 12.2 Client features

Clients do not all support the same things. A phone has no windows, may have
no page driver and no passkeys. The contract that says what a client can do is
one closed list of features, `ClientFeature` in
`kernel/rpc/contract/features.ts`.
Features are for the runtime and the core, which serve every kind of client;
a shell's UI knows its own platform and draws what it supports:

| Feature | The client can | Asked by |
|---|---|---|
| `webview` | host web pages in a native surface, with loopback routing (12.3) | the runtime, which serves surface operations only to clients with `webview` or `pageDriver`; the core, which subscribes to them only then |
| `pageDriver` | run page operations on its webviews: accessibility snapshots, actions, screenshots, waits | the runtime, choosing the driving client (10.2) |
| `passkeys` | answer WebAuthn requests through the OS | nobody yet: the desktop shell declares it only on macOS with its native bridge loaded, where the OS answers |
| `windows` | open detached windows | presence; the desktop boot, which installs its window port only with it |
| `canvas` | render and edit canvases | presence |
| `fileDrop` | take files dragged in from the OS | presence |
| `osNotifications` | show OS notifications | the desktop shell, which installs `ClientUi.notify` only with it; the core hands every notification event to the shell's display (10.4) |
| `screenCapture` | capture its own window | the desktop boot, which installs the screenshot port only with it |
| `clipboard` | read and write the system clipboard | the desktop shell, which installs the `ClientUi` clipboard methods only with it |
| `camera` | scan a QR code | nobody yet: the iOS app declares it where it can scan, and its join screen offers the scanner on its own (without one, the pairing code is typed) |

Rules:

1. **Declared once.** The list is closed. Adding a feature is a protocol minor
   version; an unknown feature in `hello` is ignored.
2. **Declared per connection.** A client sends its features in `hello`
   (7.8). The runtime keeps them per connection and shows them in presence.
   Each shell declares what it supports on its platform: the desktop shell
   declares all of them except `camera`, and `passkeys` only on macOS; the
   iOS app declares `webview`, and `camera` where it can scan. Deciding the
   set is the only place a shell looks at its platform.
3. **Asked, never inferred.** Core code asks `clientHas(feature)` (the
   action registry asks it for every binding's `requires`); runtime code asks
   the connection; a shell's boot asks its own identity's features before
   installing a port. Nothing shared asks which shell, platform or
   device kind a client is (the no-platform test, section 3).
4. **Each UI draws what its shell can.** There is no shared UI to adapt. A
   shell's UI shows the panel types it has views for; a panel it cannot show
   stays in the document, its session keeps running, and every other client
   still shows it. Core actions and commands that need a feature declare it
   and are not offered where it is missing.
5. **`ClientUi` follows the features.** Port methods tied to a feature are
   optional, and a shell installs only what it declares.
6. **The document never depends on features.** Placement is shared and the
   same for everyone; how a shell draws windows and canvases it cannot open
   is that shell's UI, and sends no op.
7. **The runtime uses features only to choose a client for client-side
   work:** the driving client of a browser panel (`pageDriver`). Everything
   else the runtime sends to every client, and each client handles it within
   its features (a notification event is an OS notification with
   `osNotifications`, an in-app toast without).
8. **Checked.** A test checks that every feature a panel command `requires`
   names a known feature; an action binding's `requires` is typed by
   `ClientFeature`.

### 12.3 Loopback routing

Terminals and agents start dev servers on the runtime's machine, so in the
browser panel `localhost` means the runtime's machine on every client (D10).
This is what makes a shared `http://localhost:3000` the same page for
everyone.
A dev server therefore never needs to listen on `0.0.0.0`: `localhost` is
the runtime's machine on every client.

- **Which hosts.** `localhost`, `*.localhost`, `127.0.0.0/8` (also
  IPv4-mapped, `[::ffff:127.0.0.1]`), `0.0.0.0`, `[::1]` and `[::]`, any port
  (`isLoopbackHostname` in `runtime/tunnel/contract`). The web proxy decides
  on the resolved address: it reads a host as URL parsing does (`2130706433`
  is `127.0.0.1`) and resolves a name first, so a name that resolves to
  loopback is the runtime's machine too, and connects to the address it
  checked.
- **Opening links.** Every clicked link (a terminal's URL, file path or OSC 8
  hyperlink, a link in rendered markdown, a URL opened with the app) goes
  through one `openLink` (`client/host`). A web URL opens in a panel that
  opens URLs, or through `ClientUi.openExternal`; a loopback URL always opens
  in a panel. A link the person clicked or tapped goes through
  `openClickedLink`, which decides from the client's `linkOpenTarget`
  setting (installed by the shell with `installLinkSettings`), asking with
  `ClientUi.promptLinkOpen` where it says so and remembering the answer; a
  shell may force the system browser (Cmd/Ctrl+Shift in a desktop
  terminal). `markdownLinkTarget` reads what a markdown link names, a file
  relative to the markdown file. A file opens in the panel already
  showing it, else in a new one, at its line. A new panel is placed from
  the panel the link was clicked in through `createPanelFrom`, the one
  placement path for a panel another panel opens: on that panel's canvas a
  spot through the canvas's placement picker, in a dock a tab beside it.
  The runtime finds a terminal's links (`process.links`, section 10.1).
  A link runs over rows only where the terminal soft-wrapped it: a newline
  the program wrote ends it, since nothing on the screen tells it from a
  program wrapping its own text (agent TUIs do; a link they break is two
  pieces, as in any terminal). A URL cut short with `…` is not a link.
  Programs that name their links (OSC 8) get them exactly, in the view's
  own terminal (`osc8Target` reads the target); PTYs get
  `FORCE_HYPERLINK=1` so programs that check send them. The iOS app hands
  its taps to the core (`terminal.openLink`, and `links.open` for markdown);
  the core's question waits in its state (`linkPrompt`) for the app to ask.
- **The web proxy.** Each client with `webview` runs one web proxy per open
  workspace and routes that workspace's webviews through it. It supports
  plain HTTP, `CONNECT` (HTTPS) and upgrades (WebSocket, for hot reload). For
  a loopback host it calls `connection.dialLoopback(port)`; for every other
  host it connects directly, or through the client's `browserProxyUrl`. A
  connection whose `reachesClientNetwork` is false (every one but the local
  socket: a machine's runtime is on that machine's network) never reaches
  the client's private ranges: a private, link-local or unique local address
  is refused with `403`, with or without an upstream proxy.
- **The connection decides how.** A local connection's `dialLoopback` opens a
  TCP socket to the port on this machine (it is the runtime's machine).
  Every other connection's (a machine's bridge, the network) opens
  `tunnel.connect {port}` on the runtime (7.9), inside the workspace
  connection. The proxy is the same code for
  both; nothing branches on the transport.
- **Pages are not rewritten.** The URL stays `http://localhost:3000`, so
  origins, cookies and absolute links behave as they do on the runtime's
  machine.
- **Desktop.** The proxy runs in desktop main on a random `127.0.0.1` port.
  The workspace's partition (`persist:ws-<runtimeId>`, shared by its browser
  panels) uses it with
  `proxyBypassRules: '<-loopback>'`, since Chromium never proxies loopback
  otherwise. The proxy requires a random per-launch credential, which the
  shell answers through Electron's `login` event, so other processes on the
  client machine cannot use it to reach the runtime.
- **iOS.** WebKit connects to loopback hosts directly and never through a
  proxy, so there is no web proxy: before a page of the workspace loads a
  loopback URL (any frame), the app listens on the phone's own loopback at
  that port (IPv4 and IPv6) and forwards each connection to the same port on
  the runtime's machine through `dialLoopback` (the core decides which URLs
  are loopback, `loopback.port`; the listener is the native primitive). The
  workspace that asked last owns a port, and its listener closes when that
  workspace closes or disconnects; a listener that failed is tried again on
  the next load. While a listener is open, other apps on the phone can reach
  that port of the runtime's machine too. Pages are not rewritten either. A
  page reaching a loopback port no frame loaded first is not routed.

### 12.4 Actions and menus

Everything a person can ask for by key, menu, palette or toolbar is an
**action**, and every list of them is generated. Nothing names an action or
a panel type in a menu by hand.

- **Declared once, by the module that runs it.** `defineActions` (pure,
  `kernel/interaction/contract`) gives each action its title, default key, icon, key
  policy (no repeat, give way to a text field, a keyboard-owning panel, an
  open overlay or a focused list; run from inside a web page; window-only,
  no native accelerator), its place in the native menu bar (menu, group,
  order, submenu), the context menus it is offered in (`canvas`) and whether
  the palette lists it. `registerActions(specs,
  bindings)` (`client/host`) declares them in the catalog (`kernel/interaction`) and
  binds what each does (`run`, the client features it `requires`, `enabled`
  for a context); every declared action has a binding. The core turns the
  panel definitions into actions (`registerPanelActions`), which a shell
  with keys and menus registers; a shell's UI declares its own (the desktop
  UI: palette, sidebar, canvas and window actions).
- **Panel types bring theirs.** For every definition with `creation` the
  host declares `panel.new.<type>` ("New <label>", its default key, File >
  New); for every `command`, `panel.<type>.<id>`, run against the focused
  panel of the type (and, with `menu`, listed under the type in the Panel
  menu). A new panel type appears in every menu, the palette, the shortcuts
  settings and the toolbar tooltips with no other code.
- **Creation menus** (the canvas menu, the canvas toolbar, a dock's new-tab
  and tab-bar menus, the empty dock, a surface's picker, the relation
  handle, the worktree menu, the palette) list `creatableDefinitions()`:
  the types with `creation` (on a canvas, those that can live on one), in
  creation order. A type
  with `creation.inWorktree` is offered once per ready worktree
  (`creationMenuItems`, `creationPick`); each surface decides only where the
  panel goes.
- **Keys.** The shortcut registry resolves each declared action's binding
  from its default key and the `customShortcuts` client setting (overrides
  by action id; an override of an action no module declares is kept and
  ignored). The window's keyboard matches a press, applies the action's key
  policy and the focused panel's `claimsShortcuts`, and runs it.
- **The native menu bar is a model.** The desktop renderer builds it from
  the catalog (skeleton of roles and groups in `shells/desktop/contract`,
  actions in their groups, current keys, hidden items for keys without a
  visible item, the keys forwarded from web pages) and sends it to main,
  which only renders it. Main names no action.

### 12.5 Opening, joining and sharing

Three nouns, used by every shell: a **machine** is where a workspace's
runtime runs (this device, an SSH host, a WSL distro, or the computer of a
paired runtime); a **workspace** is a folder on a machine; a **device** is
what joins one. Three verbs: **open** a folder on a machine this device
reaches (its own, or one it runs commands on, 7.1), **join** a workspace on
another device with a pairing code, **share** a workspace (who can join and
a code).

- **Open.** One picker (desktop: "Open Workspace…") lists the machines: this device
  (a folder picker), the
  saved SSH machines, the SSH config's hosts and the WSL distros, with adding
  an SSH machine by its command, forgetting a saved one, and joining with a
  code. A machine opens its folder dialog wherever it was picked from.
- **Join.** "Join with a Code" takes the typed code or the `cate://pair`
  link (opening such a link with the app fills it in; joining stays the
  person's click). Pairing again with a known machine names it.
- **Share.** One place sets network access ("who can join": only its
  machine, the same network, anywhere through Cate Connect), creates the
  code (turning on same-network access when it is off) and lists the
  devices. Before every code, the first and each new one (after the access
  changes too), the person confirms inline that anyone who joins can use
  this computer as them; nothing is remembered. Wider access is the person's choice in that place; narrower access
  asks first, since it cuts devices off. The workspace's settings keep the
  same setting and the device list with revoke.
- **Where it lives.** Lists of workspaces group them by machine
  (`groupByMachine`, machine by machine in list order: the sidebar, moving
  to the next workspace) under a header naming the machine. Rows reorder
  within their machine.
- **What a window shows.** One rule (`windowContent` in
  `client/workspaces`): the selected workspace while it is listed, else the
  welcome screen (no workspace at all, or none selected). On every change of
  the list, `reconcileWindow` brings the window's state back to what the rule
  can show (a selection that left gives way to the next open workspace or
  none; a dialog about it closes), and the list closes the connection of a
  workspace removed elsewhere. The welcome screen is one view: the Open
  picker, joining with a code, the actions declared for it and what is new
  in this version.

## 13. Several clients

With the application in the runtime, sharing is the runtime accepting a second
client.

### 13.1 The runtime owns the work

The document, the panel sessions, the workspace settings and all backend
functionality live in the workspace's runtime. Clients render it, and every
client is the same to the runtime. A panel's execution never moves between
clients or windows: a panel in a dock and the same panel on a canvas are one
panel. Joining a workspace never clones the repository onto the joining
device.

### 13.2 Joining

Someone in the workspace shares it (12.5): picks who can join (network
access) and creates a code; the joiner scans the QR (or types the code, or
opens its `cate://pair` link), pairs (section 7.7) and connects. The joiner
receives the document, the workspace settings and presence, and subscribes to
the sessions they view.
The device that opened the workspace on its machine needs no code: it is a
device of the workspace from its first connection (7.6), listed next to the
devices that paired.

### 13.3 Concurrency

The runtime is the only writer. Everything that changes shared state, whether
it comes from a client, the `cate` API or an agent tool, runs in the runtime,
so the runtime orders it and no client ever holds a lock.

- **One queue per thing written.** The runtime runs writes to the same thing
  one after another: the document, each panel session, each file path, each
  repository (git and worktrees) and each state file. Reads, and writes to
  different things, run in parallel (keyed locks from `kernel/state`).
- **Writes say what they are based on.** A file save carries the hash of the
  content it started from; a stale one fails with `conflict` and the person
  who saved decides. Document ops and settings keys resolve last write wins.
- **Work the runtime can't order is detected.** Agents in terminals, git and
  other programs write files directly; the watcher sees it (section 9.4).
- **Slow shared work is visible state.** Creating or removing a worktree, or
  checking out a branch, shows its progress in the document or a session
  snapshot, so every client sees it.
- **Terminals**: every viewer types into the same PTY. **Editors**: one Yjs
  buffer per file, so concurrent typing merges.

### 13.4 What clients receive

- **On connect**: the document with its sequence number, the workspace
  settings and presence. Then every applied document op in order.
- **Sessions**: a client subscribes only to the panels it shows: a snapshot,
  then snapshot changes, plus the terminal byte stream or Yjs updates.
- **Large data** (file contents, diffs, screenshots) is fetched when needed,
  never pushed.
- **On reconnect** the client sends its last sequence number with the
  runtime's epoch it belongs to and gets the ops it missed, or the full
  document if they are no longer kept. Each daemon start has a new epoch, so
  a runtime restarted from a `document.json` older than what the client saw
  (a crash inside the write debounce) answers with the full document. Then
  the client resends its unconfirmed ops; their `opId`s make that safe.
- **Persisted ops.** The runtime also sends the seq of its last
  `document.json` write, and a full document carries `startSeq`, the seq its
  run loaded. A client keeps its confirmed ops until a write covers them;
  when a new epoch's `startSeq` is older than some of them, the restart lost
  them and the client sends them again as new ops.

### 13.5 Optimistic updates

- **Document ops and settings edits apply locally at once.** When the
  runtime's ops arrive, the client rebuilds from the confirmed state and
  re-applies its unconfirmed ops on top. A rejected op is dropped and the
  client shows why if it was the user's action.
- **Clients create the ids** of new panels, nodes, splits, windows and
  relations (`crypto.randomUUID()`), so nothing is renamed on
  confirmation.
- **Drags and resizes** apply locally every frame and send one op when the
  gesture ends. Pan and zoom are client state and are never sent.
- **Resource work waits for the runtime**: saving, git, worktrees, starting
  processes. The UI shows that the work is running, from shared state.

### 13.6 Undo

Each client keeps an undo stack (up to 200 entries) of its own confirmed
document ops with their inverse, computed against the document the op
applied to (`invertOp` in `workspace/document/contract`), and a redo stack
that a new op clears. Undo sends the inverse as a new op. If the inverse names something that is gone or changed
since, that part is skipped: a field, rect or ratio someone else set after the
op keeps their value, and a replaced record that changed since is not put
back. Undo never covers session or resource work.

## 14. Access: the `cate` API

Everything outside the UI that drives Cate goes through one router.

- **Router** (`kernel/api`, in the runtime next to the document): resolves the
  target panel from the document (explicit id or unique id prefix, the
  caller's sticky target, its placement group, the active panel of the most
  recently active client, the only panel of the type) and calls
  the target's session or the owning service. Each method's `target` says
  how far down that list it goes: `explicit`, `sticky` (terminal input and
  review stop at the caller's sticky target) or `auto`. Timeouts come from
  the spec; the CLI reads them from the spec too.
- **Callers and how they reach it**:
  - the `cate` CLI in a terminal: over the local socket (`CATE_SOCKET`),
    authenticated by `CATE_TOKEN`, a per-PTY token that also names the calling
    panel and is revoked when its process exits. Terminals run in the runtime, so this is local on every machine.
  - a client: the `api` capability.

  A caller connection (a hello with a token, no client) reaches only the
  `api` capability; settings, pairing, files, trust and the rest serve
  clients only.
- **Access classes**: each method declares `read` or `control`. The workspace
  settings enable each class per area (the `cli*Enabled` keys; each module
  declares its area with its methods, `defineCliArea`; review shares the
  agents' area; a method may also need a further opt-in area, as
  `browser.login` and `browser.signup` need browser passwords on top of
  browser control), behind the
  `cliEnabled` master switch; they apply to CLI callers. Client
  callers are not gated (D3). These settings keep agents to what the user
  allows through the CLI; they are not a security boundary against programs
  running as the same OS user, which the local transport trusts (D4).
- **Declarations**: each module declares its methods once, in its
  `contract/api.ts`, and `src/panels/api.ts` lists every namespace
  (`CATE_API`). The declaration is the single source for dispatch, permissions, timeouts, CLI
  commands, help and argument parsing:

  ```ts
  defineCateApi('terminal', {
    read:  { access: 'read',    handler: 'session', args: { lines: opt(num) } },
    type:  { access: 'control', handler: 'session', args: { text: str } },
    press: { access: 'control', handler: 'session', args: { keys: str } },
  })
  ```

  `handler` says where a method runs: `service` (a module's runtime side) or
  `session` (the target panel's session). A session method's target is the
  reserved `panelId` argument (`--panel` on the CLI), stripped before the
  session sees its arguments. Browser session methods that need the page
  reach it through `withSurface()`.
- **CLI** (`src/cli/`): a generic engine (`engine.ts`); commands, help and
  argument parsing are generated from the specs, with optional per-method
  output formatting (`format.ts`) and command words (`cli.command`, so
  `panel.target.set` is `cate panel set`). Help is a short reference: the
  namespace `summary`, each method's `summary`, and each argument's `help`
  and default; explanations live in the `cate-cli` skill. `cate help
  <command>` and `cate --version` are the engine's own. The only other
  command that is not an API method is `cate serve` (section 7.1).

| Namespace | Methods | Owner | Handler |
|---|---|---|---|
| `cate.version` | | kernel/api | service |
| `cate.panel.*` | `list`, `close` (`discard` arg), `setTitle`, `target.set`, `target.current`, `target.clear` | workspace/document | service |
| `cate.canvas.*` | `createPanel` | workspace/document | service |
| `cate.ui.*` | `notify` | kernel/api (publishes a notification event) | service |
| `cate.terminal.*` | `read`, `type`, `press` | terminal panel | session |
| `cate.browser.*` | `listTabs`; tabs (`selectTab`, `createTab`, `closeTab`); page operations (`getAXState`, `getScreenshot`, `find`, `click`, `hover`, `setValue`, `typeText`, `pressKey`, `drag`, `upload`, `login`, `dialog`, `console`, `network`, `goto`, `waitFor`, `setViewport`, `download`, ...) | services/browser (`listTabs`, and the session methods about tabs and size: the browser panel) | service (`listTabs`) / session (the browser panel's, page methods through page control) |
| `cate.editor.*` | `openFile`, `active` | editor panel | session / service |
| `cate.review.*` | `inspect`, `complete`, `note.add`, `note.resolve` | review panel | session |
| `cate.agent.*` | `start`, `types`, `list`, `read`, `wait`, `send`, `interrupt` | services/agents (starts panels; resolves panel to agent session) | service |

There is no `cate.panel.focus`: focus is client state. Every browser method
is a CLI command (`cate browser snapshot`, `find`, `click`, `fill`, `type`,
`press`, `drag`, `upload`, `login`, `dialog`, `console`, `network`, `goto`,
`wait`, `viewport`, `tab list|new|select|close`, ...). They act on the
panel's active tab (`--tab` asserts which) and name an element by the id
of the page driver's latest accessibility snapshot, or by `--role` and
`--name`, which must match exactly one element of a fresh snapshot (the
driver waits for it to appear, as a click waits for its element). There is
no code mode and no page evaluation: an agent scripts the commands from its
shell, with `--json` when it parses results.

## 15. Shells

- **`shells/desktop`**
  - **main**: app entry, windows and the window registry, rendering the
    menu bar model the renderer sends (12.4) and context menus, native
    dialogs, notification display, the updater (including installing the
    bundled runtime tarball to `~/.cate/runtime/<build>/`), analytics and
    crash reporting, open path and URL handling, screenshot capture, web
    security hardening and dev feature flags, the webview host, browser
    partitions and the loopback web proxy (12.3), passkeys, window crash
    recovery, theme boot cache, the shell's transports (section 7.5: local
    runtimes found and started, section 7.3, machine bridges, the network
    dialer with Noise and pairing; each connection is a pipe handed to the
    renderer), the device files behind `DeviceStore` and the device key,
    cross-window drags and the drag ghost, a WebGL context budget for
    terminals, the `CATE_PERF` profiler, and the declaration of the client
    features (12.2).
  - **preload**: the desktop IPC for the above only (`window.cateDesktop`,
    typed by `DesktopApi` in `shells/desktop/contract`). No workspace work
    crosses it. Each preload entry bundles self-contained (a
    shared chunk breaks the sandboxed preload), and a test enforces it.
  - **renderer**: boots the client core, installs the desktop `ClientUi`
    and the shell's ports, imports every panel view and maps each type to
    its view, calls `registerWorkspaceViews()`, fills the review and
    agent-changes openers, and mounts the desktop UI. It also runs the
    desktop's own boot concerns: restarting a stale runtime into the app's
    build (7.10), the menu bar model, quit blockers, the splash and the perf
    HUD. Logic another shell would need lives in the client core.
  - **ui**: the desktop UI, all of it, in React, mirroring where each piece
    belongs: the kernel components and theme manager (`ui/kernel/interaction`), panel
    hosting and native surfaces (`ui/client/host`), the dock, the canvas
    view (its view store, nodes, minimap, territory layer), dragging and
    detached windows (`ui/client/layout`), the app frame: sidebar, palette,
    settings, pairing, onboarding, dialogs and the e2e harness
    (`window.__cateE2E`) (`ui/app`), every module's
    views (`ui/<layer>/<module>`) and every panel's view
    (`ui/panels/<type>`). It
    is the only place React, the DOM, xterm, Monaco and the icon sets are
    imported. It draws, takes input and asks the user; logic it needs that
    another shell would need too lives in the client core.
- **`shells/mobile`**: the iOS app's TypeScript side. The app (`ios/`) is
  native SwiftUI; the client core runs headless in a hidden web view
  (`shells/mobile/core`, bundled to `ios/Cate/Core/Web/core.js` by
  `npm run build:mobile`). Two directions cross between them: the bridge
  (`shells/mobile/contract.ts`: what the core asks the app for, native
  primitives only: device storage, the Keychain, mDNS, opening a URL,
  banners and the declared features, plus the core's own lifecycle, its
  state snapshot pushed on every change and stream output with back
  pressure) and the core API (what the app asks the core to do). The core
  side follows the client core's rules: no Node, no Electron, no React; it
  dials with the web view's WebSocket and `RTCPeerConnection`, and the app
  serves it from a `cate-app://` scheme. It starts the client core
  with `startClientCore` like the desktop renderer, and drives the same
  core pieces the desktop views do (the browser
  tab follower, `acquireSession`, the trust question, shown as an alert). Its state carries each
  connected workspace's agents (panel states with what each asked for),
  keep-awake state and this device's push status, and its relations (each
  with its words for its pair, its own label, and its curve on the canvas,
  computed with `panelConnectionCurve` so it is the desktop's) with the
  `panelRelationsEnabled` setting, and this device's saved relation labels.
  The app draws a relation's curve as it comes and computes no geometry of
  its own; while a node is dragged it bends the curve along until the
  document has the node's new place. The
  app shows a workspace the way Cate lays it out: one place at a time, the
  dock (one of its panels at a time) or a canvas (a map of its nodes where
  they sit, its relations drawn between them). On the map a tile moves with
  one `setNodeRects` op (`canvas.moveNode`) and relations are made, given
  their meaning or words of their own, set to a context mode and removed,
  and saved labels renamed and forgotten, all through the core's
  `relations.*` methods over the shared relation edits. Every panel type
  has a native view (terminal, editor, browser with loopback routing,
  review, the surface picker), and worktrees can be switched. The app
  shows each agent of a workspace as a chat (the conversation pushed as it
  changes through `agents.watch`, replies, what it is doing while it works,
  the prompts the runtime keeps on their way: every reply goes through
  `agents.send`, busy agent or not, and shows as being sent, queued in
  order with Edit to take it back into the box, or not taken with Edit and
  Dismiss and a note to clear it from the terminal's input; a taken prompt
  stays on screen until the conversation shows it; stopping its turn;
  permissions are answered in the
  agent's own panel, one tap away), and a
  new agent as an empty chat whose box picks what runs it, started with
  `cate.agent.start` in the dock or on a canvas the person picks. The core
  consumes notification events like every client, through the same gate
  (the app tells the core when it comes to the front, `app.setActive`), and
  hands each banner to the app (`notification.show`,
  `notification.withdraw`); the app registers its
  APNs target for pushes, and a notification service extension opens them
  with the key the app keeps in a Keychain group they share.

Quitting the desktop app closes its windows and connections. Each runtime then
follows its `keepRunningWhile`, so the desktop shell's quit blockers only guard
client-local work (a file drop still importing).

## 16. Persistence

| Where | Files |
|---|---|
| Workspace data, `~/.cate/workspaces/<runtimeId>/` | see section 7.2 |
| Project `<root>/.cate/` | `skills.json`, `tmp/`, `worktrees/`, `.gitignore` (ignores everything but `skills.json`); `skills-mirror.json` inside each worktree checkout's `.cate/` |
| Machine, `~/.cate/` | `runtime/<build>/` (an installed daemon, the program, not state, with its `.ok` marker and `in-use/<pid>` markers), `runtime/current`, `pipe-key` (Windows, 7.5), `ssh/` (on a client device: the askpass helper and ssh's shared connections, 7.1); the `cate` launcher of a scripted install in `~/.local/bin` |
| Client device (Electron `userData`, through `DeviceStore`) | `settings.json` (client settings, custom themes), `ui-state.json` (desktop UI state: minimap corner, onboarding progress, the privacy notice seen, the usage overview's metric and period), `boot.json` (main and detached window bounds, theme boot cache, last workspace), `workspaces.json` (the open workspaces, paired ones included, sidebar order), `known-runtimes.json` (pinned runtime keys), `device-key.json` (`0600`), `canvas-backgrounds/`, `update-state.json`, `install-id`, `analytics-state.json`, `pending-events.jsonl`, Chromium partitions (one per workspace), logs |

Every JSON state file above is written through `kernel/state` (a temporary
file renamed over the old one, fsynced first for the `0600` files: secrets,
devices, push), except the
project's skill manifests: `workspace/skills` publishes `skills.json` and
`skills-mirror.json` once per change with an atomic write of its own, since
they live in a checkout and are never held as live state. The others
(sockets, Yjs buffers, logs, downloads, screenshots, Chromium
data) are written by their owner directly.

## 17. Folder layout

```
src/
  kernel/
    rpc/  api/  settings/  lifecycle/  state/  log/
    interaction/            contract/ (themes, shortcuts, actions, settings)
                            and the client core's ClientUi, catalog and
                            registry
  runtime/
    daemon/                 main.ts (the program), entry.ts and compose/ (the
                            composition root), release, install layout,
                            lifetime, update; contract/ runtime/ node/
                            desktop/ sides
    data/                   workspace data directory, runtime.json, secrets
    transports/             local socket, same-network WebSocket, WebRTC data
                            channel; client, node and runtime sides
    security/               Noise handshake, keys, fingerprints; client and
                            runtime sides
    pairing/                the pairing capability, secrets, codes, QR payload,
                            devices.json; client side: pair, pinned keys
    connect/                Cate Connect client (registration, signaling,
                            pushes); testing/: a stand-in for the service
    push/                   the push capability, sealing, push.json
    tunnel/  power/  generic host capabilities
  workspace/
    document/               contract runtime/           schema, ops, ordering,
                            persistence, presence
    lifecycle/              contract runtime/           open/close, trust
    canvas/                 contract                    model and placement
    files/                  contract runtime/ client/
    repository/             contract runtime/ client/
    skills/                 contract runtime/
    relations/              contract runtime/ client/
    notifications/          contract runtime/ client/   events, the gate
  services/
    terminal/               contract runtime/ client/
    browser/                contract runtime/ client/ desktop/
    agents/                 contract runtime/ client/
  client/
    core/  connections/  workspaces/  document/  host/
  panels/
    framework/              contract runtime/
    terminal/  editor/  browser/  review/  canvas/  surface/
                            (browser and review add a client/ side, browser a
                            desktop/ one)
    definitions.ts  runtime.ts  api.ts  capabilities.ts  settings.ts
                            the panel index files
  shells/
    desktop/{contract,main,preload,renderer}/
    desktop/settings.ts     the desktop's client settings (shared slices plus
                            its own)
    desktop/ui/             the desktop UI (React, DOM, xterm, Monaco): app/,
                            kernel/interaction/, client/{host,layout}/,
                            <layer>/<module>/, panels/<type>/
    mobile/                 contract.ts, core/ (the headless core of ios/)
  cli/                      generic engine (commands from API specs),
                            `cate serve`, the bin/ launchers
  test/                     test support: shared/ (multi-client suites over a
                            real daemon and every transport), the shared
                            workspace harness, fakes (desktop, ClientUi),
                            the vitest log stub, the depcruise test

scripts/                    builds (runtime, tarball, mobile core, build id,
                            skills index), packaging and signing, the
                            install script, agent CLI installs, e2e and perf
                            runners
skills/                     bundled skills (cate-cli, cate-theme)
registry/                   the curated skills index and its sources
native/passkeys/            the passkeys native addon
ios/                        the iOS app: Cate/ (App, Core), Notifications/
                            (the push service extension), Shared/
e2e/                        Playwright end-to-end tests
test/depcruise-fixtures/    files that break a dependency rule, for the
                            depcruise test
docs/                       this document and the design notes it links
```

Each process has one entry: the daemon (`runtime/daemon`), desktop main, the
preloads, the desktop renderer, the CLI, and the iOS app's core
(`shells/mobile/core`). Each entry bundles only its own side of each module. Tests live next to
the code they cover; `e2e/` stays at the root and drives the app through the
client's e2e hooks. The Cate Connect service is not in this repository.

## 18. Working rules

- **Clean cuts.** No migration code, no compatibility layers. A changed name,
  op or persisted format replaces the old one outright; old files are
  ignored, not read or mapped.
- **No shims.** No re-exports from old paths, no deprecated aliases, no
  feature flags that switch between two models.
- **No bridges.** State has one owner (section 5). Code that would only copy
  state between two processes or two windows is a sign the state is in the
  wrong place.
- **Dead code goes**: unused exports, unreachable branches, obsolete tests,
  outdated docs and comments.
- **Checks.** `npm run typecheck`, `npm run lint`, `npm run lint:deps`
  (section 3) and `npm test` run in CI. Tests that guard this document:
  `clientUi.contract.test.ts` (11.2 rule 6), `definitions.test.ts` (every
  definition is valid and every feature a command `requires` is known), the
  document convergence test (several clients sending random ops, dropping
  and reconnecting, end with the same document and no op applied twice), the
  security tests (unknown keys, wrong pairing proofs, a man-in-the-middle
  stand-in for Cate Connect, revoked devices), the preload test (each entry
  self-contained) and `daemon.workspace.test.ts` (a real daemon over its
  socket).

## 19. Open questions

Not decided, and deliberately left open:

- **Browser mirroring.** What an agent does inside a page is visible only on
  the driving client. Whether viewers should later see it mirrored.
- **Carrying settings between workspaces.** Every workspace starts from
  defaults and logs in to providers on its own. Whether a later "copy settings
  from another workspace" or user-wide defaults are worth it.
- **Per-person state and permissions.** Whether some state (docks, trust,
  settings, credentials) should later become per person, and roles for
  connected devices.
- **Runtime footprint.** One Node daemon per open workspace. Whether many
  workspaces need a lighter runtime later.
