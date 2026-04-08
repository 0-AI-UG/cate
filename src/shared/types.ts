// =============================================================================
// Shared TypeScript types for CanvasIDE Electron app
// Ported from Swift source files to maintain exact parity.
// =============================================================================

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

export type PanelType = 'terminal' | 'browser' | 'editor' | 'git' | 'fileExplorer' | 'projectList' | 'canvas'

// -----------------------------------------------------------------------------
// AI Tool Configuration
// -----------------------------------------------------------------------------

export type AIToolId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode'

export interface AIConfigFile {
  relativePath: string
  exists: boolean
  description: string
  isDirectory?: boolean
}

export interface AIToolPresence {
  id: AIToolId
  name: string
  icon: string
  detected: boolean
  configFiles: AIConfigFile[]
}

// MCP Server types
export interface MCPServerDefinition {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface MCPServerConfig extends MCPServerDefinition {
  status: 'stopped' | 'starting' | 'running' | 'error'
  error?: string
}

export interface MCPStatusUpdate {
  name: string
  status: MCPServerConfig['status']
  error?: string
}

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
}

// -----------------------------------------------------------------------------
// Canvas annotation (sticky notes and text labels)
// -----------------------------------------------------------------------------

export interface CanvasAnnotation {
  id: string
  type: 'stickyNote' | 'textLabel'
  origin: Point
  size: Size
  content: string
  color: string
  fontSize?: 'sm' | 'md' | 'lg' | 'xl'
  fontSizePx?: number
  bold?: boolean
}

// -----------------------------------------------------------------------------
// LOD state (level-of-detail for zoom)
// -----------------------------------------------------------------------------

export type LODState = 'live' | 'placeholder'

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
  /** When set, EditorPanel renders as a Monaco diff editor. */
  diffMode?: 'staged' | 'working'
}

// -----------------------------------------------------------------------------
// Workspace metadata — shared across windows, managed by main process
// -----------------------------------------------------------------------------

export interface WorkspaceInfo {
  id: string
  name: string
  color: string
  rootPath: string
}

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
  annotations?: Record<string, CanvasAnnotation>
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
  panels: Record<string, PanelState>
  // Primary canvas state (current behavior)
  canvasNodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  annotations: Record<string, CanvasAnnotation>
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
// Canvas grid style
// -----------------------------------------------------------------------------

export type CanvasGridStyle = 'blank' | 'lines' | 'dots'

// -----------------------------------------------------------------------------
// Appearance mode
// -----------------------------------------------------------------------------

export type AppearanceMode = 'system' | 'dark-warm' | 'light-subtle' | 'dark-cold'

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

// -----------------------------------------------------------------------------
// Token usage tracking
// -----------------------------------------------------------------------------

export type AgentTool = 'claude' | 'codex' | 'opencode'

export interface TokenCounts { input: number; output: number; cacheCreate: number; cacheRead: number }

export interface ModelUsage { model: string; tool: AgentTool; tokens: TokenCounts; costUsd: number | null; messageCount: number }

export interface DayUsage { date: string; tokens: TokenCounts; costUsd: number | null }

export interface ProjectTotals { tokens: TokenCounts; costUsd: number | null; messageCount: number }

export interface ProjectUsage { projectPath: string; byModel: ModelUsage[]; byDay: DayUsage[]; totals: ProjectTotals; lastActivity: string }

export interface UsageSummary { totals: ProjectTotals; projects: ProjectUsage[]; unattributed: ProjectUsage }

// All 17 shortcut actions — matches Swift ShortcutAction enum exactly.
export type ShortcutAction =
  | 'newTerminal'
  | 'newBrowser'
  | 'newEditor'
  | 'closePanel'
  | 'toggleSidebar'
  | 'toggleFileExplorer'
  | 'toggleMinimap'
  | 'nodeSwitcher'
  | 'panelSwitcher'
  | 'commandPalette'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'focusNext'
  | 'focusPrevious'
  | 'saveFile'
  | 'zoomToFit'
  | 'globalSearch'
  | 'undo'
  | 'redo'
  | 'deleteNode'

