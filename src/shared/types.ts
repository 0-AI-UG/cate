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
  regionId?: string
}

/** Computed helper — mirrors the Swift `isMaximized` computed property. */
export function isMaximized(node: CanvasNodeState): boolean {
  return node.preMaximizeOrigin != null
}

// -----------------------------------------------------------------------------
// Canvas region (group container)
// -----------------------------------------------------------------------------

export interface CanvasRegion {
  id: string
  origin: Point
  size: Size
  label: string
  color: string
  zOrder: number
  /** Default working directory for terminals spawned inside this region.
   *  Falls back to the workspace's primary `rootPath` when unset. */
  defaultCwd?: string
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
}

// -----------------------------------------------------------------------------
// Worktree metadata — per-workspace registry of git worktrees that Cate is
// actively managing. The workspace's own rootPath is materialized as the
// `isPrimary: true` entry on load so the UI can treat them uniformly.
// -----------------------------------------------------------------------------

export interface WorktreeMeta {
  /** Stable client id (uuid). */
  id: string
  /** Absolute filesystem path to the worktree checkout. */
  path: string
  /** Branch name checked out in the worktree. */
  branch: string
  /** Hex color used for the title-bar pill + panel accent border. */
  color: string
  /** Optional friendly label shown in the sidebar in place of the branch. */
  label?: string
  /** True for the workspace's original rootPath. */
  isPrimary: boolean
}

// -----------------------------------------------------------------------------
// Workspace metadata — shared across windows, managed by main process
// -----------------------------------------------------------------------------

/**
 * Where a workspace's files physically live, and how the companion that hosts
 * its terminal/fs/git operations is reached. Absent ⇒ `{ kind: 'local' }` (the
 * migration default for every workspace that predates remote support). Secrets
 * (SSH passphrases/keys) NEVER live here — they are stored encrypted via
 * Electron safeStorage, keyed by companionId.
 */
export type CompanionConnection =
  | { kind: 'local' }
  | {
      kind: 'server'
      /** Routing key; matches the authority in this workspace's rootPath URI. */
      companionId: string
      host: string
      user: string
      port?: number
      /** Companion-absolute root on the server. */
      remotePath: string
    }
  | {
      kind: 'wsl'
      companionId: string
      distro: string
      /** Companion-absolute root inside the distro. */
      distroPath: string
    }

export interface WorkspaceInfo {
  id: string
  name: string
  color: string
  /** Locator string: a bare absolute path for local, a `cate-companion://`
   *  URI otherwise. See src/main/companion/locator.ts. */
  rootPath: string
  /** Defaults to { kind: 'local' } when absent (migration rule). */
  connection?: CompanionConnection
}

/** What the connect UI sends to main to establish a remote companion. SSH auth
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

export type CompanionConnectResult =
  | { ok: true; companionId: string; rootPath: string; connection: CompanionConnection }
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
 * Canonical lifecycle phase of a remote companion. Emitted by the main process
 * (CompanionManager) and projected onto the owning workspace, where it is the
 * single source of truth the UI derives its runtime status from. Local
 * workspaces have no phase (absent ⇒ no companion).
 *
 *  - `installing`   — bootstrapping the daemon bundle onto the host (pull/push + extract)
 *  - `connecting`   — launching the daemon + protocol/version handshake
 *  - `connected`    — daemon is live; the workspace is fully functional
 *  - `disconnected` — was connected, the channel dropped (daemon crash / network)
 *  - `unreachable`  — connect/launch/handshake failed (bad host/auth/network); retry or edit
 *  - `missing`      — the daemon bundle isn't installed / install failed; needs (re)install
 */
export type CompanionPhase =
  | 'installing'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'unreachable'
  | 'missing'

/** Live connection state pushed to the renderer (COMPANION_STATUS). */
export interface CompanionStatusEvent {
  companionId: string
  phase: CompanionPhase
  message?: string
}

/** The canonical companion runtime state stored on a remote workspace. Written
 *  by exactly one path in the renderer (the COMPANION_STATUS subscription, plus
 *  the optimistic seed during the initial connect before companionId is bound).
 *  Absent ⇒ local workspace, or a remote workspace whose companion hasn't been
 *  contacted yet this session. */
export interface CompanionRuntime {
  phase: CompanionPhase
  /** Human-readable failure reason for unreachable/missing/disconnected. */
  error?: string
}

export interface WorkspaceMutationError {
  code: 'INVALID_ROOT_PATH' | 'INVALID_WORKSPACE_ID' | 'WORKSPACE_NOT_FOUND'
  message: string
}

