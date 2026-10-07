# Cate architecture

This document is the model Cate is built on. It says what every system is,
where it lives, what it owns, and how the pieces talk. Where the code
disagrees with it, the document wins: fix the code, or change the document
first.

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
connection is encrypted and mutually authenticated, and only paired devices
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
| D4 | Every network connection runs inside a Noise handshake with pinned keys; only paired devices connect (section 7.6). The local transport is protected by the OS user (a `0600` socket). |
| D5 | All workspace state lives in the workspace data directory on the runtime's machine. The repository's `.cate/` holds only skills, temporary files and worktree checkouts. |
| D6 | Nothing is shared between workspaces. A new workspace starts from defaults. |
| D7 | Native OS primitives stay in the client's shell (the desktop shell): windows, webviews and the page driver, the loopback web proxy, passkeys, native dialogs, notification display, drag ghost, screenshot capture, the updater. |
| D8 | Clean cuts: no migration code, no old formats read, no shims (section 18). |
| D9 | Clients share one core, not a UI. Every client runs the same client core (connections, the document mirror, client state, panel and action logic; no UI), and each shell draws it with its own UI: the desktop shell in React, the iOS app in SwiftUI. Shared code never draws and never asks for a platform; where the runtime or the core must know what a client can do, it asks for a client feature (section 12.2). |
| D10 | In the browser and chat panels, `localhost` always means the runtime's machine, on every client, routed through the workspace connection (section 12.3). A loopback URL opened from anywhere else (terminal links, chat page links, provider sign-in, a URL opened with the app) opens in a browser panel of the workspace, never in the client's system browser. |

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
- **Work that can outlive the window.** Terminals, agents and T3 threads live
  in the runtime, and a workspace setting decides whether the runtime keeps
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
| **Runtime** | One running daemon serving one workspace. It executes all of that workspace's work: files, git, search, processes, panel sessions, agents, T3, the `cate` API, and holds its state. |
| **Machine** | A computer that runs runtimes. Runtimes on one machine share only the installed daemon program. |
| **Workspace** | A project (a root path) with its worktrees, panels and layout, served by one runtime. |
| **Workspace data** | A workspace's own state directory on the runtime's machine (section 7.2). |
| **Transport** | How a client reaches a runtime: `local` (a socket on the same machine) or `network` (same network, or Cate Connect). A transport never changes what the runtime is or does. |
| **Cate Connect** | A coordination service we host. It passes connection setup messages so a client and a runtime connect directly, and runs a TURN relay for when they cannot. It never sees workspace traffic in the clear and is never trusted with it. |
| **Pairing** | Connecting a device to a workspace for the first time with a QR code or pairing code. Afterwards both sides know each other's key. |
| **Capability** | A typed group of runtime methods and streams (`file`, `vcs`, `process`, `server`, `tunnel`, `power`, ...), declared once with `defineCapability`. |
| **Document** | The shared structure of a workspace: panel records, windows and their dock trees, canvases, relations, worktree metadata. The runtime holds it and orders every change to it. |
| **Op** | One change: a document op (section 9.1), sent by a client, a session or a `cate` API handler, or a session op, sent to one panel session (section 11.2). |
| **Panel session** | A panel's live state and behaviour. Runs in the runtime. |
| **Client** | One running instance of a Cate app (the desktop app, the iOS app): the client core plus its shell's UI. Renders the document and session snapshots of the workspaces it has open. |
| **Client core** | The shared, UI-free part of every client: connections, pairing, the document mirror, client state, panel and action logic (section 12). |
| **Client feature** | Something a client can do that not every client can (host a webview, drive a page, passkeys, ...), from one closed list (section 12.2). The runtime and the core ask for features; a shell's UI knows its own platform. |
| **Device** | The machine a client runs on, identified by its device key. |
| **Shell** | A platform app around the client core, with its own UI and native primitives: desktop (Electron and React) or iOS (SwiftUI). |
| **Service** | Infrastructure more than one panel or caller uses: terminal, browser, t3, agents. |
| **Panel** | A session in the runtime, drawn by each shell's own view: terminal, editor, browser, chat, review, canvas, surface. |
| **Caller** | Whoever calls the `cate` API: the CLI in a terminal, a T3 harness, a browser code cell, a client. |

### Agents

"Agent" means exactly one thing: a provider CLI identity.

| Concept | Meaning | Examples |
|---|---|---|
| **Agent** | A provider identity, static data in one registry (`AGENTS`). | claude-code, codex, cursor, grok, hermes, kiro, opencode |
| **Runner** | How an agent session executes and how Cate observes it. | `terminal`: the CLI runs in a PTY, observed through injected hooks and pid presence. `t3`: the T3 harness drives the provider, observed through T3 orchestration. |
| **Agent session** | One conversation: `{agentId, runner, sessionId, cwd, worktreeId}`. It reports status, takes a prompt, reads its conversation, lists its changes and resumes. | "claude-code in a terminal", "codex in a T3 thread" |

Every agent has the `terminal` runner. The `t3` runner exists for the agents
T3 has a provider for: claude-code, codex, cursor, grok, opencode (not hermes,
not kiro). T3 is never an agent: it is a runner, and the backend of the chat
panel. Only the agents service knows that runners exist; everything else
talks about sessions. The terminal panel shows terminal-runner sessions, the
chat panel shows t3-runner sessions.

## 3. Layers

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ shells     desktop (window host, native OS, React UI) · mobile (iOS core) │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ panels     framework + terminal · editor · browser · chat · review ·     │
 │            canvas · surface                                              │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ client     connections · workspaces · document mirror · host            │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ services   terminal · browser · t3 · agents                              │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ workspace  document · lifecycle · canvas · files · repository ·          │
 │            skills · relations                                            │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ runtime    daemon · data · transports · security · pairing · connect ·   │
 │            host capabilities                                             │
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
  `client/connections` fills it. `client/host` owns the close guard slot
  (`registerPanelCloseGuard`); a shell's panel views fill it.
- **Public entries only.** Across modules, import a module's contract (its
  `contract.ts` or a file of its `contract/` folder) or a side's `index.ts`,
  never its internals. The panel index files `src/panels/definitions.ts`,
  `src/panels/runtime.ts` and `src/panels/api.ts` are public entries too.
- **One composition root.** The daemon's composition root
  (`src/runtime/daemon/entry.ts`, `main.ts` and `compose/`) builds every
  module's runtime side and wires them together, so it is exempt from the
  layer, side and entry rules. Nothing else is.
- dependency-cruiser enforces these rules in CI (`.dependency-cruiser.cjs` at
  the root, run by `npm run lint:deps`).

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
| Agents: hook ingestion, pid presence, change history, session stores, conversation reads, Hermes |
| Agents: status state machine, resume stamps, notifications, driver selection |
| Starting agents: a new terminal or chat panel on a prompt |
| T3 harness lifecycle, provider auth, thread shells |
| T3 state: per-checkout instances, provider profile and secrets |
| Browser data: history, bookmarks, passwords, downloads |
| Browser session: tabs, URLs, navigation state, titles |
| The document: panel records, docks, canvases, detached windows, relations, worktree metadata |
| Panel sessions |
| The `cate` API router |
| The CLI endpoint |
| Workspace settings (section 8) |
| Skills: installs, mirror, sources, registry |
| Trust, granted paths, terminal logs, screenshots |
| Keep awake while work runs |
| Agent notifications (deciding that something happened) |
| Presence: which clients view and focus which panel |
| Pairing, the network transports, the security layer, Cate Connect registration |
| The workspace data directory and the local socket that keeps one runtime per workspace |

### 4.2 In the client

Each row is in the client core (shared, no UI), in a shell's UI, or in a
shell's native side.

