// =============================================================================
// Shared TypeScript types for CanvasIDE Electron app
// Ported from Swift source files to maintain exact parity.
// =============================================================================

import type { Theme } from './theme'
export type { Theme } from './theme'

// -----------------------------------------------------------------------------
// Geometry primitives
// -----------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect {
  origin: Point
  size: Size
}

// -----------------------------------------------------------------------------
// Panel types
// -----------------------------------------------------------------------------

export type PanelType = 'terminal' | 'browser' | 'editor' | 'canvas' | 'agent' | 'document'

// -----------------------------------------------------------------------------
// Canvas node
// -----------------------------------------------------------------------------

/** Opaque string identifier (UUID) for canvas nodes. */
export type CanvasNodeId = string

export interface CanvasNodeState {
  id: CanvasNodeId
  /** Primary panel id — the panel the node was originally created from. The
   *  authoritative panel layout lives in `dockLayout` (a per-node dock tree),
   *  but `panelId` is preserved for legacy code paths and as a stable identity. */
  panelId: string
  origin: Point
  size: Size
  zOrder: number
  creationIndex: number
  preMaximizeOrigin?: Point
  preMaximizeSize?: Size
  isPinned?: boolean
  /** Per-node dock layout tree — what's actually rendered inside the node.
   *  Each canvas node owns a private DockStore whose `center` zone holds this
   *  layout. Splits, stacks and drag-and-drop all use the same primitives as
   *  the main dock zones. */
  dockLayout?: DockLayoutNode | null
  animationState?: 'entering' | 'exiting' | 'idle'
}

/** Computed helper — mirrors the Swift `isMaximized` computed property. */
export function isMaximized(node: CanvasNodeState): boolean {
  return node.preMaximizeOrigin != null
}

// -----------------------------------------------------------------------------
// Panel state (renderer-side representation)
// -----------------------------------------------------------------------------

export interface PanelState {
  id: string
  type: PanelType
  title: string
  isDirty: boolean
  filePath?: string
  url?: string
  /** Browser panels only: open tabs (light model). The active tab's url is kept
   *  mirrored to `url` above for session-restore + panel-transfer compatibility,
   *  so older code paths that only read `url` still work. */
  tabs?: BrowserTab[]
  activeTabId?: string
  /** Browser panels only: per-panel HTTP/HTTPS/SOCKS5/PAC proxy. When set, the
   *  panel runs in its own proxy-derived persistent session instead of the
   *  shared browser session. Supports auth (`user:pass@host`), a `;bypass=`
   *  suffix, and `pac://` PAC scripts. See `configureBrowserProxy` in
   *  `src/main/browserProxy.ts`. */
  proxyUrl?: string
  /** When set, EditorPanel renders as a Monaco diff editor. */
  diffMode?: 'staged' | 'working'
  /** Editor panels with a markdown file only: render the rendered preview
   *  instead of the source. Kept per-panel (not local component state) because
   *  a single EditorPanel mount is reused across dock tabs. */
  markdownPreview?: boolean
  /** Unsaved buffer content for scratch (no-filePath) editors. Persisted so
   *  content survives canvas switches and app restarts. */
  unsavedContent?: string
  /** Terminal panels only: explicit working directory override. When unset
   *  the terminal uses the workspace's `rootPath`. Set when the terminal was
   *  created from a dropped folder or worktree to scope it to that path. */
  cwd?: string
  /** Document panels only: sub-type discriminator for the viewer. */
  documentType?: 'pdf' | 'docx' | 'image'
  /** Id of the WorktreeMeta in the parent workspace that this panel is
   *  associated with. Drives the per-panel color accent and the title-bar
   *  "switch worktree" pill. Applies to terminal + agent panels. */
  worktreeId?: string
  /** Terminal panels only. Set to true the first time the user renames the
   *  tab so that subsequent OSC-0/1/2 title escapes from the running agent
   *  no longer overwrite the chosen name. */
  titleUserOverridden?: boolean
  /** Terminal panels only: bumped to force the PTY to be re-spawned in place
   *  (e.g. when switching the terminal to another worktree's checkout). The
   *  registry entry is disposed and `TerminalPanel`'s create effect re-runs at
   *  the new `cwd`. */
  ptyEpoch?: number
}

// -----------------------------------------------------------------------------
// Worktree metadata — per-workspace registry of UI-owned facts about the git
// worktrees Cate manages, keyed by worktree path. This persists ONLY the UI
// metadata (id/color/label). The live facts (branch / isPrimary / isCurrent)
// are authoritative from `git worktree list` (owned by gitStatusStore) and are
// joined onto this metadata at read time by useWorktrees — they are never
// persisted here, so they can't drift out of sync with the repo.
// -----------------------------------------------------------------------------

export interface WorktreeMeta {
  /** Stable client id (uuid). */
  id: string
  /** Absolute filesystem path to the worktree checkout (the join key). */
  path: string
  /** Hex color used for the title-bar pill + panel accent border. */
  color: string
  /** Optional friendly label shown in the sidebar in place of the branch. */
  label?: string
}

// -----------------------------------------------------------------------------
// Workspace metadata — shared across windows, managed by main process
// -----------------------------------------------------------------------------

/**
 * Where a workspace's files physically live, and how the runtime that hosts
 * its terminal/fs/git operations is reached. Absent ⇒ `{ kind: 'local' }` (the
 * migration default for every workspace that predates remote support). Secrets
 * (SSH passphrases/keys) NEVER live here — they are stored encrypted via
 * Electron safeStorage, keyed by runtimeId.
 */
export type RuntimeConnection =
  | { kind: 'local' }
  | {
      kind: 'server'
      /** Routing key; matches the authority in this workspace's rootPath URI. */
      runtimeId: string
      host: string
      user: string
      port?: number
      /** Runtime-absolute root on the server. */
      remotePath: string
    }
  | {
      kind: 'wsl'
      runtimeId: string
      distro: string
      /** Runtime-absolute root inside the distro. */
      distroPath: string
    }

export interface WorkspaceInfo {
  id: string
  name: string
  color: string
  /** Locator string: a bare absolute path for local, a `cate-runtime://`
   *  URI otherwise. See src/main/runtime/locator.ts. */
  rootPath: string
  /** Defaults to { kind: 'local' } when absent (migration rule). */
  connection?: RuntimeConnection
}

/** What the connect UI sends to main to establish a remote runtime. SSH auth
 *  secrets are passed once to be stored encrypted (safeStorage); they are not
 *  echoed back. */
export type RemoteConnectSpec =
  | {
      kind: 'server'
      host: string
      user: string
      port?: number
      remotePath: string
      auth?: { keyPath?: string; passphrase?: string; useAgent?: boolean }
    }
  | { kind: 'wsl'; distro: string; distroPath: string }

export type RuntimeConnectResult =
  | { ok: true; runtimeId: string; rootPath: string; connection: RuntimeConnection }
  | { ok: false; error: string }

/** A connectable host alias parsed from the user's ~/.ssh/config. Wildcard
 *  patterns (`Host *`) are excluded — only concrete aliases the user can dial.
 *  `host` is the resolved HostName (falls back to the alias when unset). */
export interface SshHostEntry {
  alias: string
  host: string
  user?: string
  port?: number
  identityFile?: string
}

/**
 * Canonical lifecycle phase of a remote runtime. Emitted by the main process
 * (RuntimeManager) and projected onto the owning workspace, where it is the
 * single source of truth the UI derives its runtime status from. Local
 * workspaces have no phase (absent ⇒ no runtime).
 *
 *  - `installing`   — bootstrapping the daemon bundle onto the host (pull/push + extract)
 *  - `connecting`   — launching the daemon + protocol/version handshake
 *  - `connected`    — daemon is live; the workspace is fully functional
 *  - `disconnected` — was connected, the channel dropped (daemon crash / network)
 *  - `unreachable`  — connect/launch/handshake failed (bad host/auth/network); retry or edit
 *  - `missing`      — the daemon bundle isn't installed / install failed; needs (re)install
 */