export type WorkspaceMutationResult =
  | { ok: true; workspace: WorkspaceInfo }
  | { ok: false; error: WorkspaceMutationError }

// -----------------------------------------------------------------------------
// Window type system — main window vs borderless panel windows (Phase 4)
// -----------------------------------------------------------------------------

export type CateWindowType = 'main' | 'panel' | 'dock'

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
}

/** Snapshot of a detached dock window for session persistence */
export interface DetachedDockWindowSnapshot {
  dockState: DockStateSnapshot
  panels: Record<string, PanelState>
  bounds: { x: number; y: number; width: number; height: number }
  workspaceId: string
  /** Map of terminal panelId → ptyId, so the scrollback log can be replayed on restore. */
  terminalPtyIds?: Record<string, string>
}

// -----------------------------------------------------------------------------
// Panel transfer protocol — cross-window panel migration (Phase 4)
// -----------------------------------------------------------------------------

export interface PanelTransferSnapshot {
  panel: PanelState
  geometry: { origin: Point; size: Size }
  sourceLocation: PanelLocation

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

  // Canvas-specific — child nodes/regions/viewport for nested canvas panels.
  // Without this, detaching a canvas panel to a new window would land with an
  // empty store (fresh per-process), losing every panel inside it.
  //
  // `childPanels` carries the PanelState records for every panel referenced
  // by the canvas's nodes. Without these the receiving window can't resolve
  // child panel types/titles and falls back to a generic "Panel" stub.
  canvasState?: {
    nodes: Record<CanvasNodeId, CanvasNodeState>
    regions: Record<string, CanvasRegion>
    viewportOffset: Point
    zoomLevel: number
    childPanels: Record<string, PanelState>
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
  regions: Record<string, CanvasRegion>
  zoomLevel: number
  viewportOffset: Point
  focusedNodeId: CanvasNodeId | null
}

// -----------------------------------------------------------------------------
// Workspace state — full state including per-window canvas/panel data
// -----------------------------------------------------------------------------

export interface WorkspaceState {
  id: string
  name: string
  color: string
  rootPath: string
  /** Companion connection for a remote/WSL workspace (absent ⇒ local). Mirrors
   *  WorkspaceInfo.connection; drives reconnect-on-restore. */
  connection?: CompanionConnection
  /** Canonical companion runtime state for a remote workspace (set from
   *  COMPANION_STATUS, seeded during initial connect). The single source of
   *  truth the UI derives editability + the lock overlay from. Absent ⇒ local,
   *  or remote-not-yet-contacted. See lib/workspaceRuntime.ts. */
  companion?: CompanionRuntime
  /** Additional project roots opened alongside the primary `rootPath`.
   *  Used to keep multiple repos in one canvas. Order is user-controlled. */
  additionalRoots?: string[]
  /** Worktrees managed for this workspace. Includes the primary rootPath as
   *  an `isPrimary: true` entry once it has been materialized on first load. */
  worktrees?: WorktreeMeta[]
  rootPathError?: string | null
  isRootPathPending?: boolean
  panels: Record<string, PanelState>
  // Primary canvas state (current behavior)
  canvasNodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  zoomLevel: number
  viewportOffset: Point
  focusedNodeId: CanvasNodeId | null
  // Dock layout state — saved/restored per workspace on switch
  dockState?: { zones: WindowDockState; locations: Record<string, PanelLocation> }
  // Multi-canvas support (Phase 2+ — unused for now)
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
  | 'newFile'
  | 'closePanel'
  | 'toggleSidebar'
  | 'toggleFileExplorer'
  | 'toggleMinimap'
  | 'nodeSwitcher'
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
  | 'toolSelect'
  | 'toolHand'
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

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  'newTerminal',
  'newBrowser',
  'newEditor',
  'newFile',
  'closePanel',
  'toggleSidebar',
  'toggleFileExplorer',
  'toggleMinimap',
  'nodeSwitcher',
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
  'toolSelect',
  'toolHand',
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
  newFile: 'New File',
  closePanel: 'Close Panel',
  toggleSidebar: 'Toggle Sidebar',
  toggleFileExplorer: 'Toggle File Explorer',
  toggleMinimap: 'Toggle Minimap',
  nodeSwitcher: 'Panel Switcher',
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
  toolSelect: 'Select Tool',
  toolHand: 'Hand Tool',
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
  newFile: storedShortcut('n', { command: true }),
  closePanel: storedShortcut('w', { command: true }),
  toggleSidebar: storedShortcut('b', { command: true }),
  toggleFileExplorer: storedShortcut('x', { command: true, shift: true }),
  toggleMinimap: storedShortcut('m', { command: true, shift: true }),
  nodeSwitcher: storedShortcut(' ', { control: true }),
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
  toolSelect: storedShortcut('v'),
  toolHand: storedShortcut('h'),
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
  /** True when the entry's name itself matched the query. */
  nameMatch: boolean
  /** First line of the file containing the query (only set for content matches). */
  contentPreview?: string
  /** 1-based line number of the first content match. */
  contentLine?: number
}

export interface FileSearchOptions {
  /** Hard cap on the number of results returned (default 200). */
  maxResults?: number
  /** Skip files larger than this many bytes for content search (default 1 MB). */
  maxFileBytes?: number
}

// -----------------------------------------------------------------------------
// Session persistence
// -----------------------------------------------------------------------------

export interface NodeSnapshot {
  panelId: string
  panelType: string // PanelType raw value
  origin: Point
  size: Size
  title: string
  url?: string | null
  /** Browser panels only: per-panel proxy URL (see PanelState.proxyUrl). */
  proxyUrl?: string | null
  filePath?: string | null
  workingDirectory?: string | null
  ptyId?: string
  regionId?: string
  /** Unsaved scratch-editor content, restored on load. */
  unsavedContent?: string
  /** Document panels only: sub-type discriminator for the viewer. */
  documentType?: 'pdf' | 'docx' | 'image'
}

export interface SessionSnapshot {
  workspaceId?: string
  workspaceName: string
  rootPath: string | null
  viewportOffset: Point
  zoomLevel: number
  nodes: NodeSnapshot[]
  regions?: Record<string, CanvasRegion>
  /** Dock zone layout state — added in Phase 5. Missing = empty dock (migration). */
  dockState?: DockStateSnapshot
  /** Panels that live in dock zones (canvas, etc.) — not on the canvas. */
  dockPanels?: Record<string, PanelState>
  /** Resolved companion connection for a remote/WSL workspace (absent ⇒ local).
   *  Persisted so the companion can be reconnected on restore before any
   *  fs/git/terminal op runs. Mirrors WorkspaceState.connection. */
  connection?: CompanionConnection
}

/** One persisted remote workspace (electron-store `remoteProjects`). Remote
 *  workspaces can't use the local `.cate/` project-state files (their tree lives
 *  on a companion), so their full restore snapshot + reconnect info is kept here,
 *  keyed by the `cate-companion://` locator. Local workspaces never appear here —
 *  they round-trip through recentProjects + `.cate/` as before. */
export interface RemoteProjectEntry {
  /** The `cate-companion://` locator string (this workspace's rootPath). */
  locator: string
  /** Reconnect info, used by ensureWorkspaceCompanion on restore. */
  connection: CompanionConnection
  /** Full session snapshot to rebuild the canvas/panels on restore. */
  snapshot: SessionSnapshot
}

/** Persisted sidebar arrangement (electron-store `sidebarSession`). Keyed by
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

/** Snapshot of a detached panel window for session persistence. */
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
  /** Detached panel windows — added in Phase 5. Missing = no panel windows (migration). */
  panelWindows?: PanelWindowSnapshot[]
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
  canvas: {
    nodes: ProjectCanvasNode[]
    regions: ProjectCanvasRegion[]
    zoomLevel: number
    viewportOffset: Point
  }
  dockState?: DockStateSnapshot
  dockPanels?: Record<string, ProjectPanelRef>
}