| What | Where |
|---|---|
| Rendering the document: docks, canvas view, nodes, minimap, territory layer, relation drawing | shell UI |
| Panel views: xterm, Monaco, T3 client surface, diff views (desktop); native views (iOS) | shell UI |
| Input, drag and drop, drag ghost | shell UI |
| Dialogs, confirmations, notification display, clipboard (`ClientUi`, including the in-app save-path dialog over the workspace's files) | shell UI |
| Webviews, browser partitions, the page driver (CDP), code-cell and guest preloads | shell native |
| Passkeys (macOS `ASAuthorizationController`, needs the signed app and a window) | shell native |
| The upstream browser proxy (`browserProxyUrl`) and the loopback web proxy (section 12.3) | shell native |
| Windows, menus, updater, crash reporting, analytics | shell native |
| Client features (section 12.2) | declared by the shell |
| Client state: viewport, zoom, active tabs, maximize, focus, selection, per-panel view state, undo history, one-shot intents | core |
| Document mirror with optimistic ops | core |
| Connections: finding, starting and pairing runtimes, the security layer, reconnect, loopback routing | core |
| Workspace list, recents, known runtimes, onboarding progress | core (stored through the shell's `DeviceStore`) |
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
- No shared local daemon, no SSH or WSL transport (SSH only sets a runtime
  up on another machine, section 7.1; it never carries a connection), no
  project lock file, no
  reverse tunnel for the CLI, no per-feature IPC between the desktop shell's
  main process and its renderer for workspace work.
- No state shared by the workspaces of a machine: settings, skills, T3 state,
  browser data, trust, grants, agent hooks and agent changes all belong to one
  workspace.
- No remote access of T3's own. Clients reach T3 through the workspace
  connection.
- No skill installed into a user-global agent directory. Bundled skills
  install into the workspace like any other skill (section 9.6).

## 5. State classes

Every piece of state belongs to exactly one class.

| Class | Owner | Examples | Shared with |
|---|---|---|---|
| **Document** | the runtime | panel records, windows and dock trees, canvases, nodes and geometry, node mini docks, relations, worktree metadata | every client of the workspace |
| **Session** | a panel session | terminal screen and scrollback, editor buffer and whether a conflict's diff is shown, browser tabs, URLs and viewport preset, chat thread binding, a review's comparison, notes and agent review, agent status | every client viewing the panel |
| **Resource** | runtime capabilities | PTYs, files, git, agent processes, agent changes, T3 servers | through the runtime |
| **Workspace data** | the runtime | workspace settings, secrets (browser passwords, the runtime key), T3 state and provider logins, browser history and bookmarks, skill sources, trust, granted paths, paired devices | every client of the workspace |
| **Device** | one client device | client settings, workspace list and recents, known runtimes, device key, main and detached window bounds, onboarding progress, per-workspace browser partitions (cookies) | never |
| **Client** | one running client, in memory | viewport, zoom, active tab per stack, the maximized stack of a window and node of a canvas, the tab a browser panel shows and its page zoom, an editor's source or preview, a review's file filter, focused file, collapsed and expanded files and context lines, focus, selection, undo history, open overlays, a drag in progress, one-shot intents (reveal a line), mounted webviews | never |

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
  The one exception is the Hermes plugin, which Hermes only loads from its
  user config; it is installed there by the agents service.

## 6. Kernel

Generic machinery. The kernel knows no feature.

- **`kernel/rpc`**: the runtime protocol (section 7.8).
  - `defineCapability(name, { methods, streams })` declares a capability once,
    with typed named parameters. The daemon serves declared capabilities
    generically; the client side is a generic typed proxy that queues calls
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
  - **The runtime slot**: `useRuntime(workspaceId)` / `runtimeFor(workspaceId)`
    returns the typed proxy of a connected workspace. `client/connections`
    fills it.
  - Framing, version negotiation and error codes (section 7.8).
- **`kernel/api`**: `defineCateApi`, the router and targeting (section 14).
- **`kernel/settings`**: `defineSettings` for a module's settings slice (keys,
  defaults, validation, scope `client` or `workspace`). The `ClientSettings`
  and `WorkspaceSettings` types, the validation tables and the settings window
  are composed from the slices (section 8). Serves the `settings` capability
  for workspace scope.
- **`kernel/lifecycle`**: a bus for `onShutdown`, `onClientConnected` and
  `onClientGone`, so generic lifecycle code never names a feature.
- **`kernel/state`**: hand-editable JSON state files: in-memory authority,
  debounced atomic write, external-edit watcher, corrupt-file quarantine,
  keyed locks. The engine is pure; the files are its `node/` side, used by
  the daemon for workspace data and by the desktop shell for device files. Every state file has exactly one writer process. Client
  core code never touches files: it reads and writes device state through
  the `DeviceStore` port, which each shell implements (the desktop shell with
  these files).
- **`kernel/log`**: structured logging for every process, with the vitest stub.
- **`kernel/interaction`**: the client core's side of interaction, with no UI in it:
  the `ClientUi` port (what the core and a shell's views ask the user), the
  theme schema, the action catalog and the shortcut registry (section 12.4).
  The daemon never imports it. The React components that draw these (buttons,
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
  stable across restarts, names the workspace data directory, and is what
  pairings refer to. Moving the project folder gives a new `runtimeId` and a
  fresh workspace.
- **Install.** One layout everywhere: `~/.cate/runtime/<build>/` holds the
  daemon, its Node, the `cate` CLI, the patched T3 harness, bundled skills and
  native addons; `<build>` is the build id (section 7.10), which the tarball
  carries in its `BUILD` file. An install is never replaced, so two builds of
  one version (a checkout and the packaged app) install side by side and a
  daemon keeps the tree it started in. `~/.cate/runtime/current` names the
  last install made or updated to. The desktop app ships this tarball and
  installs it there on start. On any other machine one command installs it
  (`curl -fsSL <install url> | sh`, checked against the `.sha256` published
  beside the tarball) with a `cate` launcher that runs the current install,
  and `cate serve [path] [--connect]`
  starts the workspace's runtime with network access on (`sameNetwork`, or
  `cateConnect` with `--connect`), marks it trusted, and prints a pairing QR
  code and pairing code. `serve` is a command of the installed runtime, not a
  `cate` API method.
- **Over SSH.** The desktop app sets a runtime up on another machine from
  the client settings page "Remote machines" (machines saved in the client
  setting `sshMachines`). Its main process runs the system `ssh`
  non-interactively (`BatchMode`, so keys and the agent only;
  `StrictHostKeyChecking=accept-new`) and pipes small scripts to the
  machine's `sh -s` (`runtime/daemon/contract/ssh.ts`). For the person it is
  one step; underneath it is two: `ensureRuntime` looks for this app's build
  in `~/.cate/runtime/<build>/` and only when it is missing runs that
  release's `install.sh` (pinned to the app's version, so the build matches);
  `serve` never installs and runs exactly that build's `cate serve <folder>
  --connect --json`. Between them a folder browser lists and creates folders
  over the same SSH. The printed pairing link goes through the ordinary join
  (7.7), so afterwards the workspace is a paired one reached through Cate
  Connect and SSH is not used again, so the machine needs no inbound port
  but SSH. The ssh command line is built in main
  from validated fields (destination, port, identity file, jump host), never
  from text the renderer passes.
- **Pruning.** A daemon started from an install removes installs nothing
  uses: not its own, not the current one, not one a live daemon runs (the
  `build` in its `runtime.json`). Clients never prune. Only release bundles
  prune (built with `CATE_RELEASE=1`, the release workflow); a checkout's
  bundle leaves every install alone.
- **Paths.** Inside the runtime every path is a plain absolute path on its
  machine. Clients know which runtime a path belongs to from the connection it
  came through.
- **Process model.** The daemon is a detached process, not a child of any
  client. Its PTYs, T3 servers and agent processes are its children and live
  as long as it does.

### 7.2 Workspace data

**`runtime/data`** owns the directory `~/.cate/workspaces/<runtimeId>/` on the
runtime's machine. It holds everything in the workspace data class and every
persisted session and document file. It is created with mode `0700`.

```
~/.cate/workspaces/<runtimeId>/
  runtime.sock          the local transport on macOS and Linux; binding it is
                        the lock (7.3)
  runtime.json          { runtimeId, root, pid, version, build, protocol, endpoints }
  document.json         the document (9.1)
  sessions/<panelId>.json   persisted session state
  buffers/<hash>.bin    unsaved editor buffers (Yjs updates)
  settings.json         workspace settings (hand-editable)
  secrets.json          0600: browser passwords, runtime key pair
  pairings.json         paired devices: public key, name, paired at, last seen
  push.json             0600: devices registered for pushes: key fingerprint,
                        delivery target (opaque), the key pushes are sealed with
  trust.json            { trusted, decidedAt }
  grants.json           granted paths outside the root
  skills/sources.json   the workspace's skill sources
  browser/              history.json, bookmarks.json, downloads/
  t3/                   the T3 harness root: instances/<checkout hash>/,
                        provider-profile.json, provider-secrets/
  agents/               hooks/ (hook bridges), changes/ (change history)
  servers.json          pids of the runtime's server children, reaped on
                        the next start
  terminal-logs/
  screenshots/
  logs/                 the daemon's log
```

- **Outside the repository.** A repository controls everything it commits: a
  cloned repo could otherwise ship trust, layout that auto-runs commands, or
  credentials, and `git clean -xdf` would delete logins and passwords.
- `<project>/.cate/` holds only what belongs in the tree: `skills.json`,
  `tmp/` (temporary files: connected-editor drafts and files copied in from
  another workspace or the OS, section 9.4), `worktrees/` (checkouts) and
  its `.gitignore`.
- **Secrets.** `secrets.json` is the only file with secret material Cate owns
  (T3 keeps its own provider secrets in `t3/`). Both are `0600`. There is no
  OS keychain dependency, so the same code runs on a headless Linux machine.
  Protection is the machine user's file permissions.

### 7.3 Finding and starting a runtime

- **The socket is the lock.** A starting daemon removes a stale
  `runtime.sock` only after a connect to it fails, then binds it. Binding is
  atomic: a second daemon for the same workspace fails to bind and exits. The
  OS releases it when the daemon dies. On Windows the socket is a named pipe
  `\\.\pipe\cate-<runtimeId>`, with the same rule.
  A stopping daemon closes its socket before it lets go of the workspace's
  files, so before removing a stale socket a starting daemon waits for the
  daemon that last owned it (the pid in `runtime.json`) to exit. Every daemon
  exits within 5 s of starting to stop, even when a shutdown step is stuck;
  one still alive after that is killed (a reused pid running another program
  is left alone).
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
- **A client on another machine** finds the runtime through the network
  transport (7.5) using the `runtimeId` it paired with.

### 7.4 Lifetime

How long a runtime runs is the workspace setting `runtimeLifetime`:

| Value | Behaviour |
|---|---|
| `stopWhenIdle` (default) | Stops when no client is connected and no work runs (no busy terminal, no running agent or T3 turn), after a 5 minute grace period. |
| `keepRunning` | Never stops on its own. |

A workspace with network access on always keeps running, so it stays
reachable. `cate serve` turns network access on. A stopped workspace is started
by a client on its machine when it opens or restores the workspace.

"Stop workspace runtime" lists the running terminals and agents, asks for
confirmation in the view, and then sends `runtime.stop`. Before its connections
close the runtime tells every client why (`runtime.lifecycle`): after a
deliberate stop each client shows the workspace as stopped and does not
reconnect (or start it) until the person starts it again there; after a crash,
an update or an idle stop clients reconnect as usual. Stopping hangs up every
shell like a closing window (their jobs, background ones included, end), then
kills what is left. Idle suspend inside a running runtime still parks idle PTYs
and T3 servers.

### 7.5 Transports

**`runtime/transports`**. Every transport carries the same frames (7.8).

- **`local`**: the Unix socket in the workspace data directory, or the named
  pipe `\\.\pipe\cate-<runtimeId>` on Windows. Access is the OS user: the
  directory is `0700` and the socket `0600`; the pipe's ACL admits only the
  user. No handshake beyond the protocol `hello`. Used by clients on the same
  machine, by the `cate` CLI in terminals the runtime spawned, and by the T3
  harness. Anything running as the same OS user can connect; that is the
  trust boundary (D4).
- **`network`**, established one of two ways, always wrapped by the security
  layer (7.6):
  - **Same network**: the runtime listens for WebSocket connections on a
    port on every interface (path `/cate/<runtimeId>`), but serves only
    private addresses: `10/8`, `172.16/12`, `192.168/16`, `100.64/10`
    (carrier NAT, which Tailscale uses), `169.254/16`, `127/8`, `::1`,
    `fe80::/10` and `fc00::/7` (`isPrivateAddress` in
    `runtime/transports/contract`). A connection from any other address is
    closed before anything is read. It advertises `_cate._tcp` over mDNS
    with `runtimeId` in the TXT record. The pairing payload also carries its
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
- The client side of every transport is in the client core (`client/`
  side), except the raw socket, which each shell provides (the desktop shell
  through Node, the iOS app through its platform).
- **Relay.** ICE prefers a direct path and falls back to the TURN relay on
  its own when none works (typical on mobile data behind carrier NAT); there
  is no Cate logic choosing between them. The relay forwards only the
  Noise-encrypted data channel, so it is trusted no more than the signaling
  (7.6). Credentials follow the TURN REST API scheme: the username is the
  expiry time (an hour ahead), the credential an HMAC-SHA1 of it under a
  secret the service and the relay share. The runtime logs each session's
  path (`direct` or `relay`) and, when it ends, the bytes it carried. Only
  when ICE finds no path at all, relay included, does the client say it
  could not connect and suggest same network.
- The runtime's WebRTC (`node-datachannel`, libjuice) uses TURN over UDP
  only; the iOS web view also uses TURN over TCP.

### 7.6 Security

**`runtime/security`** is one layer used by both network transports. Its
client side is in the client core (a `client/` and a `runtime/` side over one
pure-JS Noise implementation), so the iOS app uses the same code.

- **Keys.** Each runtime has a long-lived X25519 static key pair, created on
  first start and stored in `secrets.json`. Each device has one, created on
  first launch and stored in the device's `device-key.json` (`0600`). The
  fingerprint of a key is the first 20 base32 characters of its SHA-256.
- **Handshake.** Every network connection starts with
  `Noise_XX_25519_ChaChaPoly_BLAKE2b`. After it, both sides know the other's
  static public key and every frame is encrypted and authenticated. Frames
  larger than a Noise message are split.
- **Known peers only.** After the handshake:
  - the client checks that the runtime's key is the one it pinned for that
    `runtimeId`, and aborts otherwise;
  - the runtime checks that the client's key is in `pairings.json`; if not, the
    only message it accepts is `pair` (below), and it closes the connection
    after one failed attempt.
- **Why not transport security alone.** WebRTC's DTLS authenticates whatever
  fingerprint the signaling carried, and Cate Connect does the signaling.
  Running Noise inside the channel with pinned keys means a compromised or
  impersonated Cate Connect can deny service but cannot read or inject
  anything. The same holds for its TURN relay: a relayed session is the same
  Noise channel, so the relay sees only ciphertext, sizes and timing. The LAN WebSocket needs no TLS certificates for the same reason.
- **Before a key is known.** Until a connection's key is proven paired
  (or pairs), the runtime accepts frames of at most 16 KiB, enough for
  `pair` or a `hello`, and raises the limit to the default (64 MiB)
  afterwards. It holds at most 32 such connections, and at most 4 from one
  remote address on the same-network listener; more are closed at once. An
  unknown key has 10 s to send `pair`. The refusal to an unpaired device
  names no version.
- **Revocation.** The workspace's settings page lists its paired devices
  live (`pairing.watch`, so a device paired or removed from another client
  shows at once). Removing
  one deletes it from `pairings.json` and drops its live connections. A device
  can forget a workspace, which deletes its pinned key.
- **After connecting**, a client has full access (D3). The runtime knows which
  device each connection is (its key fingerprint and name), which is what
  presence shows and what later permissions would build on.

### 7.7 Pairing and Cate Connect

**`runtime/pairing`**: network access is the workspace setting
`runtimeNetwork` (`off`, `sameNetwork`, `cateConnect`). `cateConnect` means
the LAN listener plus the Cate Connect registration; `off` closes the
listeners and drops every network connection. Turning it on is done from a
connected client or by `cate serve`.

- **Pairing payload.** With network access on, "Add device" creates a one-time
  pairing secret (10 random bytes, 80 bits, valid for 10 minutes, single use) and shows
  it as:
  - a QR code encoding
    `cate://pair?r=<runtimeId>&k=<runtime key fingerprint>&s=<secret>&m=<mode>&a=<lan addresses>`;
  - a pairing code of 32 base32 characters in groups of four (the
    `runtimeId` and the secret), for typing on a desktop. A typed code has
    no key fingerprint and no addresses: the client finds the runtime by
    `runtimeId` over mDNS or Cate Connect, the proofs below bind the
    handshake, and 80 bits keep a captured proof safe from offline guessing.
- **The `pairing` capability**: `createSecret {mode}` (for "Add device"),
  `list`, `revoke {deviceKey}`. `pair` itself is the one message a runtime
  accepts from an unknown key.
- **Pair message.** The joining client connects (7.5), completes the Noise
  handshake, and sends `pair { deviceName, proof }` where
  `proof = HMAC-SHA256(secret, "cate-pair-client" || handshakeHash)`. The
  runtime answers with `HMAC-SHA256(secret, "cate-pair-runtime" ||
  handshakeHash)`. Each side verifies the other's proof, which binds the
  secret to this exact encrypted session, so a party in the middle learns
  nothing usable. The runtime then stores the device key in `pairings.json`
  and burns the secret; the client pins the runtime key under its
  `runtimeId` in `known-runtimes.json`. A wrong proof burns the secret too.
- **Afterwards** both sides reconnect by key; no code is needed again.
- **Cate Connect** (registry, signaling, STUN, TURN relay) lives in its own repository and
  is deployed separately. This repository holds only its client,
  **`runtime/connect`**: the runtime's registration and connection setup on
  both sides, written against the service's protocol. The runtime registers
  over a Noise connection to the service, which binds the `runtimeId` to the
  runtime's static key on first registration and refuses another key for it
  afterwards. Even if that failed, clients would refuse any key but the one
  they pinned. Tests run against a
  local stand-in for the service.
- **Pushes.** A service with an APNs key says so in `registered`
  (`push: true`). A registered runtime then sends `push {target, sealed,
  collapseId}` for a paired device and gets `pushed {result}` back (`sent`,
  `unavailable`, `bad-target`, `rate-limited`, `failed`). The target is the
  one the device registered (section 7.9, `push`) and only the service reads
  it (`apns:<sandbox|production>:<token>` today); the payload is sealed for
  the device. The service adds only a generic alert and delivers it, at most
  120 per runtime per hour. Pushes therefore need network access
  `cateConnect`.

### 7.8 Protocol

- **Frames.** Every transport carries frames: a JSON message, or a binary
  chunk `{streamId: u32, bytes}`. Over the local socket they are
  length-prefixed; over WebSocket and WebRTC one frame is one message (inside
  Noise, section 7.6).
- **Messages.** `hello`, `req {id, cap, method, params, opId?}`,
  `res {id, result | error}`, `evt {stream, data}`, `cancel {id}`,
  `ack {stream, bytes}` (flow control for byte streams). Parameters are named
  objects, never positional arrays.
- **Hello.** Both sides send their `protocol: [major, minor]` and version. A
  client also sends its `clientId`, `device {name, keyFingerprint}` (checked
  against the handshake on network transports) and `features`
  (section 12.2), fixed for the life of the connection. A caller (the CLI, a
  T3 harness) sends its token instead (section 14). Same major is
  compatible; a method or stream the other side does not have fails with
  `unsupported`, so additions are always optional. A different major is
  incompatible (7.10).
- **Client identity and op ids.** A client picks a random `clientId` when it
  starts and keeps it across reconnects. Every call that changes something
  carries an `opId = clientId:counter`, and the runtime ignores an `opId` it
  has already applied (it keeps the highest counter per `clientId`), so a
  resent call is never applied twice.
- **Error codes.** `gone` (the panel or thing no longer exists), `conflict`
  (the write's base is stale), `dirty` (unsaved work; retry with an explicit
  choice), `rejected` (invalid op), `untrusted` (section 9.2), `unsupported`,
  `no-renderer` (section 10.2), `timeout`.

### 7.9 Host capabilities

Capabilities not owned by a feature module, in `runtime/`:

- `server`: long-lived HTTP children with a ready probe (T3 runs on it).
- `tunnel`: `tunnel.connect {port}` opens a TCP connection to a loopback port
  (`127.0.0.1` or `::1`) of the runtime's machine as a flow-controlled byte
  stream. It backs loopback routing (section 12.3) and is the only way a
  client reaches a port on the runtime's machine. It never connects to other
  hosts.
- `power`: keep the machine awake while the workspace's work runs, through a
  platform helper process (`caffeinate -i -w <pid>` on macOS,
  `systemd-inhibit` on Linux, `SetThreadExecutionState` through PowerShell on
  Windows).
- `push` (`runtime/push`): a paired device registers where its pushes go
  (`target`, opaque to the runtime) and a 32-byte key (`register`,
  `unregister`, `status`; the device is the caller's key fingerprint). Every
  notification event (section 10.5) is sealed, as it is, for each registered
  device with ChaCha20-Poly1305 under its key and handed to the Cate Connect
  registration (section 7.7); only the device opens it and decides how to
  show it. One collapse id per panel (`pushCollapseId`, in the contract),
  which clients use for their own banners too, so a push replaces a banner
  about the same agent. Nothing is queued: with no way out a push is
  dropped. A target the service no longer delivers to, and an unpaired
  device, are removed.
- `runtime`: `stop`, `update`, `info`, `perf`; the `lifecycle` stream.

Feature capabilities are declared in their module's `contract/capability.ts`,
implemented in its `runtime/` folder and registered by the composition root:
`settings` (kernel/settings), `api` (kernel/api, for client callers),
`pairing` (runtime/pairing), `document` and `presence` (workspace/document),
`workspace` (workspace/lifecycle: info and trust), `file` and `search`
(workspace/files), `vcs` (workspace/repository), `skills`
(workspace/skills), `process` (services/terminal), `browserData`
(services/browser), `t3` (services/t3), `agents` (services/agents),
`session` and `surface` (panels/framework: session channels, and page
operations sent to the driving client, section 10.2) and `browserCode`
(panels/browser: a client running a browser code cell passes the cell's
`cua.*` calls back through it). A client lists every capability it proxies
in `RUNTIME_CAPABILITIES` (`client/connections`), which fails to compile
when a registered capability is missing.

### 7.10 Versions

- The client and runtime compare protocol majors on `hello`. The runtime
  also sends its build: the version plus a hash of the sources
  (`scripts/build-id.mjs`), baked into the daemon bundle and the desktop app.
  The desktop client treats a runtime of another build (or none) like another
  protocol major: every call fails until the runtime runs the app's build.
- The fix is `runtime.update { version, build }` with the client's own
  version and build: the daemon restarts into the install of that build, or
  downloads release `version` from GitHub Releases (checked against its
  `.sha256`) when the build is not on its machine, refusing a release of
  another build. It restarts too when the versions are equal (a stale build).
  A local runtime always finds the install the desktop app made. Updating
  stops the runtime's terminals and agents.
- When nothing else uses the runtime the client updates it without asking:
  it sends `ifIdle`, which the daemon refuses (`dirty`) while another client
  is connected or work runs. Otherwise the workspace's cover shows both
  builds and says what updating ends before it acts (an incompatible runtime
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
- Secrets never live in a settings file.
- The settings window shows the client settings and the settings of the
  active workspace. With no workspace open (the welcome screen), only client
  settings exist.

| Slice (owner) | Client keys | Workspace keys |
|---|---|---|
| Appearance (`kernel/interaction`) | `activeThemeId`, `systemLightThemeId`, `systemDarkThemeId`, `customThemes`, `uiScale` | |
| Editor (`panels/editor`) | `editorFontSize`, `editorFontFamily`, `filesTreeOnOpen`, `filesTreeOpenFileIn` | |
| Canvas (`shells/desktop`) | `zoomSpeed`, `canvasGridStyle`, `canvasBackgroundImagePath`, `canvasBackgroundImageOpacity`, `showWorktreeTerritory`, `snapToGrid`, `placementPicker`, `autoFocusLargestVisibleNode` | |
| Relations (`workspace/relations`) | `savedPanelRelationLabels` (a personal label library) | `panelRelationsEnabled` |
| Terminal (`services/terminal`) | `terminalFontFamily`, `terminalFontSize`, `terminalScrollSpeed`, `terminalContrast`, `terminalCursorBlink`, `terminalOptionIsMeta`, `terminalLinkOpenTarget` | `defaultShellPath`, `terminalScrollback` (kept by the headless terminal), `autoSuspendIdleTerminals` |
| Browser (`services/browser`) | `browserProxyUrl` (the client's own upstream proxy; may hold credentials) | `browserHomepage`, `browserSearchEngine`, `browserNewTabBehavior` |
| Sidebar (`shells/desktop`) | `sidebarTintOpacity`, `showSkillsInWorkspaceOverview` | |
| Notifications (`shells/desktop`) | `notificationsEnabled`, `notifyOnlyWhenUnfocused` | |
| Remote machines (`shells/desktop`) | `sshMachines` | |
| Shortcuts (`kernel/interaction`) | `customShortcuts` | |
| Desktop (`shells/desktop`) | `warnBeforeQuit`, `betaUpdatesEnabled`, `disableGpuRasterization` (applies after restart) | |
| Repository (`workspace/repository`) | | `closeWorktreePanelsOnDelete` |
| Runtime (`runtime/daemon`) | | `runtimeLifetime`, `runtimeNetwork` |
| `cate` API (`kernel/api`) | | `cliEnabled`, `cliSkillInstallEnabled`, `cliBrowserReadEnabled`, `cliBrowserControlEnabled`, `cliTerminalReadEnabled`, `cliTerminalInputEnabled`, `cliPanelReadEnabled`, `cliPanelControlEnabled`, `cliEditorReadEnabled`, `cliEditorControlEnabled`, `cliNotifyEnabled`, `cliAgentReadEnabled`, `cliAgentControlEnabled` |
| Agents (`services/agents`) | | `agentHookInjection` (a hook mode per agent: `auto`, `on`, `off`) |

T3 provider configuration is not a Cate setting: it lives in T3's own files in
the workspace's `t3/` root, and the provider settings page edits it through
the `t3` capability.

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
  id: WindowId; kind: 'main' | 'detached'; layouts: DockLayout[]   // at least one
}
interface DockLayout { id: LayoutId; name?: string; dock: DockNode | null }
```

- Every panel has exactly one placement: a tab in a dock stack of one layout of
  a window, or a tab in the mini dock of a canvas node. The placement index is derived,
  never stored twice.
- A window holds one or more **layouts** (`DockLayout`), each its own dock
  tree, like the windows of tmux: the switcher in the window switches layouts,
  never panels. A layout that empties is removed unless it is the window's
  only one; a detached window goes when it has no panel in any layout.
  `addLayout`, `removeLayout` (with its panels; the view asks first) and
  `renameLayout` are ops. Layout ids are unique within their window. Which
  layout a client shows is client state (`activeLayouts`), so two clients can
  look at different layouts of the same window; a reveal switches to the
  panel's layout, and a new panel with no better place goes to the layout the
  creating client shows. `document.json` is version 2 (a window's `dock` became
  `layouts`); version 1 files are rejected, not migrated.
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
| Records | `addPanel(record, at)`, `replacePanel(record)` (a surface becoming the picked type: same id, the old session is disposed and the new one started), `updatePanel(id, patch)`, `removePanels(ids)` |
| Placement | `placePanel(id, at)`, where `at` is a tab in a stack (`{to: 'stack', dock, stackId, after?}`), a new stack beside a stack or split (`{to: 'split', dock, beside, side, stackId, splitId}`), a new canvas node (`{to: 'canvas', canvasId, nodeId, stackId, rect}`) or a new detached window (`{to: 'window', windowId, layoutId, stackId}`). `dock` is one layout of a window (`{windowId, layoutId}`) or a canvas node's mini dock. Placing an already placed panel moves it. |
| Containers | `setSplitRatio(splitId, ratios)`, `setNodeRects(canvasId, [{nodeId, rect}])`, `closeWindow(windowId)` (removes its panels; the view asks first) |
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
- Container values (split ratios, rects, record fields) are last write
  wins.

**Runtime side:** holds the document in memory, persists it to
`document.json` (debounced, atomic, through `kernel/state`), assigns each
applied op a sequence number, keeps the last 10 000 applied ops for
reconnects, and broadcasts every applied op to every client.

**Presence** (the `presence` capability): the connected clients (device name,
key fingerprint, `clientId`, declared features) and the panel each one views
and focuses, and whether the client's app has the user's attention (the
terminal service scans at a background cadence when no client does). Clients
report their own view, focus and attention; presence is never persisted.

### 9.2 Lifecycle and trust

**`workspace/lifecycle`**:

- **Open and close.** Opening a workspace is connecting to its runtime (and
  starting it on this machine if needed). Closing it in a client disconnects;
  the runtime follows `runtimeLifetime`.
- **Trust** is one decision per workspace, stored in `trust.json`. Until the
  workspace is trusted, the runtime serves the document and files, but runs
  no process at all (terminals, agents, T3, hooks, and git, whose config and
  hooks a repository controls) and applies nothing from `<project>/.cate/`
  (skills); those calls fail with `untrusted`. The first client to open an
  untrusted workspace shows the trust dialog once it is connected (an
  incompatible runtime is updated first, 7.10); the answer is
  `workspace.setTrust`. `cate serve` trusts the workspace it serves. Because
  every client is the same, one person's decision applies to everyone.
- The client's workspace list entry (section 12) is written by the client, not
  the runtime.

### 9.3 Canvas

**`workspace/canvas`**: the canvas model in `contract.ts`: canvases, nodes,
geometry, node mini docks, free-slot placement (finding a rect for a new node)
and arrangement. It is pure document logic used by the document runtime and by
the client's optimistic mirror. Each shell draws it (the desktop: `shells/desktop/ui/client/layout/canvas`).

### 9.4 Files

**`workspace/files`**:

- **runtime**: the `file` capability (read, write, stat, list, watch, import
  dropped entries, the `buffer` stream of an open file, and the
  `storeDownload` and `storeScreenshot` byte streams that write a client's
  finished browser download to `browser/downloads/` and an annotated
  screenshot to `screenshots/` in the workspace data, `tempDir`, the
  checkout's `.cate/tmp`, and `serveUrl`, which serves a workspace file over
  HTTP on a random `127.0.0.1` port of the runtime's machine behind a random
  per-start token, every request checked against the path scope, so a
  browser panel loads it through loopback routing, 12.3) and `search` (ripgrep
  on the host); path validation against the root, worktree checkouts,
  grants and, read-only, the two folders of the workspace data clients are
  handed (`screenshots/`, `browser/downloads/`, which only the runtime writes,
  through `storeScreenshot` / `storeDownload`); the rest of the workspace data
  (secrets, pairings, ...) is outside the scope; exclusions.
- **Open buffers**: one Yjs document per open file, however many editor
  panels show it. Loaded on first open, saved on `save` with the hash of the
  content it was loaded from (a stale hash fails with `conflict`), persisted
  to `buffers/` while it has unsaved edits, dropped when no editor shows it
  and it is clean.
- **External changes**: the watcher reloads a clean buffer, and marks a dirty
  buffer as conflicting; any viewer resolves it (three-way merge in the
  editor view).
- **client**: the fs client, the refcounted watch manager, `attachBuffer`,
  which binds a `file.buffer` stream to a local Yjs document, and the
  file-ref resolver (below).
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
  (a dock, canvas, terminal or chat) copies into the temporary folder of the
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
  `WorktreeMeta` status ops, move or close bound panels
  (`closeWorktreePanelsOnDelete`), and inherit worktrees for new panels.
  Checkouts live under `<repo>/.cate/worktrees/<slug>`; panels bind by
  `worktreeId`.
- **client**: git status store, worktree hooks.
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
  other source.
- **Desktop UI** (`shells/desktop/ui/workspace/skills`): the skills dialog, the workspace skills tree, skills settings.

### 9.7 Relations

**`workspace/relations`**:

- **contract**: the typed relation graph between panels (`use`, `context`,
  `verify`, `trigger`) and `compileRelationContext`, which the agents service
  uses for prompt context.
- **runtime**: **connected editors**: an editor connected to a terminal or chat
  panel shares a working file with the agent (an untitled editor gets
  `.cate/tmp/<id>.md`), autosaves, and is flushed before a prompt is
  submitted (`docs/connected-editors.md`).
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
  the `process.attach` stream, which starts with the serialized screen. A
  terminal view attaches to it directly with the PTY id from its session's
  snapshot; the session channel carries no bytes.
  Input from every viewer goes to the same PTY, as in a shared tmux session.
  The PTY fits the viewer that last asked (`view` with `fit`; the first
  viewer until then) and follows that viewer's resizes; typing does not fit.
  Every viewer is told the PTY's size and whether the PTY fits it (the
  `size` event) and the same rules apply to all of them. Every view draws
  the PTY's grid: a view the PTY does not fit scales it down to its frame
  when it is bigger, or leaves it in the corner when it is smaller, and
  offers to fit (a Fit button and "Fit Terminal to View" in the tab menu on
  the desktop, "Fit to phone" on the phone). When to fit is the person's
  choice.
- **Extension points** (so terminal never imports agents): PTY env
  contributors (the `cate` CLI on PATH with `CATE_SOCKET` and `CATE_TOKEN`,
  agent hook env), output and activity observers, launch intents.
- **client**: the xterm binding: it writes the serialized screen, then the
  stream, and forwards keystrokes and resizes. Links, search, OSC 52 clipboard
  and keymaps are view concerns.
- **Consumers**: the terminal panel, the terminal runner, `cate.terminal.*`.

### 10.2 Browser

A page lives in a webview on a client. Everything else about the browser lives
in the runtime.

- **runtime**: the `browserData` capability used by the browser panel's
  session (which holds tabs, URLs, navigation state and titles): history,
  bookmarks, saved
  passwords (in `secrets.json`), downloads (the client uploads each finished
  download to `browser/downloads/` with `file.storeDownload`, so agents find
  it) and uploads (moved from the host to the client for a file input).
- **desktop**: the webview, one partition per workspace
  (`persist:ws-<runtimeId>`, cookies are per device) routed through loopback
  routing (section 12.3), the **page driver** (the CDP engine: accessibility
  snapshots, actions, screenshots, waits, code cells), guest and code-cell
  preloads, the password autofill bridge, and **passkeys**. Passkeys are
  never stored by Cate: the native addon calls the OS, which keeps them in
  the user's keychain. It needs the signed app's entitlement, a window and
  macOS, so the desktop shell declares the `passkeys` feature only on macOS.
- **Every client loads the page itself.** `localhost` pages come from the
  runtime's machine through loopback routing, a typed path or `file://` URL
  is a workspace file the session turns into its `file.serveUrl` URL (never
  the client's disk), everything else from the
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
- **Shared passwords, own sessions.** The runtime remembers passwords, so any
  client can autofill them; each client keeps its own logged-in session.
- **The driving client.** Page operations (`cate.browser.*`, code cells) run
  on the connected client with the `pageDriver` feature that most recently
  showed or used the panel, or else the most recently active client with
  `pageDriver`. That client mounts the surface while an operation runs. With
  no such client connected, page operations fail with `no-renderer`.
- **Consumers**: the browser panel, `cate.browser.*`.

### 10.3 T3

T3 is the bundled T3 Code harness, patched at build. The runtime runs it as a
`server` child, one instance per checkout (`t3/instances/<checkout hash>/`).

- **runtime**: the `t3` capability: harness lifecycle, provider auth and
  status, provider configuration (T3's own files), the thread-shell stream,
  thread activity and usage. The harness reaches the `cate` API through
  `CATE_SOCKET` and `CATE_TOKEN`, like a terminal.
- **client**: loading the harness UI at `http://127.0.0.1:<port>` through
  loopback routing (section 12.3),
  surface theming, the guest page bridge `__cateHost`. The bridge is a small
  client-side protocol, not a `cate` API caller: its six actions (`diff`,
  `external`, `file`, `open-agent`, `place-agent`, `relation-context`) are
  handled by the chat view, which asks the user through `ClientUi` where
  needed and sends document ops or session ops; `external` opens a loopback
  URL in a browser panel (12.3) and any other in the system browser.
- **Several clients**: every client's page is its own T3 client of the same
  harness, and T3's stream brings each the conversation. The chat panel's
  record names the thread; a page moves to it in place through T3's router
  (patched to `window.__cateRouter`), and loads afresh only for a new
  `loadId`. A thread a page does not know yet stays on its route until T3
  delivers it (patched; upstream goes home).
- **Desktop UI** (`shells/desktop/ui/services/t3`): the usage overview, provider settings (a provider sign-in whose page
  or `redirect_uri` is loopback opens in a browser panel of the workspace).
- **Consumers**: the chat panel, the t3 runner, settings, usage.

### 10.4 Agents

Owns the agent vocabulary of section 2. All of it runs in the runtime.

- **contract**: the `AGENTS` registry. Each `AgentDef` declares its runners:
  `runners: { terminal: {command, hooks, resume, sessionStore},
  t3?: {providerId, driverId} }`, plus skills targets, process matching and
  prompt-context hooks. Every per-agent table is a total
  `Record<AgentId, …>` (an agent without an entry says so with `null`), so a
  new agent is a compile error until every table has it. Also the session,
  runner types, the start launch command, and the `cate.agent.*` API specs.
- **runtime**: the `agents` capability:
  - hook bridges and repo hook files (per `agentHookInjection`), hook
    ingestion and normalization, pid presence;
  - the **status** state machine, driven only by hook events and pid presence
    (there is no screen scraping);
  - change history per checkout (from terminal hooks and from T3) in
    `agents/changes/`;
  - session store readers per agent, conversation reads, resume stamps,
    Hermes integration;
  - live conversations (the `conversation` channel): one watch per panel
    reads the conversation together with the agent's state, so a turn that
    ended goes out with its reply; it looks again on every state change and
    while the agent works, reading the store only when its files moved, and
    sends the messages from the first one that changed;
  - the runner registry: `sessionFor(panel)` answers which agent session a
    panel hosts;
  - prompt context from relations, and agent notification events.
- **Starting an agent** (`cate.agent.start`): its CLI in a new terminal
  panel (a hook-ready agent, launched in place of the shell) or a T3 thread
  in a new chat panel, in the caller's checkout, an existing worktree or a
  new one, next to the calling panel or where the call places it. Panels,
  worktrees and T3 come through ports the composition root fills. Once
  started it is an agent panel like any other: `cate.agent.*` reads,
  prompts and interrupts it by its panel. `types` lists the agent CLIs and
  whether each can start in a terminal here. The review panel starts its
  reviewers the same way.
- **runners/terminal**: plugs into the terminal service (hook env on PTY spawn,
  status, resume, prompt submission into the PTY, interrupt with the CLI's
  own key).
- **runners/t3**: plugs into the t3 service (thread state, prompt dispatch and
  turn interrupt to T3 orchestration, change capture on harness start).
- **client**: the agent panel states mirror and an agent chat
  (`watchAgentChat`: the conversation channel, and a prompt sent from the
  client pending until the conversation shows it).
- **Desktop UI** (`shells/desktop/ui/services/agents`): the changes pill, activity title, logos, hook settings, the
  relation context transport (`useAgentContextTransport`).
- **Consumers**: terminal and chat panels, review (changes), sidebar and dock
  tabs (status), `cate.agent.*`.

Dependencies point one way: `agents → terminal`, `agents → t3`. Terminal and
t3 never import agents.

### 10.5 Notifications

Services publish notification events from the runtime
(`{kind, panelId, title, body}`: an agent finished or needs attention, a
command failed, `cate.ui.notify`). Each client decides whether to show one,
from its notification settings and its own focus, and shows it through
`ClientUi`. Every client consumes them the same way,
`attachAgentNotifications` (`services/agents/client`): one subscription per
open workspace, each event handed to the shell's display, and a pending
agent notification withdrawn when that agent works again. The same events
reach devices that are away as pushes (section 7.9, `push`).

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
  checkout), `describe`, `chrome` (dock chrome flags), `relation` (its role
  in the relation graph, section 9.7), plus the `surface`, `requiresFolder`
  and `switchesWorktree` flags.
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

Three index files at the top of `src/panels/` list the types, so no generic
code names one:

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
   kit.
2. **Views render snapshots and send ops.** A snapshot is plain JSON (no
   class instances, no `Map`). A view talks to its session channel through
   the session handles of `client/host` (`acquireSession`); in the desktop UI
   `PanelSessionBoundary` is the only place a view attaches to it. Where a
   service already serves the stream a view needs, the view attaches to that
   stream directly, named by its snapshot: the terminal view to
   `process.attach` (the PTY's bytes) and the editor view to `file.buffer`
   (the file's Yjs updates). The session channel stays JSON.
3. **One set of operations.** UI, other sessions and the `cate` API call the
   same typed session ops. Sessions may send document ops (a deleted T3
   conversation closes its panel with `removePanels`).
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
   `removePanels` op.
   `clientUi.contract.test.ts` fails on a native call outside the port and on
   any `clientUi()` call in a session or runtime file.
7. **Explicit lifecycle.** A session is disposed only when its panel is
   removed (`removePanels`) or replaced (`replacePanel`). Ops that arrive for
   a removed panel fail with `gone`.

### 11.3 Panel types

| Panel | Session built on | Session state (snapshot) | View | Notes |
|---|---|---|---|---|
| terminal | services/terminal, services/agents | pty status, title, cwd, activity, agent session and status; screen as serialized stream | xterm | shows terminal-runner sessions |
| chat | services/t3, services/agents | thread binding, harness status, activity, agent status | T3 client in a webview | shows t3-runner sessions |
| browser | services/browser | tabs, URLs, titles, viewport preset, navigation state, loading, downloads | webview | each client loads the page itself; page zoom is per client |
| editor | workspace/files, workspace/relations | file, dirty, conflict and whether its diff is shown, connected draft, reveal; buffer as Yjs stream | Monaco (y-monaco) | one buffer per file; three-way merge; source or markdown preview is per client |
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

- **`client/connections`**: one connection per open workspace runtime: finding
  it (the local socket, mDNS, Cate Connect), starting a local one, pairing,
  the security layer, the typed capability proxies (filling the
  `kernel/rpc` slot), session channel subscriptions, reconnect with backoff,
  the "offline" state (last-seen time, retrying in the background) and the
  "stopped" state (stopped on purpose, no retrying until started again);
  `eachConnection` runs something per open connection.
  Each connection implements `dialLoopback(port)` (section 12.3).
- **`client/workspaces`**: the device's workspace list: local recents, paired
  workspaces and their pinned keys (`known-runtimes.json`), sidebar order.
- **`client/document`**: the client's mirror of each open workspace's
  document, with optimistic ops (section 13.5) and subscriptions. The stores
  that show records, docks and canvases are selectors over it.
- **`client/host`**: the panel side of the core: `createPanel`, panel
  targeting (`pickPanelPlace`), session handles (`acquireSession`), closing
  (`registerPanelCloseGuard` and `closePanels`, which asks every guard before
  one `removePanels` op), focus and reveal, the action registry with each
  panel type's actions, and the creation menus (12.4).

How a shell lays the document out (docks, the canvas view, dragging, windows)
is its UI: the desktop's is `shells/desktop/ui/client/layout` (section 15).

### 12.2 Client features

Clients do not all support the same things. A phone has no windows, may have
no page driver and no passkeys. The contract that says what a client can do is
one closed list of features, `ClientFeature` in `kernel/rpc/contract.ts`.
Features are for the runtime and the core, which serve every kind of client;
a shell's UI knows its own platform and draws what it supports:

| Feature | The client can | Asked by |
|---|---|---|
| `webview` | host web pages in a native surface, with loopback routing (12.3) | the runtime, choosing who serves a browser surface |
| `pageDriver` | run page operations on its webviews: accessibility snapshots, actions, screenshots, waits, code cells | the runtime, choosing the driving client (10.2) |
| `passkeys` | answer WebAuthn requests through the OS | the desktop UI (macOS only) |
| `windows` | open detached windows | presence |
| `canvas` | render and edit canvases | presence |
| `fileDrop` | take files dragged in from the OS | presence |
| `osNotifications` | show OS notifications | the core, choosing an OS notification or an in-app one |
| `screenCapture` | capture its own window | the core's screenshot actions |
| `clipboard` | read and write the system clipboard | the core's copy actions |
| `camera` | scan a QR code | the pairing flow (without it, the pairing code is typed) |

Rules:

1. **Declared once.** The list is closed. Adding a feature is a protocol minor
   version; an unknown feature in `hello` is ignored.
2. **Declared per connection.** A client sends its features in `hello`
   (7.8). The runtime keeps them per connection and shows them in presence.
   Each shell declares what it supports on its platform: the desktop shell
   declares all of them except `camera`, and `passkeys` only on macOS; the
   iOS app declares `webview`, and `camera` where it can scan. Deciding the
   set is the only place a shell looks at its platform.
3. **Asked, never inferred.** Core code asks `clientHas(feature)`; runtime
   code asks the connection. Nothing shared asks which shell, platform or
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
8. **Tested.** A contract test checks that every feature a command or action
   `requires` names a known feature.

### 12.3 Loopback routing

Terminals and agents start dev servers on the runtime's machine, so in the
browser and chat panels `localhost` means the runtime's machine on every
client (D10). This is what makes a shared `http://localhost:3000` the same page
for everyone, and what lets a network client open the chat panel's T3 UI.
A dev server therefore never needs to listen on `0.0.0.0`: `localhost` is
the runtime's machine on every client.

- **Which hosts.** `localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0`,
  `[::1]` and `[::]`, any port (`isLoopbackHostname` in
  `runtime/tunnel/contract`).
- **Opening links.** `openUrlFor` (`client/host`) opens a loopback URL in a
  panel that opens URLs, and any other URL through `ClientUi.openExternal`.
- **The web proxy.** Each client with `webview` runs one web proxy per open
  workspace and routes that workspace's webviews through it. It supports
  plain HTTP, `CONNECT` (HTTPS) and upgrades (WebSocket, for hot reload). For
  a loopback host it calls `connection.dialLoopback(port)`; for every other
  host it connects directly, or through the client's `browserProxyUrl`.
- **The connection decides how.** A local connection's `dialLoopback` opens a
  TCP socket to the port on this machine (it is the runtime's machine). A
  network connection's opens `tunnel.connect {port}` on the runtime (7.9),
  inside the encrypted workspace connection. The proxy is the same code for
  both; nothing branches on the transport.
- **Pages are not rewritten.** The URL stays `http://localhost:3000`, so
  origins, cookies and absolute links behave as they do on the runtime's
  machine.
- **Desktop.** The proxy runs in desktop main on a random `127.0.0.1` port.
  The workspace's partition (`persist:ws-<runtimeId>`, shared by its browser
  and chat panels) uses it with
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
  workspace that asked last owns a port. Pages are not rewritten either. A
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
  the palette or the welcome page lists it. `registerActions(specs,
  bindings)` (`client/host`) declares them in the catalog (`kernel/interaction`) and
  binds what each does (`run`, the client features it `requires`, `enabled`
  for a context); every declared action has a binding. Core modules declare
  the actions every shell can run (panel creation, panel commands); a shell's
  UI declares its own (the desktop UI: palette, sidebar, canvas and window
  actions).
- **Panel types bring theirs.** For every definition with `creation` the
  host declares `panel.new.<type>` ("New <label>", its default key, File >
  New); for every `command`, `panel.<type>.<id>`, run against the focused
  panel of the type (and, with `menu`, listed under the type in the Panel
  menu). A new panel type appears in every menu, the palette, the shortcuts
  settings and the toolbar tooltips with no other code.
- **Creation menus** (the canvas menu, the canvas toolbar, a dock's new-tab
  and tab-bar menus, the empty dock, a surface's picker, the relation
  handle, the worktree menu, the palette) list `creatableDefinitions()`:
  the types with `creation` this client can show, in creation order. A type
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

Someone in the workspace turns on network access and adds a device; the joiner
scans the QR (or types the code), pairs (section 7.7) and connects. The joiner
receives the document, the workspace settings and presence, and subscribes to
the sessions they view.

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
  buffer per file, so concurrent typing merges. **Chat**: prompts from any
  viewer are queued into the same thread.

### 13.4 What clients receive

- **On connect**: the document with its sequence number, the workspace
  settings and presence. Then every applied document op in order.
- **Sessions**: a client subscribes only to the panels it shows: a snapshot,
  then snapshot changes, plus the terminal byte stream or Yjs updates.
- **Large data** (file contents, diffs, screenshots) is fetched when needed,
  never pushed.
- **On reconnect** the client sends its last sequence number and gets the ops
  it missed, or the full document if they are no longer kept. Then it resends
  its unconfirmed ops; their `opId`s make that safe.

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

Each client keeps an undo stack of its own confirmed document ops with their
inverse, computed against the document the op applied to. Undo sends the
inverse as a new op. If the inverse names something that is gone, that part is
skipped. Undo never covers session or resource work.

## 14. Access: the `cate` API

Everything outside the UI that drives Cate goes through one router.

- **Router** (`kernel/api`, in the runtime next to the document): resolves the
  target panel from the document (explicit id or unique id prefix, the
  caller's sticky target, its placement group, the active panel of the most
  recently active client, the only panel of the type) and calls
  the target's session or the owning service. Timeouts come from the spec;
  the CLI reads them from the spec too.
- **Callers and how they reach it**:
  - the `cate` CLI in a terminal: over the local socket (`CATE_SOCKET`),
    authenticated by `CATE_TOKEN`, a per-PTY token that also names the calling
    panel. Terminals run in the runtime, so this is local on every machine.
  - a T3 harness: the same, with a per-harness token.
  - a browser code cell: the cell runs on the driving client, which passes
    each `cua.*` call back through the `browserCode` capability as the cell's
    original caller, through the same gates.
  - a client: the `api` capability.
- **Access classes**: each method declares `read` or `control`. The workspace
  settings enable each class per area (the `cli*Enabled` keys), behind the
  `cliEnabled` master switch; they apply to CLI and harness callers. Client
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
  <command>` is the engine's own. The only command that is not an API method
  is `cate serve` (section 7.1).

| Namespace | Methods | Owner | Handler |
|---|---|---|---|
| `cate.version` | | kernel/api | service |
| `cate.panel.*` | `list`, `close` (`discard` arg), `setTitle`, `target.set`, `target.current`, `target.clear` | workspace/document | service |
| `cate.canvas.*` | `createPanel` | workspace/document | service |
| `cate.ui.*` | `notify` | kernel/api (publishes a notification event) | service |
| `cate.terminal.*` | `read`, `type`, `press` | terminal panel | session |
| `cate.browser.*` | `run` and `reset` (the caller's code session), `listTabs`; page operations for code cells (`getTab`, `createTab`, `getAXState`, `getScreenshot`, `click`, `typeText`, `goto`, `waitFor`, ...) | browser panel | service (`run`, `reset`, `listTabs`) / session |
| `cate.editor.*` | `openFile`, `active` | editor panel | session / service |
| `cate.review.*` | `inspect`, `complete`, `note.add`, `note.resolve` | review panel | session |
| `cate.agent.*` | `start`, `types`, `list`, `read`, `wait`, `send`, `interrupt` | services/agents (starts panels; resolves session to runner) | service |

There is no `cate.panel.focus`: focus is client state. Page operations are
not CLI commands (`cli: {command: false}`); the CLI reaches them through
`cate browser run`.

## 15. Shells

- **`shells/desktop`**
  - **main**: app entry, windows and the window registry, rendering the
    menu bar model the renderer sends (12.4) and context menus, native
    dialogs, notification display, the updater (including installing the
    bundled runtime tarball to `~/.cate/runtime/<build>/`), analytics and
    crash reporting, open path and URL handling, screenshot capture, web
    security hardening and dev feature flags, the webview host, browser
    partitions and the loopback web proxy (12.3), passkeys, window crash
    recovery, theme boot cache, the raw sockets for the client's transports
    (local runtimes are found and started here, section 7.3; each connection
    is a pipe handed to the renderer), the device files behind `DeviceStore`
    and the device key, and the declaration of the client features (12.2).
  - **preload**: the desktop IPC for the above only (`window.cateDesktop`,
    typed by `DesktopApi` in `shells/desktop/contract`). No workspace work
    crosses it. Each preload entry bundles self-contained (a
    shared chunk breaks the sandboxed preload), and a test enforces it.
  - **renderer**: boots the client core, installs the desktop `ClientUi`
    and the shell's ports, imports every panel view and maps each type to
    its view, calls `registerWorkspaceViews()`, fills the review and
    agent-changes openers, and mounts the desktop UI. Nothing else: logic
    lives in the client core.
  - **ui**: the desktop UI, all of it, in React, mirroring where each piece
    belongs: the kernel components and theme manager (`ui/kernel/interaction`), panel
    hosting and native surfaces (`ui/client/host`), the dock, the canvas
    view (its view store, nodes, minimap, territory layer), dragging and
    detached windows (`ui/client/layout`), the app frame: sidebar, palette,
    settings, pairing, onboarding and dialogs (`ui/app`), every module's
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
  primitives only: device storage, the Keychain, mDNS, the declared
  features) and the core API (what the app asks the core to do, plus one
  state snapshot pushed on every change). The core side follows the client
  core's rules: no Node, no Electron, no React. Its state carries each
  connected workspace's agents (panel states with what each asked for),
  keep-awake state and this device's push status; the app
  shows each agent of a workspace as a chat (the conversation pushed as it
  changes through `agents.watch`, replies, what it is doing while it works,
  stopping its turn; permissions are answered in the
  agent's own panel, one tap away), and a
  new agent as an empty chat whose box picks what runs it, started with
  `cate.agent.start` in the dock or on a canvas the person picks. The core
  consumes notification events like every client and hands each to the
  app (`notification.show`, `notification.withdraw`); the app registers its
  APNs target for pushes, and a notification service extension opens them
  with the key the app keeps in a Keychain group they share.

Quitting the desktop app closes its windows and connections. Each runtime then
follows its `runtimeLifetime`, so the desktop shell's quit blockers only guard
client-local work (a file drop still importing).

## 16. Persistence

| Where | Files |
|---|---|
| Workspace data, `~/.cate/workspaces/<runtimeId>/` | see section 7.2 |
| Project `<root>/.cate/` | `skills.json`, `tmp/`, `worktrees/`, `.gitignore` (ignores everything but `skills.json`); `skills-mirror.json` inside each worktree checkout's `.cate/` |
| Machine, `~/.cate/runtime/<build>/` | the installed daemon (the program, not state) |
| Client device (Electron `userData`, through `DeviceStore`) | `settings.json` (client settings, custom themes), `ui-state.json` (minimap corner, onboarding progress), `boot.json` (main and detached window bounds, theme boot cache, last workspace), `workspaces.json` (recents, paired workspaces, sidebar order), `known-runtimes.json` (pinned runtime keys), `device-key.json` (`0600`), `canvas-backgrounds/`, `update-state.json`, `install-id`, `analytics-state.json`, `pending-events.jsonl`, Chromium partitions (one per workspace), logs |

Every JSON state file above is written through `kernel/state`. The others
(sockets, Yjs buffers, T3's own files, logs, downloads, screenshots, Chromium
data) are written by their owner directly.

## 17. Folder layout

```
src/
  kernel/
    rpc/  api/  settings/  lifecycle/  state/  log/  interaction/
  runtime/
    daemon/                 main.ts (the program), entry.ts and compose/ (the
                            composition root), release, install layout,
                            lifetime, update; node/ desktop/ sides
    data/                   workspace data directory, runtime.json, secrets
    transports/             local socket, same-network WebSocket, WebRTC data
                            channel; client, node and runtime sides
    security/               Noise handshake, keys, fingerprints
    pairing/                the pairing capability, secrets, codes, QR payload,
                            pairings.json
    connect/                Cate Connect client (registration, signaling,
                            pushes)
    push/                   the push capability, sealing, push.json
    server/  tunnel/  power/  generic host capabilities
  workspace/
    document/               contract runtime/           schema, ops, ordering,
                            persistence, presence
    lifecycle/              contract runtime/ client/   open/close, trust
    canvas/                 contract                    model and placement
    files/                  contract runtime/ client/
    repository/             contract runtime/ client/
    skills/                 contract runtime/
    relations/              contract runtime/ client/
  services/
    terminal/               contract runtime/ client/
    browser/                contract runtime/ client/ desktop/
    t3/                     contract runtime/ client/
    agents/                 contract runtime/ client/ runners/{terminal,t3}/
  client/
    connections/  workspaces/  document/  host/
  panels/
    framework/              contract runtime/ client/
    terminal/  editor/  browser/  chat/  review/  canvas/  surface/
    definitions.ts  runtime.ts  api.ts      the panel index files
  shells/
    desktop/{contract,main,preload,renderer}/
    desktop/ui/             the desktop UI (React, DOM, xterm, Monaco): app/,
                            kernel/interaction/, client/{host,layout}/,
                            <layer>/<module>/, panels/<type>/
    mobile/                 contract.ts, core/ (the headless core of ios/)
  cli/                      generic engine; commands from API specs
  shared/                   generic pure utilities only (paths, colors, errors)
  test/                     test support (the vitest log stub, mock ClientUi)
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
