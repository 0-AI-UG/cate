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
| D5 | All workspace state lives in the workspace data directory on the runtime's machine. The repository's `.cate/` holds only skills, drafts and worktree checkouts. |
| D6 | Nothing is shared between workspaces. A new workspace starts from defaults. |
| D7 | Native OS primitives stay in the client's shell (the desktop shell): windows, webviews and the page driver, the loopback web proxy, passkeys, native dialogs, notification display, drag ghost, screenshot capture, the updater. |
| D8 | Clean cuts: no migration code, no old formats read, no shims (section 18). |
| D9 | Clients differ only in the features they declare (section 12.2). Code asks for a feature, never for a platform or device kind. |
| D10 | In the browser and chat panels, `localhost` always means the runtime's machine, on every client, routed through the workspace connection (section 12.3). |

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
- **A mobile app.** A phone connects to a workspace and shows and drives the
  same panels. The mobile shell itself comes later; everything it needs from
  the runtime and the portable client is in place.
- **Two ways to connect over the network, one flow.** Same network, or Cate
  Connect. Either way the user scans a QR code (or types its code) and is
  connected directly and securely to the workspace.
- **Work that can outlive the window.** Terminals, agents and T3 threads live
  in the runtime, and a workspace setting decides whether the runtime keeps
  running without clients.

There is exactly one client application. Desktop Cate and the mobile app are
platform shells around it.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Daemon** | The one Cate runtime program. The same build runs on every machine and has the same modules everywhere. |
| **Runtime** | One running daemon serving one workspace. It executes all of that workspace's work: files, git, search, processes, panel sessions, agents, T3, the `cate` API, and holds its state. |
| **Machine** | A computer that runs runtimes. Runtimes on one machine share only the installed daemon program. |
| **Workspace** | A project (a root path) with its worktrees, panels and layout, served by one runtime. |
| **Workspace data** | A workspace's own state directory on the runtime's machine (section 7.2). |
| **Transport** | How a client reaches a runtime: `local` (a socket on the same machine) or `network` (same network, or Cate Connect). A transport never changes what the runtime is or does. |
| **Cate Connect** | A coordination service we host. It passes connection setup messages so a client and a runtime connect directly. It never carries workspace traffic and is never trusted with it. |
| **Pairing** | Connecting a device to a workspace for the first time with a QR code or pairing code. Afterwards both sides know each other's key. |
| **Capability** | A typed group of runtime methods and streams (`file`, `vcs`, `process`, `server`, `tunnel`, `power`, ...), declared once with `defineCapability`. |
| **Document** | The shared structure of a workspace: panel records, windows and their dock trees, canvases, relations, worktree metadata. The runtime holds it and orders every change to it. |
| **Op** | One change: a document op (section 9.1), sent by a client, a session or a `cate` API handler, or a session op, sent to one panel session (section 11.2). |
| **Panel session** | A panel's live state and behaviour. Runs in the runtime. |
| **Client** | One running instance of the Cate client (a desktop app, a phone). Renders the document and session snapshots of the workspaces it has open. |
| **Client feature** | Something a client can do that not every client can (host a webview, drive a page, open windows, ...), from one closed list (section 12.2). |
| **Device** | The machine a client runs on, identified by its device key. |
| **Shell** | The platform around the client: desktop (Electron) or mobile. |
| **Service** | Infrastructure more than one panel or caller uses: terminal, browser, t3, agents. |
| **Panel** | A session plus a view: terminal, editor, browser, chat, review, canvas, surface. |
| **Caller** | Whoever calls the `cate` API: the CLI in a terminal, a T3 harness, a browser code cell, a client. |

### Agents

"Agent" means exactly one thing: a provider CLI identity.

| Concept | Meaning | Examples |
|---|---|---|
| **Agent** | A provider identity, static data in one registry (`AGENTS`). | claude-code, codex, cursor, grok, hermes, kiro, opencode |
| **Runner** | How an agent session executes and how Cate observes it. | `terminal`: the CLI runs in a PTY, observed through injected hooks and pid presence. `t3`: the T3 harness drives the provider, observed through T3 orchestration. |
| **Agent session** | One conversation: `{agentId, runner, sessionId, cwd, worktreeId}`. It reports status, takes a prompt, reads its conversation, lists its changes and resumes. | "claude-code in a terminal", "codex in a T3 thread" |
| **Mission** | Orchestration over sessions: a supervisor spawns workers, admission limits them, their changes are applied, kept or discarded. | `cate.codingAgent.*` |

Every agent has the `terminal` runner. The `t3` runner exists for the agents
T3 has a provider for: claude-code, codex, cursor, grok, opencode (not hermes,
not kiro). T3 is never an agent: it is a runner, and the backend of the chat
panel. Only the agents service knows that runners exist; everything else
talks about sessions. The terminal panel shows terminal-runner sessions, the
chat panel shows t3-runner sessions.