export interface ProjectCanvasNode {
  panelId: string
  panelType: string
  title: string
  origin: Point
  size: Size
  filePath?: string
  url?: string
  /** Browser panels only: per-panel proxy URL (see PanelState.proxyUrl). */
  proxyUrl?: string
  regionId?: string
  documentType?: 'pdf' | 'docx' | 'image'
  dockLayout?: DockLayoutNode | null
}

export interface ProjectCanvasRegion {
  id: string
  origin: Point
  size: Size
  label: string
  color: string
  zOrder: number
}

export interface ProjectPanelRef {
  type: string
  title: string
  filePath?: string
  url?: string
  /** Browser panels only: per-panel proxy URL (see PanelState.proxyUrl). */
  proxyUrl?: string
}

// -----------------------------------------------------------------------------
// Project-local session file (.cate/session.json) — ephemeral, gitignored
// -----------------------------------------------------------------------------

export interface ProjectSessionFile {
  version: 1
  /** Stable machine-local workspace id, reused across restores so the
   *  main-process workspace list isn't duplicated on renderer reload. */
  workspaceId?: string
  focusedNodeId: string | null
  nodes: Record<string, ProjectSessionNode>
  /** Detached panel windows (machine-local, not committed). */
  panelWindows?: PanelWindowSnapshot[]
  /** Detached dock windows (machine-local, not committed). */
  dockWindows?: DetachedDockWindowSnapshot[]
  /** Resolved companion connection for THIS workspace on THIS machine. Machine-
   *  local on purpose — a server/wsl choice is the opener's, not the repo's, so
   *  it lives here and never in the VCS-committed workspace.json. Absent ⇒ local. */
  connection?: CompanionConnection
}