export type RuntimePhase =
  | 'installing'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'unreachable'
  | 'missing'

/** Live connection state pushed to the renderer (RUNTIME_STATUS). */
export interface RuntimeStatusEvent {
  runtimeId: string
  phase: RuntimePhase
  message?: string
}

/** The canonical runtime runtime state stored on a remote workspace. Written
 *  by exactly one path in the renderer (the RUNTIME_STATUS subscription, plus
 *  the optimistic seed during the initial connect before runtimeId is bound).
 *  Absent ⇒ local workspace, or a remote workspace whose runtime hasn't been
 *  contacted yet this session. */
export interface RuntimeStatus {
  phase: RuntimePhase
  /** Human-readable failure reason for unreachable/missing/disconnected. */
  error?: string
}

export interface WorkspaceMutationError {
  code: 'INVALID_ROOT_PATH' | 'INVALID_WORKSPACE_ID' | 'WORKSPACE_NOT_FOUND' | 'DUPLICATE_ROOT'
  message: string
}

export type WorkspaceMutationResult =
  | { ok: true; workspace: WorkspaceInfo }
  | { ok: false; error: WorkspaceMutationError }

// -----------------------------------------------------------------------------
// Window type system — main window vs borderless panel windows (Phase 4)
// -----------------------------------------------------------------------------

export type CateWindowType = 'main' | 'panel' | 'dock'

/** A shadow record of a panel and the window that hosts it. Main maintains the
 *  union across ALL windows (main + detached) and broadcasts it, so every window
 *  can list/reveal the panels that live in OTHER windows (it filters out its own
 *  by panel id). `parentCanvasId` is set for panels nested inside a canvas, so
 *  the overview can render a detached canvas with its children. */
export interface WindowPanelInfo extends WindowPanelReport {
  ownerWindowId: number
  ownerWindowType: CateWindowType
}

/** A single window's report of its panels for cross-window discovery, sent on
 *  appStore change by every window type. Main stamps the owning window + type to
 *  turn each into a WindowPanelInfo. `parentCanvasId` is resolved renderer-side
 *  from the window's canvas stores. */
export interface WindowPanelReport {
  panelId: string
  type: PanelType
  title: string
  workspaceId: string
  /** Set when this panel lives inside a canvas panel in its window. */
  parentCanvasId?: string
  /** The panel's worktree tag (if any), so the overview can tint a detached
   *  panel's row title with its worktree accent — resolved against the (same)
   *  workspace's worktree registry, which the listing window already holds. */
  worktreeId?: string
  /** Live agent state for a terminal/agent panel, stamped by the OWNER window
   *  (the only window that receives this panel's activity scans). Carried so the
   *  overview can render a detached row's running shimmer / awaiting indicator
   *  exactly like a local row. */
  agentState?: AgentState
  /** Agent display name (gated on the agent still being present), so the owner's
   *  agent logo can be resolved for the detached row's icon. */
  agentName?: string | null
  /** Whether the owner window's scan found listening ports for this panel, so a
   *  detached row shows the same port dot as a local one. */
  hasPorts?: boolean
}

export interface CateWindowParams {
  type: CateWindowType
  /** For panel windows: the panel type being displayed */
  panelType?: PanelType
  /** For panel windows: the panel ID */
  panelId?: string
  /** For panel/dock windows: workspace context */
  workspaceId?: string
}

/** Payload sent to a dock window after creation to initialize its dock state */
export interface DockWindowInitPayload {
  panels: Record<string, PanelState>
  dockState: WindowDockState
  workspaceId: string
  /** Owning workspace's project root, so the detached window's stub workspace
   *  can resolve a cwd for newly-created terminals instead of re-prompting. */
  rootPath?: string
  /** Owning workspace's worktree registry (id/path/color/label). Carried so the
   *  detached window's stub workspace can resolve each panel's worktree accent —
   *  without it, worktree pills/tab tints render colorless in detached windows. */
  worktrees?: WorktreeMeta[]
  /** Session-restore marker. When true, the receiving shell arms scrollback
   *  replay for EVERY terminal panel (top-level + canvas children) by its stable
   *  panelId — identical to the main window's restore. Absent/false for a fresh
   *  live detach, where the terminal arrives live via PANEL_RECEIVE instead. */
  restore?: boolean
  /** Session-restore only: per terminal panelId → its last working directory, so
   *  a respawned terminal lands where it was. Keyed by the stable panelId (same
   *  as the main window's snapshot.terminalCwds). */
  terminalCwds?: Record<string, string>
  /** Session-restore only: per top-level canvas panelId → its reconstructed
   *  canvas hydration (nodes/viewport + child panels), so EVERY canvas tab
   *  restores its children rather than only the first. Absent for a fresh live
   *  detach. */
  canvasStates?: Record<string, PanelTransferSnapshot['canvasState']>
}

/** A single detached canvas panel's persisted layout (nodes + viewport). */
export interface CanvasLayoutSnapshot {
  nodes: Record<CanvasNodeId, CanvasNodeState>
  viewportOffset: Point
  zoomLevel: number
}

/** Snapshot of a detached dock window for session persistence */
export interface DetachedDockWindowSnapshot {
  dockState: DockStateSnapshot
  panels: Record<string, PanelState>
  bounds: { x: number; y: number; width: number; height: number }
  workspaceId: string
  /** Per terminal panelId → its last working directory, so a respawned terminal
   *  lands where it was. Scrollback itself is persisted on disk keyed by the
   *  stable panelId (`<panelId>.scrollback`), exactly like the main window — no
   *  ptyId indirection, so restore never depends on a captured live-ptyId map. */
  terminalCwds?: Record<string, string>
  /** Per-canvas-panel layout snapshots (nodes + viewport), keyed by canvas panelId,
   *  so a detached canvas window restores its children instead of landing empty.
   *  Optional for back-compat with session files written before this existed. */
  canvasStates?: Record<string, CanvasLayoutSnapshot>
}

// -----------------------------------------------------------------------------
// Panel transfer protocol — cross-window panel migration (Phase 4)
// -----------------------------------------------------------------------------

export interface PanelTransferSnapshot {
  panel: PanelState
  geometry: { origin: Point; size: Size }
  sourceLocation: PanelLocation

  /** Owning workspace's project root. Carried so a detached window's stub
   *  workspace inherits the cwd context (new terminals resolve to the project
   *  folder instead of re-prompting). */
  rootPath?: string

  /** Owning workspace's worktree registry (id/path/color/label). Carried so the
   *  receiving window's stub workspace can resolve the panel's (and a canvas's
   *  children's) worktree accent colors — pills/tab tints would otherwise be
   *  colorless in detached windows whose stub workspace has no worktree records. */
  worktrees?: WorktreeMeta[]

  // Terminal-specific
  terminalPtyId?: string
  terminalScrollback?: string
  /** Set during session restore: ptyId of the original (now-dead) PTY whose
   *  scrollback log should be replayed into the freshly-spawned terminal. */
  terminalReplayPtyId?: string

  // Editor-specific
  editorState?: {
    cursorPosition: { line: number; column: number }
    scrollTop: number
    unsavedContent?: string
  }

  // Browser-specific
  browserState?: {
    url: string
    canGoBack: boolean
    canGoForward: boolean
  }