## 3. Layers

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ shells     desktop (window host, native OS, webview host) · mobile       │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ panels     framework + terminal · editor · browser · chat · review ·     │
 │            canvas · surface                                              │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ client     connections · workspaces · document mirror · host ·           │
 │            layout (dock, canvas view, drag, windows) · ui                │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ services   terminal · browser · t3 · agents                              │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ workspace  document · lifecycle · canvas · files · repository ·          │
 │            skills · relations                                            │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ runtime    daemon · data · transports · security · pairing · connect ·   │
 │            host capabilities                                             │
 ├──────────────────────────────────────────────────────────────────────────┤
 │ kernel     rpc · api · settings · lifecycle · state · log · ui           │
 └──────────────────────────────────────────────────────────────────────────┘
```

Code is organised along two axes: the **layer** (above) and the **side**
(`contract`, `runtime`, `node`, `client`, `ui`, `desktop`). The rules:

- **Sides first.** Contracts (`contract.ts` and the files of a `contract/`
  folder) are pure (types, data and pure functions; no Electron, no Node
  built-ins, no React, no DOM, no assets, no I/O) and may be imported from
  anywhere; a contract imports only other contracts. A `runtime/` folder
  imports only contracts, other `runtime/` folders and `node/` folders. A
  `node/` folder is shared Node code (state files, sockets, installs) that
  both the daemon and the desktop shell use; it imports only contracts
  and other `node/` folders. A `client/` or `ui/` folder imports only
  contracts and other `client/` or `ui/` folders, and never Node built-ins or
  Electron. A `desktop/` folder, and all of `shells/desktop`, may import
  everything but a `runtime/` side. The daemon never bundles `client/`, `ui/`
  or `desktop/`; a client never bundles `runtime/`.
- **Layers second.** Within a side, a module imports only from its own layer
  or layers below. Where a lower layer needs something a higher one provides
  (the client host rendering a panel view, the file explorer reaching the
  current workspace's runtime), the lower layer owns a slot and the higher
  layer registers into it. `kernel/rpc` owns the "runtime for this workspace"
  slot; `client/connections` fills it. `client/host` owns the panel view slot
  (`registerPanelView`) and the close guard slot (`registerPanelCloseGuard`);
  each panel's `view/` fills them.
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

**The one-client test.** No module branches on desktop versus mobile, or on
any platform. Where clients differ, code asks for a client feature
(section 12.2).

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
  client/       portable client side: typed clients, stores, no React, no DOM
  ui/           React pieces that are not a panel view (settings pages,
                pills, menus, sidebar trees)
  desktop/      desktop-shell-only pieces (webview, CDP driver, native addons)
```

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
| Missions: supervisor, workers, admission |
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

| What |
|---|
| Rendering the document: docks, canvas view, nodes, minimap, territory layer, relation drawing |
| Panel views: xterm, Monaco, T3 client surface, diff views |
| Webviews, browser partitions, the page driver (CDP), code-cell and guest preloads |
| Passkeys (macOS `ASAuthorizationController`, needs the signed app and a window) |
| The upstream browser proxy (`browserProxyUrl`) |
| The loopback web proxy (section 12.3) |
| Client features (section 12.2) |
| Input, drag and drop, drag ghost |
| Client state: viewport, zoom, active tabs, focus, selection, undo history, one-shot intents |
| Document mirror with optimistic ops |
| Connections: finding, starting and pairing runtimes, the security layer, reconnect, loopback routing |
| Workspace list, recents, known runtimes, main window bounds, onboarding progress |
| Client settings (section 8) |
| Notification display |
| `ClientUi`: dialogs, confirmations, notification display, clipboard, OS file actions |
| Windows, menus, updater, crash reporting, analytics |

### 4.3 Not in the model

- No panel moves between windows or processes. Detaching a panel is a
  placement op (section 9.1); windows and canvases are document data, and the
  cross-window panel index is derived from the document in the client.
- No runtime id inside a path string. The connection a path came through is
  the routing.
- No session asks for UI (section 11.2, rule 6).
- No shared local daemon, no SSH or WSL transport, no project lock file, no
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
| **Session** | a panel session | terminal screen and scrollback, editor buffer, browser tabs and URLs, chat thread binding, review selection, agent status | every client viewing the panel |
| **Resource** | runtime capabilities | PTYs, files, git, agent processes, agent changes, T3 servers | through the runtime |
| **Workspace data** | the runtime | workspace settings, secrets (browser passwords, the runtime key), T3 state and provider logins, browser history and bookmarks, skill sources, trust, granted paths, paired devices | every client of the workspace |
| **Device** | one client device | client settings, workspace list and recents, known runtimes, device key, main window bounds, onboarding progress, per-workspace browser partitions (cookies) | never |
| **Client** | one running client, in memory | viewport, zoom, active tab per stack, focus, selection, undo history, open overlays, a drag in progress, one-shot intents (reveal a line), mounted webviews | never |

Rules:

- Document changes are ops (section 9.1). Records are state, never commands: a
  record change may make a client follow it (reload a view) but never kills,
  restarts or discards a resource. Resource work is always an explicit
  operation.
- Placement is shared. A panel docked, detached or moved by one person moves
  for everyone. Which tab of a stack is active is client state.
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
  the daemon for workspace data and by the desktop shell for device files. Every state file has exactly one writer process. Portable
  client code never touches files: it reads and writes device state through
  the `DeviceStore` port, which each shell implements (the desktop shell with
  these files).
- **`kernel/log`**: structured logging for every process, with the vitest stub.
- **`kernel/ui`**: client-side primitives every client layer may use: the
  `ClientUi` port, the theme schema and theme manager, the shortcut registry,
  shared React components (buttons, modal, popover, tooltip, error
  boundaries). It is a `ui` side: the daemon never imports it.

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
  checkouts, its workspace data directory and its granted paths. There is no
  scope id on calls: the connection is the scope.
- **Identity.** `runtimeId` is the first 16 characters of the lowercase base32
  SHA-256 of the canonical root (`realpath`), so socket paths stay short. It is
  stable across restarts, names the workspace data directory, and is what
  pairings refer to. Moving the project folder gives a new `runtimeId` and a
  fresh workspace.
- **Install.** One layout everywhere: `~/.cate/runtime/<version>/` holds the
  daemon, its Node, the `cate` CLI, the patched T3 harness, bundled skills and
  native addons. The desktop app ships this tarball and installs it there on
  start. On any other machine one command installs it
  (`curl -fsSL <install url> | sh`), and `cate serve [path] [--connect]`
  starts the workspace's runtime with network access on (`sameNetwork`, or
  `cateConnect` with `--connect`), marks it trusted, and prints a pairing QR
  code and pairing code. `serve` is a command of the installed runtime, not a
  `cate` API method.
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
  runtime.json          { runtimeId, root, pid, version, protocol, endpoints }
  document.json         the document (9.1)
  sessions/<panelId>.json   persisted session state
  buffers/<hash>.bin    unsaved editor buffers (Yjs updates)
  settings.json         workspace settings (hand-editable)
  secrets.json          0600: browser passwords, runtime key pair
  pairings.json         paired devices: public key, name, paired at, last seen
  trust.json            { trusted, decidedAt }
  grants.json           granted paths outside the root
  skills/sources.json   the workspace's skill sources
  browser/              history.json, bookmarks.json, downloads/
  t3/                   the T3 harness root: instances/<checkout hash>/,
                        provider-profile.json, provider-secrets/
  agents/               hooks/ (hook bridges), changes/ (change history),
                        missions.json
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
  `drafts/` (connected editors), `worktrees/` (checkouts) and its
  `.gitignore`.
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
- After binding, the daemon writes `runtime.json`.
- **A client on the runtime's machine** computes the `runtimeId` from the root,
  connects to the socket, and if nothing answers runs
  `~/.cate/runtime/<version>/runtime/bin/node
  ~/.cate/runtime/<version>/runtime.cjs serve <root> --detach` and retries
  until connected (10 s budget).
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
confirmation in the view, and then sends `runtime.stop`. Idle suspend inside a
running runtime still parks idle PTYs and T3 servers.

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
  - **Same network**: the runtime listens for WebSocket connections on a LAN
    port (path `/cate/<runtimeId>`) and advertises `_cate._tcp` over mDNS with `runtimeId` in the TXT
    record. The pairing payload also carries its addresses, so a client that
    cannot use mDNS still connects.
  - **Cate Connect**: the runtime listens on the LAN exactly as for same
    network, and also keeps a registration with the service, so a device on
    the same network still connects directly. A client asks the service for the runtime; the service relays the WebRTC
    offer, answer and ICE candidates, and a STUN server lets both sides find
    their public address. Client and runtime then talk over a direct WebRTC
    data channel. The service never carries workspace traffic.
- The client side of every transport is portable (`client/` side), except the
  raw socket, which each shell provides (the desktop shell through Node,
  mobile through its platform).
- Without a relay, a direct connection can fail when both sides are behind
  strict NATs; the client then says it could not connect directly and
  suggests same network.

### 7.6 Security

**`runtime/security`** is one layer used by both network transports. It is
portable (a `client/` and a `runtime/` side over one pure-JS Noise
implementation), so the mobile client uses the same code.

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
  anything. The LAN WebSocket needs no TLS certificates for the same reason.
- **Revocation.** The workspace's settings page lists its paired devices
  (`pairing.list`). Removing
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
- **Cate Connect** (registry, signaling, STUN) lives in its own repository and
  is deployed separately. This repository holds only its client,
  **`runtime/connect`**: the runtime's registration and connection setup on
  both sides, written against the service's protocol. The runtime registers
  over a Noise connection to the service, which binds the `runtimeId` to the
  runtime's static key on first registration and refuses another key for it
  afterwards. Even if that failed, clients would refuse any key but the one
  they pinned. Tests run against a
  local stand-in for the service.

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
- `runtime`: `stop`, `update`, `info`, `perf`.

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