export interface ProjectSessionNode {
  panelId: string
  zOrder: number
  creationIndex: number
  ptyId?: string
  workingDirectory?: string
  unsavedContent?: string
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
  regions: Array<{
    origin: Point
    size: Size
    label: string
    color: string
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

export interface AppSettings {
  // General
  defaultShellPath: string
  warnBeforeQuit: boolean

  // Appearance
  /** Active unified theme: 'system' (auto light/dark) or a theme id. */
  activeThemeId: ThemeSelection
  /** Theme ids used by 'system' mode for OS light / dark. */
  systemLightThemeId: string
  systemDarkThemeId: string
  /** User-imported / agent-authored unified themes. */
  customThemes: Theme[]
  editorFontSize: number

  // Canvas
  showMinimap: boolean
  defaultPanelWidth: number
  defaultPanelHeight: number
  zoomSpeed: number
  /** When enabled, the node that occupies the most visible canvas area is
   *  automatically focused as the user pans/zooms. */
  autoFocusLargestVisibleNode: boolean
  /** Background pattern drawn on the canvas. */
  canvasGridStyle: CanvasGridStyle
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
  /** Send automatic error/crash reports to Sentry. Takes effect on next launch. */
  crashReportingEnabled: boolean
  /** Send anonymous usage data (app starts, version upgrades, feedback) to the
   *  cero-analytics endpoint. No personal data, no file paths, no project info. */
  usageAnalyticsEnabled: boolean
  /** Whether the user has made a first-run choice about telemetry. Until this is
   *  true, NOTHING is sent (crash reporting and analytics are both held off),
   *  regardless of the two flags above — they only describe the post-consent
   *  state. The first-run consent dialog sets this to true once the user picks. */
  telemetryConsentDecided: boolean

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
}

export const DEFAULT_SETTINGS: AppSettings = {
  // General
  // Empty string = auto-detect from $SHELL / platform fallback chain at spawn
  // time (see src/main/shellResolver.ts). Avoids hardcoding /bin/zsh on Linux,
  // where it commonly isn't installed.
  defaultShellPath: '',
  warnBeforeQuit: false,

  // Appearance
  activeThemeId: 'system',
  systemLightThemeId: 'light-subtle',
  systemDarkThemeId: 'dark-cold',
  customThemes: [],
  editorFontSize: 12,

  // Canvas
  showMinimap: true,
  defaultPanelWidth: 600,
  defaultPanelHeight: 400,
  zoomSpeed: 1.0,
  autoFocusLargestVisibleNode: false,
  canvasGridStyle: 'lines',
  snapToGrid: false,
  placementPicker: true,

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
  browserHomepage: 'about:blank',
  browserSearchEngine: 'google',
  terminalLinkOpenTarget: 'ask',

  // Sidebar
  sidebarTintOpacity: 1.0,
  showFileExplorerOnLaunch: false,

  // File Explorer
  fileExclusions: [...FILE_EXCLUSIONS],

  // Notifications (OS-level only)
  notificationsEnabled: true,
  notifyOnlyWhenUnfocused: true,

  // Privacy. The two flags describe the *post-consent* state; nothing is sent
  // until telemetryConsentDecided flips true via the first-run consent dialog.
  crashReportingEnabled: true,
  usageAnalyticsEnabled: true,
  telemetryConsentDecided: false,

  // Onboarding
  onboardingCompleted: false,

  // Updates
  betaUpdatesEnabled: false,
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

/** Pending tool-call approval request sent from main to renderer. */
export interface AgentToolApprovalRequest {
  panelId: string
  toolCallId: string
  toolName: string
  args: unknown
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