  // Canvas-specific — child nodes/viewport for nested canvas panels.
  // Without this, detaching a canvas panel to a new window would land with an
  // empty store (fresh per-process), losing every panel inside it.
  //
  // `childPanels` carries the PanelState records for every panel referenced
  // by the canvas's nodes (including tabbed panels inside a node's mini-dock).
  // Without these the receiving window can't resolve child panel types/titles
  // and falls back to a generic "Panel" stub.
  //
  // `childTerminals` carries each child terminal's LIVE-transfer hand-off, keyed
  // by child panel id: the receiving window RECONNECTS to the still-running
  // process (`ptyId` + `scrollback`) — the same live transfer a top-level
  // terminal gets via `terminalPtyId`. Cold session restore does NOT use this:
  // the receiving shell arms scrollback replay for every terminal panel by its
  // stable panelId (see DockWindowInitPayload.restore), mirroring the main window.
  canvasState?: CanvasLayoutSnapshot & {
    childPanels: Record<string, PanelState>
    childTerminals?: Record<string, { ptyId?: string; scrollback?: string }>
  }
}

// -----------------------------------------------------------------------------
// Dock zone types — VS Code-style panel docking (Phase 2)
// -----------------------------------------------------------------------------

export type DockZonePosition = 'left' | 'right' | 'bottom' | 'center'

/** Side zones only (excludes center) — for visibility toggling and sizing */
export const SIDE_ZONES: DockZonePosition[] = ['left', 'right', 'bottom']
/** All dock zones including center */
export const ALL_ZONES: DockZonePosition[] = ['left', 'right', 'bottom', 'center']

/** Recursive layout tree node for dock zones */
export type DockLayoutNode = DockSplitNode | DockTabStack

export interface DockSplitNode {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  children: DockLayoutNode[]
  ratios: number[] // proportional sizes, sum = 1.0
}

export interface DockTabStack {
  type: 'tabs'
  id: string
  panelIds: string[]
  activeIndex: number
}

export interface DockZoneState {
  position: DockZonePosition
  visible: boolean
  size: number // width (left/right) or height (bottom) in pixels
  layout: DockLayoutNode | null // null = empty/collapsed
}

export interface WindowDockState {
  left: DockZoneState
  right: DockZoneState
  bottom: DockZoneState
  center: DockZoneState
}

/** Where a panel lives — determines how/where it renders */
export type PanelLocation =
  | { type: 'canvas'; canvasId: string; canvasNodeId: string }
  | { type: 'dock'; zone: DockZonePosition; stackId: string }
  | { type: 'detached'; windowId: number }

/** Drop target for dock drag-and-drop */
export type DockDropTarget =
  | { type: 'split'; stackId: string; edge: 'top' | 'bottom' | 'left' | 'right' }
  | { type: 'tab'; stackId: string; index?: number }
  | { type: 'newWindow'; screenPosition: Point }
  | { type: 'zone'; zone: DockZonePosition }

// -----------------------------------------------------------------------------
// Canvas state snapshot — used for multi-canvas support (Phase 2+)
// -----------------------------------------------------------------------------

export interface CanvasSnapshot {
  id: string
  canvasNodes: Record<CanvasNodeId, CanvasNodeState>
  zoomLevel: number
  viewportOffset: Point
}

// -----------------------------------------------------------------------------
// Workspace state — full state including per-window canvas/panel data
// -----------------------------------------------------------------------------

export interface WorkspaceState {
  id: string
  name: string
  color: string
  rootPath: string
  /** Runtime connection for a remote/WSL workspace (absent ⇒ local). Mirrors
   *  WorkspaceInfo.connection; drives reconnect-on-restore. */
  connection?: RuntimeConnection
  /** Canonical runtime runtime state for a remote workspace (set from
   *  RUNTIME_STATUS, seeded during initial connect). The single source of
   *  truth the UI derives editability + the lock overlay from. Absent ⇒ local,
   *  or remote-not-yet-contacted. See lib/workspaceRuntime.ts. */
  runtime?: RuntimeStatus
  /** Additional project roots opened alongside the primary `rootPath`.
   *  Used to keep multiple repos in one canvas. Order is user-controlled. */
  additionalRoots?: string[]
  /** Worktrees managed for this workspace. Includes the primary rootPath as
   *  an `isPrimary: true` entry once it has been materialized on first load. */
  worktrees?: WorktreeMeta[]
  rootPathError?: string | null
  isRootPathPending?: boolean
  panels: Record<string, PanelState>
  // PERSISTENCE-ONLY projection of the live per-workspace DockStore. Read via
  // getWorkspaceDockSnapshot(workspaceId), never directly.
  dockState?: { zones: WindowDockState; locations: Record<string, PanelLocation> }
  // PERSISTENCE-ONLY per-canvas projection, keyed by canvas panel id. A workspace
  // can host several canvas panels; each canvas's live CanvasStore projects into
  // this map at save time, and a never-mounted (cold-start) canvas restores from
  // it — the single source for canvas geometry, primary and secondary alike.
  // Read via getCanvasSnapshotForPanel(canvasPanelId), never directly.
  canvases?: Record<string, CanvasSnapshot>
  activeCanvasId?: string
}

// -----------------------------------------------------------------------------
// Theme selection
// -----------------------------------------------------------------------------

/** Active theme selection: the literal 'system' (auto light/dark) or a theme id
 *  (built-in or custom). */
export type ThemeSelection = 'system' | string

// -----------------------------------------------------------------------------
// Browser search engine
// -----------------------------------------------------------------------------

export type BrowserSearchEngine = 'google' | 'duckDuckGo' | 'bing' | 'brave'

/** What a new browser panel / new tab opens to. */
export type BrowserNewTabBehavior = 'startPage' | 'homepage'

export const SEARCH_ENGINE_URLS: Record<BrowserSearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckDuckGo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
}

// -----------------------------------------------------------------------------
// Keyboard shortcuts
// -----------------------------------------------------------------------------

export interface StoredShortcut {
  key: string
  command: boolean
  shift: boolean
  option: boolean
  control: boolean
}

/** Build a StoredShortcut with defaults matching the Swift initializer. */
export function storedShortcut(
  key: string,
  mods: { command?: boolean; shift?: boolean; option?: boolean; control?: boolean } = {},
): StoredShortcut {
  return {
    key,
    command: mods.command ?? false,
    shift: mods.shift ?? false,
    option: mods.option ?? false,
    control: mods.control ?? false,
  }
}

/** Mirrors StoredShortcut.displayString from Swift. */
export function displayString(s: StoredShortcut): string {
  // An empty key means the binding is disabled (see clearShortcut).
  if (!s.key) return 'None'
  const parts: string[] = []
  if (s.control) parts.push('\u2303') // ⌃
  if (s.option) parts.push('\u2325')  // ⌥
  if (s.shift) parts.push('\u21E7')   // ⇧
  if (s.command) parts.push('\u2318') // ⌘
  let keyText: string
  switch (s.key) {
    case '\t':
      keyText = 'TAB'
      break
    case '\r':
      keyText = '\u21A9' // ↩
      break
    case ' ':
      keyText = 'SPACE'
      break
    default:
      keyText = s.key.toUpperCase()
  }
  parts.push(keyText)
  return parts.join('')
}

// All shortcut actions. Keep ShortcutAction, SHORTCUT_ACTIONS,
// SHORTCUT_DISPLAY_NAMES, and DEFAULT_SHORTCUTS in sync.
export type ShortcutAction =
  | 'newTerminal'
  | 'newBrowser'
  | 'newEditor'
  | 'newAgent'
  | 'newCanvas'
  | 'newFile'
  | 'closePanel'
  | 'toggleSidebar'
  | 'toggleFileExplorer'
  | 'toggleSearch'
  | 'toggleMinimap'
  | 'commandPalette'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'focusNext'
  | 'focusPrevious'
  | 'saveFile'
  | 'zoomToFit'
  | 'zoomToSelection'
  | 'autoLayout'
  | 'undo'
  | 'redo'
  | 'deleteNode'
  | 'toggleTool'
  | 'navigateUp'
  | 'navigateDown'
  | 'navigateLeft'
  | 'navigateRight'
  | 'panUp'
  | 'panDown'
  | 'panLeft'
  | 'panRight'

/** Actions the native menu can dispatch into the renderer. Superset of
 *  ShortcutAction — includes a few menu-only items that have no keyboard
 *  binding. */