- The client and runtime compare protocol majors on `hello`. When they differ,
  the client shows that the workspace runtime needs an update. One action
  sends `runtime.update { version }` with the client's own version: the
  daemon installs that release from GitHub Releases (or, for a local runtime,
  from the tarball the desktop app installed), restarts itself, and the client
  reconnects. Updating stops the runtime's terminals and agents, so the view
  lists them and asks first, as for "Stop workspace runtime".
- Runtimes never update on their own. A local runtime started by the desktop
  app runs the app's tarball, so it matches the app after its next start.

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
| Appearance (`kernel/ui`) | `activeThemeId`, `systemLightThemeId`, `systemDarkThemeId`, `customThemes`, `uiScale` | |
| Editor (`panels/editor`) | `editorFontSize`, `editorFontFamily` | |
| Canvas (`client/layout`) | `zoomSpeed`, `canvasGridStyle`, `canvasBackgroundImagePath`, `canvasBackgroundImageOpacity`, `showWorktreeTerritory`, `snapToGrid`, `placementPicker`, `autoFocusLargestVisibleNode` | |
| Relations (`workspace/relations`) | `savedPanelRelationLabels` (a personal label library) | `panelRelationsEnabled` |
| Terminal (`services/terminal`) | `terminalFontFamily`, `terminalFontSize`, `terminalScrollSpeed`, `terminalContrast`, `terminalCursorBlink`, `terminalOptionIsMeta`, `terminalLinkOpenTarget` | `defaultShellPath`, `terminalScrollback` (kept by the headless terminal), `autoSuspendIdleTerminals` |
| Browser (`services/browser`) | `browserProxyUrl` (the client's own upstream proxy; may hold credentials) | `browserHomepage`, `browserSearchEngine`, `browserNewTabBehavior` |
| Sidebar (`client/ui`) | `sidebarTintOpacity`, `showFileExplorerOnLaunch`, `showSkillsInWorkspaceOverview` | |
| Notifications (`client/ui`) | `notificationsEnabled`, `notifyOnlyWhenUnfocused` | |
| Shortcuts (`kernel/ui`) | `customShortcuts` | |
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
interface DocWindow { id: WindowId; kind: 'main' | 'detached'; dock: DockNode | null; bounds?: Rect }
```

- Every panel has exactly one placement: a tab in a dock stack of a window, or
  a tab in the mini dock of a canvas node. The placement index is derived,
  never stored twice.
- A canvas panel's record names its `canvasId`. A canvas is created with its
  canvas panel (`addPanel`) and removed with it (`removePanels` removes the
  canvas and the panels on it; the view asks first). A canvas panel cannot
  be placed on a canvas.
- Viewport, zoom, active tab and selection are client state and not in the
  document.
- Detached window bounds are shared; each client clamps them to its own
  screens. The main window's bounds are device state.

**Ops** (each carries an `opId`; several can be sent as one atomic `batch`):

| Group | Ops |
|---|---|
| Records | `addPanel(record, at)`, `replacePanel(record)` (a surface becoming the picked type: same id, the old session is disposed and the new one started), `updatePanel(id, patch)`, `removePanels(ids)` |
| Placement | `placePanel(id, at)`, where `at` is a tab in a stack (`{to: 'stack', dock, stackId, after?}`), a new stack beside a stack or split (`{to: 'split', dock, beside, side, stackId, splitId}`), a new canvas node (`{to: 'canvas', canvasId, nodeId, stackId, rect}`) or a new detached window (`{to: 'window', windowId, stackId, bounds}`). `dock` is a window's dock or a canvas node's mini dock. Placing an already placed panel moves it. |
| Containers | `setSplitRatio(splitId, ratios)`, `setNodeRects(canvasId, [{nodeId, rect}])`, `setWindowBounds(windowId, bounds)`, `closeWindow(windowId)` (removes its panels; the view asks first) |
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
- Container values (split ratios, rects, bounds, record fields) are last write
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
  untrusted workspace shows the trust dialog; the answer is
  `workspace.setTrust`. `cate serve` trusts the workspace it serves. Because
  every client is the same, one person's decision applies to everyone.
- The client's workspace list entry (section 12) is written by the client, not
  the runtime.

### 9.3 Canvas

**`workspace/canvas`**: the canvas model in `contract.ts`: canvases, nodes,
geometry, node mini docks, free-slot placement (finding a rect for a new node)
and arrangement. It is pure document logic used by the document runtime and by
the client's optimistic mirror. The client draws it (`client/layout/canvas`).

### 9.4 Files

**`workspace/files`**:

- **runtime**: the `file` capability (read, write, stat, list, watch, import
  dropped entries, the `buffer` stream of an open file, and the
  `storeDownload` and `storeScreenshot` byte streams that write a client's
  finished browser download to `browser/downloads/` and an annotated
  screenshot to `screenshots/` in the workspace data) and `search` (ripgrep
  on the host); path validation against the root, worktree checkouts, the
  workspace data directory and grants; exclusions.
- **Open buffers**: one Yjs document per open file, however many editor
  panels show it. Loaded on first open, saved on `save` with the hash of the
  content it was loaded from (a stale hash fails with `conflict`), persisted
  to `buffers/` while it has unsaved edits, dropped when no editor shows it
  and it is clean.
- **External changes**: the watcher reloads a clean buffer, and marks a dirty
  buffer as conflicting; any viewer resolves it (three-way merge in the
  editor view).
- **client**: the fs client, the refcounted watch manager and `attachBuffer`,
  which binds a `file.buffer` stream to a local Yjs document.
- **ui**: the file explorer and the search view.

### 9.5 Repository

**`workspace/repository`**:

- **runtime**: the `vcs` capability (git, `gh` on the host, worktrees, PRs,
  merge), git status (one monitor per checkout; clients subscribe), and the
  worktree lifecycle: create and remove as runtime operations that write
  `WorktreeMeta` status ops, move or close bound panels
  (`closeWorktreePanelsOnDelete`), and inherit worktrees for new panels.
  Checkouts live under `<repo>/.cate/worktrees/<slug>`; panels bind by
  `worktreeId`.
- **client**: git status store, worktree hooks.
- **ui**: source control view, repository and PR overviews, worktree menus and
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
- **ui**: the skills dialog, the workspace skills tree, skills settings.

### 9.7 Relations

**`workspace/relations`**:

- **contract**: the typed relation graph between panels (`use`, `context`,
  `verify`, `trigger`) and `compileRelationContext`, which the agents service
  uses for prompt context.
- **runtime**: **connected editors**: an editor connected to a terminal or chat
  panel shares a working file with the agent (an untitled editor gets
  `.cate/drafts/<id>.md`), autosaves, and is flushed before a prompt is
  submitted (`docs/connected-editors.md`).
- **ui**: the relation handle, selector and context toggle. Relation drawing
  is in `client/layout/canvas`.

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
  The PTY size follows the most recently active viewer.
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
  runtime's machine through loopback routing, everything else from the
  client's own network, so a URL means the same page on every client.
  Navigating in any client changes the session's URL, and every client
  follows. What lives inside the page (scroll, form input, login cookies) is
  per client.
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
  needed and sends document ops or session ops.
- **ui**: the usage overview, provider settings.
- **Consumers**: the chat panel, the t3 runner, settings, usage.

### 10.4 Agents

Owns the agent vocabulary of section 2. All of it runs in the runtime.

- **contract**: the `AGENTS` registry. Each `AgentDef` declares its runners:
  `runners: { terminal: {command, hooks, resume, sessionStore},
  t3?: {providerId, driverId} }`, plus skills targets, process matching and
  prompt-context hooks. Every per-agent table is a total
  `Record<AgentId, …>` (an agent without an entry says so with `null`), so a
  new agent is a compile error until every table has it. Also the session,
  runner and mission types, and the `cate.agent.*` and `cate.codingAgent.*`
  API specs.
- **runtime**: the `agents` capability:
  - hook bridges and repo hook files (per `agentHookInjection`), hook
    ingestion and normalization, pid presence;
  - the **status** state machine, driven only by hook events and pid presence
    (there is no screen scraping);
  - change history per checkout (from terminal hooks and from T3) in
    `agents/changes/`;
  - session store readers per agent, conversation reads, resume stamps,
    Hermes integration;
  - the runner registry: `sessionFor(panel)` answers which agent session a
    panel hosts;
  - prompt context from relations, and agent notification events.
- **Missions**: supervisor, workers and admission (at most 5 concurrent
  workers). Workers use the `terminal` runner.
- **runners/terminal**: plugs into the terminal service (hook env on PTY spawn,
  status, resume, prompt submission into the PTY).
- **runners/t3**: plugs into the t3 service (thread state, prompt dispatch to
  T3 orchestration, change capture on harness start).
- **ui**: the changes pill, activity title, logos, hook settings.
- **Consumers**: terminal and chat panels, review (changes), sidebar and dock
  tabs (status), `cate.agent.*`, `cate.codingAgent.*`.

Dependencies point one way: `agents → terminal`, `agents → t3`. Terminal and
t3 never import agents.

### 10.5 Notifications

Services publish notification events from the runtime
(`{kind, panelId, title, body}`: an agent finished or needs attention, a
command failed, `cate.ui.notify`). Each client decides whether to show one,
from its notification settings and its own focus, and shows it through
`ClientUi`.

## 11. Panels

### 11.1 Framework

`panels/framework`: `definePanel`, `PanelSession`, the session host, the
panel registry and factory and the surface broker (runtime), `createPanel`,
records, session persistence. The client half (the view slot, `PanelHost`,
close guards) is `client/host` (section 12.1).

Each panel type is one folder, `panels/<type>/`:

- `definition.ts`: pure. What the type is (label, icon **name**, tint, sizes,
  flags), the client features its view `requires` (section 12.2), its record
  fields, its session channel schema (snapshot, changes and ops), its
  `cate.<type>.*` API spec, `create(options, kit)`, and the hooks generic code
  asks instead of branching on the type: `checkoutPath`, `ownsKeyboard`,
  `claimsShortcuts`, `commands` (command palette entries, each a session op
  to send, with the features it `requires`), `describe`, `chrome` (dock chrome
  flags), `relation` (its role in the relation graph, section 9.7), plus the
  `surface`, `requiresFolder`, `worktreeBinding` and `splitMenuOrder` flags.
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
- `view/`: the client view. `view/index.ts` registers the view component with
  `registerPanelView(type, () => import(...))` and, where closing can lose
  work, a close guard with `registerPanelCloseGuard` (both from
  `client/host`). The view renders the snapshot, sends ops, holds one-shot
  intents, asks the user before destructive ops, and owns a native surface
  where the type has one.
- `parts/`: supporting modules, split by side (`parts/view/`,
  `parts/runtime/`, pure files at the top).

Three index files at the top of `src/panels/` list the types, so no generic
code names one:

- `definitions.ts`: `PANEL_DEFINITIONS` (every definition, pure; clients read
  it for menus, the surface picker and fresh records).
- `runtime.ts`: `PANEL_RUNTIMES`, one entry per type adapting the daemon's
  services to the type's `runtime.ts`; the composition root imports it.
- `api.ts`: `CATE_API`, every `cate` API namespace; the daemon's router and
  the CLI both read it.

Adding a type is its folder, its name in `PANEL_TYPES`
(`workspace/document/contract`), one entry in each index file that applies,
and one import of its `view/` entry in each shell. No generic code branches
on `panel.type`.

### 11.2 The panel contract

Every panel type meets the same contract.

1. **The session owns the panel, and the session runs in the runtime.** It
   owns all live execution and state and keeps working with no client
   connected. Constructors have no side effects; work starts in `start()`.
   Sessions persist their own state to `sessions/<panelId>.json` through the
   kit.
2. **Views render snapshots and send ops.** A snapshot is plain JSON (no
   class instances, no `Map`). A view talks to its session channel, and
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
   confirmations, errors, pickers, notifications, clipboard, external links and
   OS file actions go through the port. A view asks its user before it sends
   the op and passes the answer in the op (`close {discard: true}`,
   `saveAs {path}`). Sessions never ask: an op that would lose work without
   an explicit choice fails with `dirty`. `cate` API callers pass the same
   choices as arguments. Each shell installs its own `ClientUi`. Generic UI
   that closes panels (a tab's close button, a window closing) runs the close
   guard each type's view registered, with a session handle whether or not
   the view is mounted, and then sends one `removePanels` op.
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
| browser | services/browser | tabs, URLs, titles, navigation state, loading, downloads | webview | each client loads the page itself |
| editor | workspace/files, workspace/relations | file, dirty, conflict, mode (code, preview, merge), connected draft; buffer as Yjs stream | Monaco (y-monaco) | one buffer per file; three-way merge, markdown preview |
| review | workspace/repository, services/agents | source (git diff or agent changes), file list, selection, notes, status | diff views | |
| canvas | workspace/canvas | none; renders its canvas from the document | `client/layout/canvas` | cannot sit on a canvas |
| surface | framework | none | picker | becomes the picked type through `replacePanel` |

## 12. Client

The portable client: everything a desktop app or a phone needs, with no
Electron and no Node. It renders the runtimes' state and holds only device and
client state. Where clients differ, they differ by declared features (12.2).

### 12.1 Modules

- **`client/connections`**: one connection per open workspace runtime: finding
  it (the local socket, mDNS, Cate Connect), starting a local one, pairing,
  the security layer, the typed capability proxies (filling the
  `kernel/rpc` slot), session channel subscriptions, reconnect with backoff,
  and the "offline" state (last-seen time, retrying in the background).
  Each connection implements `dialLoopback(port)` (section 12.3).
- **`client/workspaces`**: the device's workspace list: local recents, paired
  workspaces and their pinned keys (`known-runtimes.json`), sidebar order.
- **`client/document`**: the client's mirror of each open workspace's
  document, with optimistic ops (section 13.5) and subscriptions. The stores
  that show records, docks and canvases are selectors over it.
- **`client/host`**: the panel view slot (`registerPanelView`, filled by each
  panel's `view/` entry), `PanelHost` (the only panel renderer, resolving
  views through the slot, or the placeholder of 12.2), `PanelSessionBoundary`
  and the session handles it shares, `PersistentPanelHost` and the surface
  registry (keeps webviews alive across tab and workspace switches and
  off-screen on a canvas; only native surfaces need this), keep-mounted
  panels, error boundaries, `createPanel`, panel targeting
  (`pickPanelPlace`), and closing: `registerPanelCloseGuard` and
  `closePanels`, which asks every guard before one `removePanels` op.
- **`client/layout`**:
  - `dock`: the dock views over the document's dock trees; the same tree shape
    backs each canvas node's mini dock.
  - `canvas`: the canvas view: surface, nodes, toolbar, minimap, snap guides,
    selection, viewport and zoom, the worktree territory layer (WebGL),
    relation drawing, panel targeting overlay, screenshot annotation.
  - `drag`: drag operations inside and across windows, the drag ghost, file
    drops (imported to the host through `workspace/files`).
  - `windows`: opening and closing detached windows from the document, and
    the cross-window panel index derived from it.
- **`client/ui`**: the command palette, onboarding, welcome and update
  dialogs, the settings window frame, the sidebar frame (composing workspace
  UI), the pairing screens (show and scan QR, enter code, paired devices), the
  e2e harness hooks.

### 12.2 Client features

Clients do not all support the same things. A phone has no windows, may have
no page driver and no passkeys. The contract that says what a client can do is
one closed list of features, `ClientFeature` in `kernel/rpc/contract.ts`:

| Feature | The client can | Required by |
|---|---|---|
| `webview` | host web pages in a native surface, with loopback routing (12.3) | browser and chat panel views |
| `pageDriver` | run page operations on its webviews: accessibility snapshots, actions, screenshots, waits, code cells | being the driving client (10.2) |
| `passkeys` | answer WebAuthn requests through the OS | passkey sign-in in the browser view |
| `windows` | open detached windows | rendering detached windows as windows |
| `canvas` | render and edit canvases | canvas panel view, canvas placement targets |
| `fileDrop` | take files dragged in from the OS | drop targets (`client/layout/drag`) |
| `osFiles` | reveal and open files in the OS, show native file pickers | `ClientUi` file actions |
| `osNotifications` | show OS notifications | notification display |
| `screenCapture` | capture its own window | screenshot button and annotation |
| `clipboard` | read and write the system clipboard | copy, paste, OSC 52 |
| `camera` | scan a QR code | scanning a pairing QR (without it, the pairing code is typed) |

Rules:

1. **Declared once.** The list is closed. Adding a feature is a protocol minor
   version; an unknown feature in `hello` is ignored.
2. **Declared per connection.** A client sends its features in `hello`
   (7.8). The runtime keeps them per connection and shows them in presence.
   Each shell declares what it supports on its platform: the desktop shell
   declares all of them except `camera`, and `passkeys` only on macOS; the
   mobile shell declares its set when it lands. Deciding the set is the only
   place a shell looks at its platform.
3. **Asked, never inferred.** Client code asks `clientHas(feature)`; runtime
   code asks the connection. Nothing asks which shell, platform or device
   kind a client is (the one-client test, section 3).
4. **Views declare what they need.** A panel definition lists the features its
   view `requires`. On a client without them, `PanelHost` renders a
   placeholder ("Not available on this device") in the panel's place. The
   panel, its session and its placement are untouched, and every other client
   still shows it. Commands, menu items and drop targets that need a missing
   feature declare it the same way and are hidden.
5. **`ClientUi` follows the features.** Port methods tied to a feature are
   optional, and a shell installs only what it declares.
6. **The document never depends on features.** Placement is shared and the
   same for everyone. A client without `windows` shows each detached window
   as a switchable stack in its one window; a client without `canvas` shows a
   canvas's panels as a list. That is rendering only; no op is sent.
7. **The runtime uses features only to choose a client for client-side
   work:** the driving client of a browser panel (`pageDriver`). Everything
   else the runtime sends to every client, and each client handles it within
   its features (a notification event is an OS notification with
   `osNotifications`, an in-app toast without).
8. **Tested.** A contract test checks that every `requires` names a known
   feature. `PanelHost.test.tsx` renders panels for a client that declares
   no features: each one renders its view or the placeholder, and nothing
   throws.

### 12.3 Loopback routing

Terminals and agents start dev servers on the runtime's machine, so in the
browser and chat panels `localhost` means the runtime's machine on every
client (D10). This is what makes a shared `http://localhost:3000` the same page
for everyone, and what lets a network client open the chat panel's T3 UI.

- **Which hosts.** `localhost`, `*.localhost`, `127.0.0.1` and `[::1]`, any
  port.
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
- **Mobile** uses its platform's webview proxy configuration; a mobile shell
  that cannot route loopback does not declare `webview`.

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
  `panel.target.set` is `cate panel set`). The
  only command that is not an API method is `cate serve` (section 7.1).

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
| `cate.agent.*` | `list`, `read`, `wait`, `send` | services/agents (resolves session to runner) | service |
| `cate.codingAgent.*` | `create`, `send`, `list`, `wait`, `inspect`, `review`, `apply`, `keep`, `discard`, `stop` | services/agents (missions) | service |