/** Actions the native menu can dispatch into the renderer. Superset of
 *  ShortcutAction — includes a few menu-only items that have no keyboard
 *  binding. */
export type MenuActionId = ShortcutAction | 'openFolder'

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  'newTerminal',
  'newBrowser',
  'newEditor',
  'closePanel',
  'toggleSidebar',
  'toggleFileExplorer',
  'toggleMinimap',
  'nodeSwitcher',
  'panelSwitcher',
  'commandPalette',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'focusNext',
  'focusPrevious',
  'saveFile',
  'zoomToFit',
  'globalSearch',
  'undo',
  'redo',
  'deleteNode',
]

export const SHORTCUT_DISPLAY_NAMES: Record<ShortcutAction, string> = {
  newTerminal: 'New Terminal',
  newBrowser: 'New Browser',
  newEditor: 'New Editor',
  closePanel: 'Close Panel',
  toggleSidebar: 'Toggle Sidebar',
  toggleFileExplorer: 'Toggle File Explorer',
  toggleMinimap: 'Toggle Minimap',
  nodeSwitcher: 'Panel Switcher',
  panelSwitcher: 'Panel Switcher',
  commandPalette: 'Command Palette',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  zoomReset: 'Reset Zoom',
  focusNext: 'Focus Next Panel',
  focusPrevious: 'Focus Previous Panel',
  saveFile: 'Save File',
  zoomToFit: 'Zoom to Fit',
  globalSearch: 'Global Search',
  undo: 'Undo',
  redo: 'Redo',
  deleteNode: 'Delete Focused Panel',
}

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, StoredShortcut> = {
  newTerminal: storedShortcut('t', { command: true }),
  newBrowser: storedShortcut('b', { command: true, shift: true }),
  newEditor: storedShortcut('e', { command: true, shift: true }),
  closePanel: storedShortcut('w', { command: true }),
  toggleSidebar: storedShortcut('\\', { command: true }),
  toggleFileExplorer: storedShortcut('f', { command: true, shift: true }),
  toggleMinimap: storedShortcut('m', { command: true, shift: true }),
  nodeSwitcher: storedShortcut(' ', { control: true }),
  panelSwitcher: storedShortcut('e', { command: true }),
  commandPalette: storedShortcut('k', { command: true }),
  zoomIn: storedShortcut('=', { command: true }),
  zoomOut: storedShortcut('-', { command: true }),
  zoomReset: storedShortcut('0', { command: true }),
  focusNext: storedShortcut('\t', { control: true }),
  focusPrevious: storedShortcut('\t', { shift: true, control: true }),
  saveFile: storedShortcut('s', { command: true }),
  zoomToFit: storedShortcut('1', { command: true }),
  globalSearch: storedShortcut('h', { command: true, shift: true }),
  undo: storedShortcut('z', { command: true }),
  redo: storedShortcut('z', { command: true, shift: true }),
  deleteNode: storedShortcut('Backspace', { command: true }),
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
  filePath?: string | null
  workingDirectory?: string | null
  ptyId?: string
  regionId?: string
}

export interface SessionSnapshot {
  workspaceId?: string
  workspaceName: string
  rootPath: string | null
  viewportOffset: Point
  zoomLevel: number
  nodes: NodeSnapshot[]
  regions?: Record<string, CanvasRegion>
  annotations?: Record<string, CanvasAnnotation>
  /** Dock zone layout state — added in Phase 5. Missing = empty dock (migration). */
  dockState?: DockStateSnapshot
  /** Panels that live in dock zones (canvas, git, fileExplorer, etc.) — not on the canvas. */
  dockPanels?: Record<string, PanelState>
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

export type NotificationMode = 'off' | 'os' | 'inApp' | 'both'

export type NotificationAction =
  | { type: 'focusTerminal'; workspaceId: string; terminalId: string }

// -----------------------------------------------------------------------------
// App settings — mirrors AppSettings.swift with all defaults
// -----------------------------------------------------------------------------

export interface AppSettings {
  // General
  restoreSessionOnLaunch: boolean
  defaultShellPath: string
  warnBeforeQuit: boolean
  /** macOS only: enable native window tabs (tabbingIdentifier on main windows).
   *  Takes effect on next launch. */
  nativeTabs: boolean