export type MenuActionId = ShortcutAction | 'openFolder' | 'reloadWorkspace' | 'manageLayouts'

/** Browser-panel navigation actions. These are panel-scoped (handled by the
 *  focused BrowserPanel) rather than global shortcuts, so they don't collide
 *  with Monaco keys like Cmd+[ / Cmd+] / Cmd+L. */
export type BrowserShortcutAction = 'reload' | 'reloadHard' | 'back' | 'forward' | 'focusUrl'

/** A single global browsing-history entry, deduplicated by URL. Shared across
 *  all workspaces and browser panels so Cate behaves like one browser. */
export interface BrowserHistoryEntry {
  url: string
  title: string
  lastVisited: number // epoch ms
  visitCount: number
}

/** A global bookmark/favorite, deduplicated by URL. */
export interface BrowserBookmark {
  url: string
  title: string
  addedAt: number // epoch ms
}

/** One open tab in a browser panel (light model: a single <webview> re-navigates
 *  on switch, so a background tab is just its saved url/title). */
export interface BrowserTab {
  id: string
  url: string
  title: string
  /** Pinned ("fixed") tabs sort left, render compact, and resist accidental close. */
  pinned?: boolean
}

/** Sentinel URL for the browser start page ("new tab"). Persisted like any
 *  other panel URL so a start-page panel survives session restore; never
 *  recorded to history and never passed to the <webview> as src. */
export const BROWSER_NEW_TAB_URL = 'cate://newtab'

/** True when a URL should render the start page rather than a webview: the
 *  sentinel, the legacy `about:blank` default, or an empty/missing URL. Lets
 *  brand-new AND already-saved (about:blank) browser panels show the start
 *  screen instead of a blank page. */
export function isStartPageUrl(url: string | undefined | null): boolean {
  return !url || url === BROWSER_NEW_TAB_URL || url === 'about:blank'
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  'newTerminal',
  'newBrowser',
  'newEditor',
  'newAgent',
  'newCanvas',
  'newFile',
  'closePanel',
  'toggleSidebar',
  'toggleFileExplorer',
  'toggleSearch',
  'toggleMinimap',
  'commandPalette',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'focusNext',
  'focusPrevious',
  'saveFile',
  'zoomToFit',
  'zoomToSelection',
  'autoLayout',
  'undo',
  'redo',
  'deleteNode',
  'toggleTool',
  'navigateUp',
  'navigateDown',
  'navigateLeft',
  'navigateRight',
  'panUp',
  'panDown',
  'panLeft',
  'panRight',
]

export const SHORTCUT_DISPLAY_NAMES: Record<ShortcutAction, string> = {
  newTerminal: 'New Terminal',
  newBrowser: 'New Browser',
  newEditor: 'New Editor',
  newAgent: 'New Cate Agent',
  newCanvas: 'New Canvas',
  newFile: 'New File',
  closePanel: 'Close Panel',
  toggleSidebar: 'Toggle Sidebar',
  toggleFileExplorer: 'Toggle File Explorer',
  toggleSearch: 'Toggle Search',
  toggleMinimap: 'Toggle Minimap',
  commandPalette: 'Command Palette',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  zoomReset: 'Reset Zoom',
  focusNext: 'Focus Next Panel',
  focusPrevious: 'Focus Previous Panel',
  saveFile: 'Save File',
  zoomToFit: 'Zoom to Fit',
  zoomToSelection: 'Zoom to Selection',
  autoLayout: 'Auto Layout Canvas',
  undo: 'Undo',
  redo: 'Redo',
  deleteNode: 'Delete Focused Panel',
  toggleTool: 'Toggle Select / Hand Tool',
  navigateUp: 'Navigate to Panel Above',
  navigateDown: 'Navigate to Panel Below',
  navigateLeft: 'Navigate to Panel Left',
  navigateRight: 'Navigate to Panel Right',
  panUp: 'Pan Canvas Up',
  panDown: 'Pan Canvas Down',
  panLeft: 'Pan Canvas Left',
  panRight: 'Pan Canvas Right',
}

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, StoredShortcut> = {
  newTerminal: storedShortcut('t', { command: true }),
  newBrowser: storedShortcut('b', { command: true, shift: true }),
  newEditor: storedShortcut('e', { command: true, shift: true }),
  newAgent: storedShortcut('a', { command: true, shift: true }),
  newCanvas: storedShortcut('c', { command: true, shift: true }),
  newFile: storedShortcut('n', { command: true }),
  closePanel: storedShortcut('w', { command: true }),
  toggleSidebar: storedShortcut('b', { command: true }),
  toggleFileExplorer: storedShortcut('x', { command: true, shift: true }),
  toggleSearch: storedShortcut('f', { command: true, shift: true }),
  toggleMinimap: storedShortcut('m', { command: true, shift: true }),
  commandPalette: storedShortcut('k', { command: true }),
  zoomIn: storedShortcut('=', { command: true }),
  zoomOut: storedShortcut('-', { command: true }),
  zoomReset: storedShortcut('0', { command: true }),
  focusNext: storedShortcut('\t', { control: true }),
  focusPrevious: storedShortcut('\t', { shift: true, control: true }),
  saveFile: storedShortcut('s', { command: true }),
  zoomToFit: storedShortcut('1', { command: true }),
  zoomToSelection: storedShortcut('2', { command: true }),
  autoLayout: storedShortcut('l', { command: true, shift: true }),
  undo: storedShortcut('z', { command: true }),
  redo: storedShortcut('z', { command: true, shift: true }),
  deleteNode: storedShortcut('Backspace', { command: true }),
  // ⌃Space toggles the tool from anywhere — including a focused terminal,
  // editor, or input — by being intercepted before the surface sees it. (Plain
  // Space also toggles, but only when the canvas is focused.) Used to be
  // ⇧Space, but Shift is still held when the space after `:` `(` `?` `!` lands,
  // so normal typing kept triggering it and the space never reached the
  // terminal (issue #371).
  toggleTool: storedShortcut(' ', { control: true }),
  navigateUp: storedShortcut('↑', { command: true }),
  navigateDown: storedShortcut('↓', { command: true }),
  navigateLeft: storedShortcut('←', { command: true }),
  navigateRight: storedShortcut('→', { command: true }),
  panUp: storedShortcut('↑', { shift: true }),
  panDown: storedShortcut('↓', { shift: true }),
  panLeft: storedShortcut('←', { shift: true }),
  panRight: storedShortcut('→', { shift: true }),
}

// -----------------------------------------------------------------------------
// Activity / status types
// -----------------------------------------------------------------------------

export type NodeActivityState =
  | { type: 'normal' }
  | { type: 'commandFinished'; exitCode: number }
  | { type: 'agentWaitingForInput' }

export type AgentState = 'notRunning' | 'running' | 'waitingForInput' | 'finished'

export type TerminalActivity =
  | { type: 'idle' }
  | { type: 'running'; processName: string | null }

export interface GitInfo {
  branch: string
  isDirty: boolean
}

// -----------------------------------------------------------------------------
// File tree
// -----------------------------------------------------------------------------

export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  isExpanded: boolean
  children: FileTreeNode[]
  fileExtension: string
}

export interface FileSearchResult {
  name: string
  path: string
  /** Path relative to the search root, with forward slashes. */
  relativePath: string
  isDirectory: boolean
  /** Always true — the quick finder matches file names only. Kept for callers. */
  nameMatch: boolean
}

export interface FileSearchOptions {
  /** Hard cap on the number of results returned (default 200). */
  maxResults?: number
}

// -----------------------------------------------------------------------------
// Content search (ripgrep-backed, VS Code-style Search view)
// -----------------------------------------------------------------------------