There is no `cate.panel.focus`: focus is client state. Page operations are
not CLI commands (`cli: {command: false}`); the CLI reaches them through
`cate browser run`.

## 15. Shells

- **`shells/desktop`**
  - **main**: app entry, windows and the window registry, menus, native
    dialogs, notification display, the updater (including installing the
    bundled runtime tarball to `~/.cate/runtime/<version>/`), analytics and
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
  - **renderer**: mounts the client, imports every panel's `view/` entry
    (which fills the view slot), installs the desktop `ClientUi` and the
    shell's ports, window chrome, the perf HUD.
- **`shells/mobile`**: its own `ClientUi`, its own chrome, its platform
  sockets and webview proxy, its declared features, the same client. Later.

Quitting the desktop app closes its windows and connections. Each runtime then
follows its `runtimeLifetime`, so the desktop shell's quit blockers only guard
client-local work (a file drop still importing).

## 16. Persistence

| Where | Files |
|---|---|
| Workspace data, `~/.cate/workspaces/<runtimeId>/` | see section 7.2 |
| Project `<root>/.cate/` | `skills.json`, `drafts/`, `worktrees/`, `.gitignore` (ignores everything but `skills.json`); `skills-mirror.json` inside each worktree checkout's `.cate/` |
| Machine, `~/.cate/runtime/<version>/` | the installed daemon (the program, not state) |
| Client device (Electron `userData`, through `DeviceStore`) | `settings.json` (client settings, custom themes), `ui-state.json` (minimap corner, onboarding progress), `boot.json` (main window bounds, theme boot cache, last workspace), `workspaces.json` (recents, paired workspaces, sidebar order), `known-runtimes.json` (pinned runtime keys), `device-key.json` (`0600`), `canvas-backgrounds/`, `update-state.json`, `install-id`, `analytics-state.json`, `pending-events.jsonl`, Chromium partitions (one per workspace), logs |