  // Appearance
  appearanceMode: AppearanceMode
  editorFontSize: number

  // Canvas
  gridStyle: CanvasGridStyle
  snapToGridEnabled: boolean
  gridSpacing: number
  showMinimap: boolean
  defaultPanelWidth: number
  defaultPanelHeight: number
  zoomSpeed: number
  /** When enabled, the node that occupies the most visible canvas area is
   *  automatically focused as the user pans/zooms. */
  autoFocusLargestVisibleNode: boolean

  // Terminal
  terminalFontFamily: string
  terminalFontSize: number
  /** xterm.js scrollback buffer size, in lines. Lower = less memory per terminal. */
  terminalScrollback: number

  // Browser
  browserHomepage: string
  browserSearchEngine: BrowserSearchEngine

  // Sidebar
  sidebarTintOpacity: number
  showFileExplorerOnLaunch: boolean

  // Notifications
  notificationsEnabled: boolean
  notificationMode: NotificationMode
  notifyOnTerminalHalt: boolean
  notifyOnlyWhenUnfocused: boolean

}

export const DEFAULT_SETTINGS: AppSettings = {
  // General
  restoreSessionOnLaunch: true,
  defaultShellPath: '/bin/zsh',
  warnBeforeQuit: false,
  nativeTabs: true,

  // Appearance
  appearanceMode: 'system',
  editorFontSize: 12,

  // Canvas
  gridStyle: 'lines',
  snapToGridEnabled: true,
  gridSpacing: 20,
  showMinimap: true,
  defaultPanelWidth: 600,
  defaultPanelHeight: 400,
  zoomSpeed: 1.0,
  autoFocusLargestVisibleNode: false,

  // Terminal
  terminalFontFamily: '',
  terminalFontSize: 0,
  terminalScrollback: 2000,

  // Browser
  browserHomepage: 'about:blank',
  browserSearchEngine: 'google',

  // Sidebar
  sidebarTintOpacity: 1.0,
  showFileExplorerOnLaunch: false,

  // Notifications
  notificationsEnabled: true,
  notificationMode: 'both',
  notifyOnTerminalHalt: true,
  notifyOnlyWhenUnfocused: true,

}

// -----------------------------------------------------------------------------
// Panel size constants — from CanvasLayoutEngine.swift
// -----------------------------------------------------------------------------

export const PANEL_DEFAULT_SIZES: Record<PanelType, Size> = {
  terminal: { width: 640, height: 400 },
  browser: { width: 800, height: 600 },
  editor: { width: 600, height: 500 },
  git: { width: 500, height: 600 },
  fileExplorer: { width: 300, height: 500 },
  projectList: { width: 300, height: 400 },
  canvas: { width: 800, height: 600 },
}

export const PANEL_MINIMUM_SIZES: Record<PanelType, Size> = {
  terminal: { width: 320, height: 200 },
  browser: { width: 400, height: 300 },
  editor: { width: 300, height: 250 },
  git: { width: 350, height: 300 },
  fileExplorer: { width: 180, height: 200 },
  projectList: { width: 180, height: 200 },
  canvas: { width: 400, height: 300 },
}

// -----------------------------------------------------------------------------
// Zoom constants — from CanvasState.swift
// -----------------------------------------------------------------------------

export const ZOOM_MIN = 0.3
export const ZOOM_MAX = 3.0
export const ZOOM_DEFAULT = 1.0

// -----------------------------------------------------------------------------
// File exclusions — from FileTreeModel.swift defaultExclusions
// -----------------------------------------------------------------------------

export const FILE_EXCLUSIONS: string[] = [
  '.git',
  'node_modules',
  '.build',
  'DerivedData',
  '.DS_Store',
  '__pycache__',
  '.swiftpm',
  'Pods',
  '.Trash',
  '.cache',
  '.npm',
  'dist',
  'build',
]