export interface SearchOptions {
  /** The search query (literal text, or a regex when isRegex is set). */
  query: string
  /** Treat the query as a regular expression (ripgrep/Rust regex syntax). */
  isRegex?: boolean
  /** Case-sensitive match. When false, search is case-insensitive (VS Code default). */
  matchCase?: boolean
  /** Match whole words only. */
  wholeWord?: boolean
  /** Glob patterns to include (e.g. "src/**", "*.ts"). Empty = all files. */
  includes?: string[]
  /** Glob patterns to exclude (e.g. "*.lock", "dist/**"). */
  excludes?: string[]
  /** When true (default), respect .gitignore/.ignore and the project exclusion
   *  set. When false, also search ignored and hidden files (ripgrep
   *  --no-ignore --hidden), like VS Code's "Use Exclude Settings and Ignore
   *  Files" toggle turned off. */
  respectIgnore?: boolean
  /** Hard cap on total matches before the search is truncated (default 5000). */
  maxResults?: number
}

/** Character offset range of a single match within a line's text. */
export interface SearchMatchRange {
  /** 0-based character index where the match starts. */
  start: number
  /** 0-based character index where the match ends (exclusive). */
  end: number
}

/** One rendered line of a search result — either a match line or context line. */
export interface SearchResultLine {
  /** 1-based line number in the file. */
  line: number
  /** The line text (trailing newline stripped, long lines truncated). */
  text: string
  /** Highlight ranges within `text`. Empty array means this is a context line. */
  ranges: SearchMatchRange[]
}

/** All matches (and surrounding context) for a single file. */
export interface SearchFileResult {
  /** Absolute file path. */
  path: string
  /** Path relative to the search root, with forward slashes. */
  relativePath: string
  /** Match + context lines in ascending line order. */
  lines: SearchResultLine[]
  /** Number of individual matches (submatches) in this file. */
  matchCount: number
}

/** A streamed batch of completed file results for an in-flight search. */
export interface SearchResultBatch {
  searchId: string
  files: SearchFileResult[]
}

/** Final stats for a content search. */
export interface SearchStats {
  /** Total matches found (capped at maxResults). */
  matches: number
  /** Number of files with at least one match. */
  files: number
  /** True if the search stopped early at the result cap. */
  truncated: boolean
}

/** Terminal event for a search — carries final stats and any engine error. */
export interface SearchDoneEvent {
  searchId: string
  stats: SearchStats
  /** Set when the search failed (e.g. invalid regex); results are then empty. */
  error?: string
}

// -----------------------------------------------------------------------------
// Session persistence
// -----------------------------------------------------------------------------

/** In-memory workspace snapshot — the single bridge between the live stores and
 *  the on-disk project files. Every canvas (primary and secondary alike) is just
 *  an entry in `canvases`; every placed panel is a record in `panels`. There is
 *  no special "primary nodes" list — the primary canvas is whichever canvas panel
 *  the dock layout puts in the center zone. */
export interface SessionSnapshot {
  workspaceId?: string
  workspaceName: string
  rootPath: string | null
  /** Dock zone layout state. Missing = empty dock. */
  dockState?: DockStateSnapshot
  /** Every placed panel's record, keyed by panel id — dock-zone panels AND every
   *  canvas's child panels (including each canvas panel itself). Geometry lives
   *  in `canvases`; this carries type/title/filePath/url/etc. */
  panels?: Record<string, PanelState>
  /** Every canvas's geometry (nodes + viewport + zoom), keyed by canvas panel id,
   *  including the primary/center canvas. */
  canvases?: Record<string, CanvasSnapshot>
  /** Machine-local terminal respawn directories, keyed by panel id. Carries the
   *  live working directory so a restored terminal respawns where it was rather
   *  than at the workspace root. Sourced from / saved to session.json. */
  terminalCwds?: Record<string, string>
  /** Git worktree registry (with per-worktree color/label). Persisted so colors
   *  stay stable across restarts instead of being re-assigned round-robin from
   *  the palette, and so panel.worktreeId references still resolve. */
  worktrees?: WorktreeMeta[]
  /** Resolved runtime connection for a remote/WSL workspace (absent ⇒ local).
   *  Persisted so the runtime can be reconnected on restore before any
   *  fs/git/terminal op runs. Mirrors WorkspaceState.connection. */
  connection?: RuntimeConnection
}

/** One persisted remote workspace (stored in `remote-workspaces.json`). Remote
 *  workspaces can't use the local `.cate/` project-state files (their tree lives
 *  on a runtime), so their full restore snapshot + reconnect info is kept here,
 *  keyed by the `cate-runtime://` locator. Local workspaces never appear here —
 *  they round-trip through recentProjects + `.cate/` as before. */
export interface RemoteProjectEntry {
  /** The `cate-runtime://` locator string (this workspace's rootPath). */
  locator: string
  /** Reconnect info, used by ensureWorkspaceRuntime on restore. */
  connection: RuntimeConnection
  /** Full session snapshot to rebuild the canvas/panels on restore. */
  snapshot: SessionSnapshot
}

/** Persisted sidebar arrangement (stored in `sidebar.json`). Keyed by
 *  workspace root paths — workspace IDs are runtime UUIDs and can't be persisted.
 *  Separate from `recentProjects` (which stays recency-ordered for the Welcome
 *  page) so manual order and the active workspace survive a restart. */
export interface SidebarSession {
  /** Workspace root paths in sidebar order. */
  order: string[]
  /** Root path of the active workspace, or '' when none applies. */
  selected: string
}

/** Serialized dock zone state for session persistence. */
export interface DockStateSnapshot {
  zones: WindowDockState
  locations: Record<string, PanelLocation>
}

/** Dock-window sync payload sent renderer -> main for session persistence.
 *  Deliberately carries NO workspaceId: the workspace a dock window belongs to
 *  is owned by main alone (set at window creation in the registry). A renderer
 *  echo could only ever be the process-local stub id, and overwriting the real
 *  id would silently drop the window from session.json. */
export interface DockWindowSyncState {
  dockState: DockStateSnapshot
  panels: Record<string, PanelState>
  terminalCwds?: Record<string, string>
  canvasStates?: Record<string, CanvasLayoutSnapshot>
}

// Legacy: detached single-panel windows (removed). Retained only to migrate old session files into dock windows.
export interface PanelWindowSnapshot {
  panel: PanelState
  bounds: { x: number; y: number; width: number; height: number }
  workspaceId?: string
  /** ptyId of the terminal in this window (terminal panels only). */
  terminalPtyId?: string
}

export interface MultiWorkspaceSession {
  version: 2
  selectedWorkspaceIndex: number | null
  workspaces: SessionSnapshot[]
  /** Detached dock windows with full dock layout. Missing = no dock windows (migration). */
  dockWindows?: DetachedDockWindowSnapshot[]
}

// -----------------------------------------------------------------------------
// Project-local workspace file (.cate/workspace.json) — VCS-friendly, shareable
// -----------------------------------------------------------------------------

export interface ProjectWorkspaceFile {
  version: 1
  name: string
  color: string
  dockState?: DockStateSnapshot
  /** Every placed panel's shareable metadata, keyed by panel id — dock-zone
   *  panels AND every canvas's child panels (each canvas panel itself included).
   *  Geometry lives in `canvases`; machine-local facts (worktree tag, working
   *  directory, unsaved scratch content) live in session.json. */
  panels?: Record<string, ProjectPanelRef>
  /** Every canvas's node geometry + viewport, keyed by canvas panel id, including
   *  the primary/center canvas. The primary canvas is identified at restore time
   *  from the dock layout (center zone), not a dedicated field. */
  canvases?: Record<string, CanvasSnapshot>
}

export interface ProjectPanelRef {
  type: string
  title: string
  filePath?: string
  url?: string
  /** Browser panels only: per-panel proxy URL (see PanelState.proxyUrl). */
  proxyUrl?: string
  /** Document panels only: sub-type discriminator for the viewer. */
  documentType?: 'pdf' | 'docx' | 'image'
}

// -----------------------------------------------------------------------------
// Project-local session file (.cate/session.json) — ephemeral, gitignored
// -----------------------------------------------------------------------------