Every JSON state file above is written through `kernel/state`. The others
(sockets, Yjs buffers, T3's own files, logs, downloads, screenshots, Chromium
data) are written by their owner directly.

## 17. Folder layout

```
src/
  kernel/
    rpc/  api/  settings/  lifecycle/  state/  log/  ui/
  runtime/
    daemon/                 main.ts (the program), entry.ts and compose/ (the
                            composition root), release, install layout,
                            lifetime, update; node/ desktop/ ui/ sides
    data/                   workspace data directory, runtime.json, secrets
    transports/             local socket, same-network WebSocket, WebRTC data
                            channel; client, node and runtime sides
    security/               Noise handshake, keys, fingerprints
    pairing/                the pairing capability, secrets, codes, QR payload,
                            pairings.json
    connect/                Cate Connect client (registration, signaling)
    server/  tunnel/  power/  generic host capabilities
  workspace/
    document/               contract runtime/           schema, ops, ordering,
                            persistence, presence
    lifecycle/              contract runtime/ ui/       open/close, trust
    canvas/                 contract                    model and placement
    files/                  contract runtime/ client/ ui/
    repository/             contract runtime/ client/ ui/
    skills/                 contract runtime/ ui/
    relations/              contract runtime/ ui/
  services/
    terminal/               contract runtime/ client/
    browser/                contract runtime/ client/ desktop/ ui/
    t3/                     contract runtime/ client/ ui/
    agents/                 contract runtime/ client/ ui/ runners/{terminal,t3}/
  client/
    connections/  workspaces/  document/  host/
    layout/{dock,canvas,drag,windows}/  ui/
  panels/
    framework/              contract runtime/ client/
    terminal/  editor/  browser/  chat/  review/  canvas/  surface/
    definitions.ts  runtime.ts  api.ts      the panel index files
  shells/
    desktop/{contract,main,preload,renderer}/
    mobile/                 later
  cli/                      generic engine; commands from API specs
  shared/                   generic pure utilities only (paths, colors, errors)
  test/                     test support (the vitest log stub, mock ClientUi)
```

Each process has one entry: the daemon (`runtime/daemon`), desktop main, the
preloads, the client in the desktop renderer, the CLI, and later the mobile
app. Each entry bundles only its own side of each module. Tests live next to
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
  definition is valid and every `requires` names a known feature), the
  document convergence test (several clients sending random ops, dropping
  and reconnecting, end with the same document and no op applied twice), the
  security tests (unknown keys, wrong pairing proofs, a man-in-the-middle
  stand-in for Cate Connect, revoked devices), the preload test (each entry
  self-contained) and `daemon.workspace.test.ts` (a real daemon over its
  socket).

## 19. Open questions

Not decided, and deliberately left open:

- **Strict NATs.** Without a relay, some networks cannot connect directly
  through Cate Connect. Whether that ever needs an answer beyond "use same
  network".
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