export interface ProjectSessionFile {
  version: 1
  /** Stable machine-local workspace id, reused across restores so the
   *  main-process workspace list isn't duplicated on renderer reload. */
  workspaceId?: string
  /** Machine-local per-panel facts, keyed by panel id — for every panel in
   *  workspace.json `panels` (canvas children + dock). Carries the worktree tag,
   *  terminal working directory, and unsaved scratch content kept out of the
   *  committed file. */
  panels: Record<string, ProjectSessionPanel>
  /** Detached dock windows (machine-local, not committed). */
  dockWindows?: DetachedDockWindowSnapshot[]
  /** Git worktree registry (id/path/branch/color/label). Machine-local because
   *  the checkouts under `.cate/worktrees` are gitignored and personal — kept
   *  here (not in committed workspace.json) so colors/labels survive a restart.
   *  Paths are absolute, matching `ProjectSessionPanel.workingDirectory`. */
  worktrees?: WorktreeMeta[]
  /** Resolved runtime connection for THIS workspace on THIS machine. Machine-
   *  local on purpose — a server/wsl choice is the opener's, not the repo's, so
   *  it lives here and never in the VCS-committed workspace.json. Absent ⇒ local. */
  connection?: RuntimeConnection
}

export interface ProjectSessionPanel {
  panelId: string
  ptyId?: string
  workingDirectory?: string
  unsavedContent?: string
  /** Worktree this terminal/agent panel is tagged with. Machine-local (worktree
   *  ids are runtime uuids), so it lives in session.json, not workspace.json. */
  worktreeId?: string
}

// -----------------------------------------------------------------------------
// Layout snapshot (saved canvas arrangements)
// -----------------------------------------------------------------------------

export interface LayoutSnapshot {
  nodes: Array<{
    panelType: PanelType
    origin: Point
    size: Size
  }>
}

// -----------------------------------------------------------------------------
// Notification types
// -----------------------------------------------------------------------------

export type TerminalLinkOpenTarget = 'ask' | 'canvas' | 'external'

export type CanvasGridStyle = 'dots' | 'lines' | 'none'

export type NotificationAction =
  | { type: 'focusTerminal'; workspaceId: string; terminalId: string }

// -----------------------------------------------------------------------------
// App settings — mirrors AppSettings.swift with all defaults
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Terminal theme data — both built-in presets and user-imported palettes use
// this shape. `theme` mirrors xterm.js's ITheme.
// -----------------------------------------------------------------------------


// -----------------------------------------------------------------------------
// File exclusions — folder/file names hidden in the file explorer by default.
// Serves as the default for the user-editable AppSettings.fileExclusions list.
// -----------------------------------------------------------------------------

export const FILE_EXCLUSIONS: string[] = [
  '.git',
  '.DS_Store',
  '.Trash',
  'node_modules',
  '__pycache__',
  '.npm',
  '.cache',
  '.build',
  '.swiftpm',
  'DerivedData',
  'Pods',
]

/** A sidebar view (left/right rail tabs). */
export type SidebarView = 'workspaces' | 'explorer' | 'git' | 'search'

/** Which sidebar views live in the left vs. right rail. Persisted in settings. */
export interface SidebarLayout {
  left: SidebarView[]
  right: SidebarView[]
}

/** Version of the telemetry/privacy notice. Bump when the privacy policy
 *  materially changes so every user sees the informational notice once more.
 *  v1 = the old opt-in consent dialog era; v2 = always-on telemetry notice. */
export const TELEMETRY_NOTICE_VERSION = 2

export interface AppSettings {
  // General
  defaultShellPath: string
  warnBeforeQuit: boolean
  /** When discarding a worktree, also close its terminal and agent panels. */
  closeWorktreePanelsOnDelete: boolean
  /** Workspace-root-relative paths to symlink into every new worktree (e.g.
   *  node_modules) so they don't need rebuilding per worktree. Empty = off. */
  worktreeSymlinkPaths: string[]

  // Appearance
  /** Active unified theme: 'system' (auto light/dark) or a theme id. */
  activeThemeId: ThemeSelection
  /** Theme ids used by 'system' mode for OS light / dark. */
  systemLightThemeId: string
  systemDarkThemeId: string
  /** User-imported / agent-authored unified themes. */
  customThemes: Theme[]
  editorFontSize: number
  /** CSS font-family for Monaco editor panels. Empty string = built-in default
   *  stack (Menlo, Monaco, "Courier New", monospace). */
  editorFontFamily: string
  /** Global UI zoom for Cate's own chrome (panels, sidebars, editor, terminal),
   *  applied via webFrame.setZoomFactor in every window. 1.0 = 100%. Does not
   *  affect web pages shown in browser panels (those keep their own zoom).
   *  Range 0.5–2.0. */
  uiScale: number
  /** Disable Chromium's GPU rasterization (text glyphs included) while leaving
   *  WebGL and GPU compositing on. A workaround for intermittent glyph dropout —
   *  text repainting with random missing characters — caused by GPU glyph-atlas
   *  corruption under this app's GPU load (many xterm WebGL contexts + the
   *  worktree-territory renderer + canvas compositing churn). Off by default
   *  (full GPU). Applied as a command-line switch at launch, so a change only
   *  takes effect after restarting the app. */
  disableGpuRasterization: boolean

  // Canvas
  showMinimap: boolean
  zoomSpeed: number
  /** When enabled, the node that occupies the most visible canvas area is
   *  automatically focused as the user pans/zooms. */
  autoFocusLargestVisibleNode: boolean
  /** Background pattern drawn on the canvas. */
  canvasGridStyle: CanvasGridStyle
  /** Absolute path to an image shown as the canvas wallpaper, behind the grid
   *  and panels. Empty string = no wallpaper. The layer is automatically dimmed
   *  on dark themes and lightened on light themes so panel titles stay
   *  readable over it. */
  canvasBackgroundImagePath: string
  /** Opacity (0–1) of the canvas wallpaper layer. Lower values keep panel
   *  titles more readable; ignored when no image is set. */
  canvasBackgroundImageOpacity: number
  /** Snap panels to the canvas grid while dragging and resizing, so windows
   *  align to a uniform lattice. Hold Alt during a same-window drag/resize to
   *  bypass it (the Alt bypass can't apply to drags between windows, since the
   *  modifier state isn't carried across the cross-window IPC). */
  snapToGrid: boolean
  /** When creating a new panel without an explicit position (Cmd+T, toolbar
   *  click), show the recommendation picker — zoom out and let the user choose
   *  among numbered spots / click anywhere. When off, the best spot is chosen
   *  automatically and the panel is placed immediately. */
  placementPicker: boolean
  /** Paint the soft per-worktree "territory" backgrounds behind panels when a
   *  workspace has multiple git worktrees. Off hides the visualization. */
  showWorktreeTerritory: boolean

  // Terminal
  terminalFontFamily: string
  terminalFontSize: number
  /** xterm.js scrollback buffer size, in lines. Lower = less memory per terminal. */
  terminalScrollback: number
  /** Vertical wheel-scroll speed multiplier for terminals (xterm scrollSensitivity).
   *  1.0 = xterm default; lower = slower. Range 0.25–3.0. */
  terminalScrollSpeed: number
  /** Minimum contrast ratio enforced between terminal text and its background
   *  (xterm `minimumContrastRatio`). xterm lightens/darkens low-contrast or dim
   *  text until it meets this WCAG ratio, so dim output stays readable on dark
   *  themes. 1 = off (use the theme colors exactly); 4.5 = WCAG AA — the default,
   *  matching VS Code's `terminal.integrated.minimumContrastRatio`. Range 1–21. */
  terminalContrast: number
  /** Blink the terminal cursor. Off by default: each blink forces a GPU draw +
   *  compositor update, so a focused terminal keeps the compositor awake even
   *  when otherwise idle. A steady cursor is still fully visible. */
  terminalCursorBlink: boolean
  /** Treat the macOS ⌥ Option key as Meta in the terminal (xterm macOptionIsMeta).
   *  On (default): ⌥+key sends a Meta/ESC sequence (e.g. ⌥F/⌥B word motion in
   *  readline). Off: ⌥ produces the macOS layout's special characters — e.g.
   *  ⌥⇧- types an em dash (—) — and Meta is sent via the Esc-prefix instead. */
  terminalOptionIsMeta: boolean
  /** Auto-suspend (SIGSTOP) idle background terminals to reduce memory use.
   *  A terminal is suspended after it has been offscreen AND produced no PTY
   *  output for 2 minutes. SIGCONT is sent on focus/interaction. POSIX-only;
   *  no effect on Windows. */
  autoSuspendIdleTerminals: boolean

  // Browser
  browserHomepage: string
  browserSearchEngine: BrowserSearchEngine
  /** Show the horizontal bookmarks bar (favorite chips) under the URL bar. */
  browserShowBookmarksBar: boolean
  /** Show the vertical tab sidebar (Arc/Edge-style) on the left of the panel. */
  browserShowTabSidebar: boolean
  /** What a freshly-opened browser panel / new tab loads. */
  browserNewTabBehavior: BrowserNewTabBehavior
  /** Where a Cmd/Ctrl+clicked terminal link opens.
   *  - 'ask': prompt once, with an option to remember the choice.
   *  - 'canvas': reuse/create an in-app browser panel.
   *  - 'external': open in the system default browser.
   *  (Cmd/Ctrl+Shift+click always forces 'external' regardless of this.) */
  terminalLinkOpenTarget: TerminalLinkOpenTarget

  // Sidebar
  sidebarTintOpacity: number
  showFileExplorerOnLaunch: boolean

  // File Explorer
  /** Folder/file names hidden in the file explorer, file search, and watcher. */
  fileExclusions: string[]

  // Notifications (OS-level only)
  notificationsEnabled: boolean
  notifyOnlyWhenUnfocused: boolean

  // Privacy
  /** DEPRECATED — no longer read anywhere. Telemetry is always on in packaged
   *  builds since notice v2. Kept in the schema so existing settings.json files
   *  load cleanly; remove in a later release. */
  crashReportingEnabled: boolean
  /** DEPRECATED — see crashReportingEnabled. */
  usageAnalyticsEnabled: boolean
  /** DEPRECATED — see crashReportingEnabled. */
  telemetryConsentDecided: boolean
  /** Highest TELEMETRY_NOTICE_VERSION the user has dismissed the telemetry
   *  notice (WelcomeDialog) for. The notice shows whenever this is below the
   *  current TELEMETRY_NOTICE_VERSION — on first install, and again for every
   *  existing user when the constant is bumped. Informational only — telemetry
   *  does not depend on it. */
  telemetryNoticeAcknowledgedVersion: number

  // Onboarding
  /** Whether the user has finished (or skipped) the first-run guided tour.
   *  Set false to replay it. */
  onboardingCompleted: boolean

  // Updates
  /** Opt in to beta (pre-release / staged) builds. When on, the in-app
   *  auto-updater also considers GitHub pre-releases (e.g. v1.2.0-beta.1) — see
   *  src/main/auto-updater.ts (autoUpdater.allowPrerelease). Off by default, so
   *  stable users and the public website download are never offered betas. */
  betaUpdatesEnabled: boolean

  // Shortcuts
  /** User keyboard-shortcut overrides, keyed by action. Only bindings that
   *  differ from DEFAULT_SHORTCUTS are stored; an entry with an empty key
   *  means the shortcut is disabled. */
  customShortcuts: Partial<Record<ShortcutAction, StoredShortcut>>

  // Agent
  /** The user-pinned default model applied to every new agent chat, or null for
   *  none. Was renderer localStorage (cate.agent.defaultModel.v1) before. */
  agentDefaultModel: AgentModelRef | null

  // Layout
  /** Which sidebar views live in the left vs. right rail. Was renderer
   *  localStorage (cate.sidebarLayout.v3) before. */
  sidebarLayout: SidebarLayout
}

export const DEFAULT_SETTINGS: AppSettings = {
  // General
  // Empty string = auto-detect from $SHELL / platform fallback chain at spawn
  // time (see src/main/shellResolver.ts). Avoids hardcoding /bin/zsh on Linux,
  // where it commonly isn't installed.
  defaultShellPath: '',
  warnBeforeQuit: false,
  closeWorktreePanelsOnDelete: true,
  worktreeSymlinkPaths: [],

  // Appearance
  activeThemeId: 'system',
  systemLightThemeId: 'light-subtle',
  systemDarkThemeId: 'dark-cold',
  customThemes: [],
  editorFontSize: 12,
  editorFontFamily: '',
  uiScale: 1.0,
  disableGpuRasterization: false,

  // Canvas
  showMinimap: true,
  zoomSpeed: 1.0,
  autoFocusLargestVisibleNode: false,
  canvasGridStyle: 'lines',
  canvasBackgroundImagePath: '',
  canvasBackgroundImageOpacity: 0.4,
  snapToGrid: false,
  placementPicker: true,
  showWorktreeTerritory: true,

  // Terminal
  terminalFontFamily: '',
  terminalFontSize: 0,
  terminalScrollback: 2000,
  terminalScrollSpeed: 1.0,
  terminalContrast: 4.5,
  terminalCursorBlink: false,
  terminalOptionIsMeta: true,
  autoSuspendIdleTerminals: true,

  // Browser
  browserHomepage: '',
  browserSearchEngine: 'google',
  browserShowBookmarksBar: true,
  browserShowTabSidebar: true,
  browserNewTabBehavior: 'startPage',
  terminalLinkOpenTarget: 'ask',

  // Sidebar
  sidebarTintOpacity: 1.0,
  showFileExplorerOnLaunch: false,

  // File Explorer
  fileExclusions: [...FILE_EXCLUSIONS],

  // Notifications (OS-level only)
  notificationsEnabled: true,
  notifyOnlyWhenUnfocused: true,

  // Privacy. The three legacy consent flags are deprecated (no longer read);
  // telemetry is always on in packaged builds. The acknowledged notice version
  // starts at 0 so every fresh install and every updater sees the notice once.
  crashReportingEnabled: true,
  usageAnalyticsEnabled: true,
  telemetryConsentDecided: false,
  telemetryNoticeAcknowledgedVersion: 0,

  // Onboarding
  onboardingCompleted: false,

  // Updates
  betaUpdatesEnabled: false,

  // Shortcuts
  customShortcuts: {},

  // Agent
  agentDefaultModel: null,

  // Layout — keep in sync with the sidebar's default arrangement.
  sidebarLayout: {
    left: ['workspaces', 'explorer', 'search'],
    right: ['git'],
  },
}

// -----------------------------------------------------------------------------
// UI state — transient, cosmetic per-machine UI placement (minimap position /
// size). Persisted to `<userData>/ui-state.json` rather than settings.json so
// the user-facing settings file stays focused on preferences. Was renderer
// localStorage before.
// -----------------------------------------------------------------------------

export type CanvasCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'

export interface UIState {
  /** Corner the floating minimap is docked in. */
  minimapCorner: CanvasCorner
  /** Floating minimap size in px. */
  minimapSize: { w: number; h: number }
  /** Corner the minimap toggle button (canvas toolbar) is docked in. */
  minimapButtonCorner: CanvasCorner
}

export const DEFAULT_UI_STATE: UIState = {
  minimapCorner: 'bottom-right',
  minimapSize: { w: 200, h: 150 },
  minimapButtonCorner: 'bottom-right',
}

// -----------------------------------------------------------------------------
// Panel size constants — derived from the panel registry so the sizes for a
// new panel type are declared in one place. Kept as named exports so existing
// call sites can keep importing them.
// -----------------------------------------------------------------------------

import { PANEL_DEFINITIONS } from './panels'

export const PANEL_DEFAULT_SIZES: Record<PanelType, Size> = Object.fromEntries(
  (Object.keys(PANEL_DEFINITIONS) as PanelType[]).map((t) => [t, PANEL_DEFINITIONS[t].defaultSize]),
) as Record<PanelType, Size>

export const PANEL_MINIMUM_SIZES: Record<PanelType, Size> = Object.fromEntries(
  (Object.keys(PANEL_DEFINITIONS) as PanelType[]).map((t) => [t, PANEL_DEFINITIONS[t].minimumSize]),
) as Record<PanelType, Size>

// Compact sizes used when a panel is dropped onto the canvas from a non-
// canvas-node source (e.g. a tab dragged out of a side/main dock window).
// PANEL_DEFAULT_SIZES sizes fresh windows in their own shells and is too
// large for an in-canvas drop.
export const PANEL_CANVAS_DROP_SIZES: Record<PanelType, Size> = {
  terminal: { width: 520, height: 340 },
  browser: { width: 640, height: 440 },
  editor: { width: 540, height: 420 },
  canvas: { width: 640, height: 480 },
  agent: { width: 520, height: 440 },
  document: { width: 640, height: 480 },
}

// -----------------------------------------------------------------------------
// Zoom constants — from CanvasState.swift
// -----------------------------------------------------------------------------

export const ZOOM_MIN = 0.3
export const ZOOM_MAX = 3.0
export const ZOOM_DEFAULT = 1.0

// =============================================================================
// Pi agent + auth shared types
// =============================================================================

/** Provider category — drives which form the auth UI shows. */
export type AuthProviderKind = 'oauth' | 'apiKey'

export interface AuthProviderDescriptor {
  /** Stable pi-ai provider id (e.g. 'anthropic', 'openai', 'google'). */
  id: string
  /** Display name. */
  name: string
  kind: AuthProviderKind
  /** Environment variable that pi-ai reads for this provider, if any. */
  envVar?: string
  /** Hint shown under the input (e.g. where to get a key). */
  helpUrl?: string
  /** For OAuth providers: whether a local callback server is needed. */
  usesCallbackServer?: boolean
}

export interface AuthProviderStatus {
  id: string
  connected: boolean
  /** Last connect time as ISO string, if known. */
  connectedAt?: string
  /** Where the credential lives. */
  source?: 'oauth' | 'safeStorage' | 'env' | 'config'
}

/** A user-defined OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, a
 *  proxy, ...). Surfaced as one extra provider in the agent provider list and
 *  written to pi's models.json. */
export interface CustomOpenAIProvider {
  baseUrl: string
  /** Empty for local servers that ignore auth; pi gets a placeholder. */
  apiKey: string
  /** Model ids exposed by the endpoint, e.g. ['llama3.1:8b']. */
  models: string[]
}

export interface AgentModelRef {
  provider: string
  model: string
}

/** A selectable model, derived session-independently from the connected
 *  providers in auth.json (plus the custom OpenAI endpoint in models.json). */
export interface AgentModelDescriptor {
  provider: string
  /** Model id passed to pi (e.g. `claude-sonnet-4-6`). */
  id: string
  /** Human label for the picker (pi's model name, falling back to the id). */
  label: string
  contextWindow: number
  reasoning: boolean
}

/** Slash command exposed by pi — a skill, prompt template, or extension cmd. */
export interface AgentSlashCommand {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
  /** Absolute path to the file that defines this command (if any). */
  path?: string
  /** Where it lives — user-installed vs. shipped with a package. */
  scope?: 'user' | 'project' | 'temporary'
  /** Whether the file is editable/deletable by the user (true for files under
   *  ~/.pi/agent, false for things shipped inside packages). */
  editable?: boolean
}

export interface AgentCreateOptions {
  panelId: string
  workspaceId: string
  cwd: string
  model?: AgentModelRef
  systemPrompt?: string
  /** Resume an existing pi session file (jsonl). When set, pi will load it
   *  on start instead of creating a fresh session. */
  sessionFile?: string
}

/** Pi agent events forwarded from main to renderer. We keep the shape loose
 *  since pi's event union is large and may evolve — renderer narrows by `type`. */
export interface AgentEventEnvelope {
  panelId: string
  event: {
    type: string
    [key: string]: unknown
  }
}

/** Pi's reasoning levels (mirrors `ThinkingLevel` from pi-agent-core). */
export type AgentThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** Image attachment sent alongside a prompt/steer/followUp. Data is raw base64
 *  (no `data:` prefix) so pi can forward it verbatim as `ImageContent`. */
export interface AgentImageAttachment {
  data: string
  mimeType: string
  /** Optional filename, kept around so the renderer can display a chip. */
  fileName?: string
}

/** Snapshot of pi's session stats — fed from `get_session_stats`. */
export interface AgentSessionStats {
  sessionFile?: string
  sessionId?: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
}

/** Pi RPC session state snapshot. */
export interface AgentRpcState {
  model: { id: string; provider: string; name?: string; contextWindow?: number; reasoning?: boolean } | null
  thinkingLevel: AgentThinkingLevel
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: 'all' | 'one-at-a-time'
  followUpMode: 'all' | 'one-at-a-time'
  sessionFile?: string
  sessionId?: string
  sessionName?: string
  autoCompactionEnabled: boolean
  messageCount: number
  pendingMessageCount: number
}

/** Pi extension UI request — forwarded verbatim through agent:event so the
 *  renderer can render an in-panel dialog. Dialog methods expect a reply via
 *  AGENT_UI_RESPONSE; fire-and-forget methods don't. */
export interface AgentExtensionUIRequest {
  id: string
  method: 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'set_editor_text'
  [key: string]: unknown
}

export interface AgentExtensionUIResponse {
  id: string
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}

/** A pi session file on disk, parsed enough to populate the chat sidebar. */
export interface AgentSessionListEntry {
  /** Absolute path to the .jsonl file. */
  path: string
  /** Pi session id (UUID from header). */
  id: string
  /** Display title — explicit session_info.sessionName when set, otherwise
   *  derived from the first user message. */
  title: string
  /** True iff title came from `set_session_name`. */
  named: boolean
  /** Cwd recorded in the header (so we can filter by workspace). */
  cwd: string
  /** Header timestamp (ISO). */
  createdAt: string
  /** File mtime (ISO). */
  updatedAt: string
  /** Best-effort count of pi `message` entries. */
  messageCount: number
  /** Last `model_change` entry recorded in the session, if any. Used to
   *  restore the chat's prior model selection on resume. */
  lastModel?: { provider: string; model: string }
}

/** OAuth UI events forwarded to renderer during a login flow. */
export type OAuthFlowEvent =
  | { type: 'auth'; url: string; instructions?: string }
  | { type: 'deviceCode'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string }
  | { type: 'prompt'; promptId: string; message: string; placeholder?: string; allowEmpty?: boolean }
  | { type: 'select'; promptId: string; message: string; options: Array<{ id: string; label: string }> }
  | { type: 'manualCode'; promptId: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

// -----------------------------------------------------------------------------
// Performance profiler (CATE_PERF=1) — shared between main sampler and the
// renderer HUD.
// -----------------------------------------------------------------------------

export interface PerfProcSample {
  type: string
  pid: number
  /** percentCPUUsage since last sample (relative to one core; may exceed 100). */
  cpu: number
  /** working-set memory in MB. */
  memMB: number
}

export interface PerfSnapshot {
  /** Sampling window in ms; all rates below are per-second. */
  windowMs: number
  focused: boolean
  totalCpu: number
  procs: PerfProcSample[]
  spawnsPerSec: Record<string, number>
  ipc: Array<{ channel: string; kbPerSec: number; callsPerSec: number }>
  terminal: { kbPerSec: number; chunksPerSec: number }
}
