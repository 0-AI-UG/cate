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

export type PanelType = 'terminal' | 'browser' | 'editor' | 'aiChat' | 'git' | 'fileExplorer' | 'projectList'

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

export interface SplitState {
  direction: 'horizontal' | 'vertical'
  panelIds: [string, string]
  ratio: number // 0-1, position of the divider
}

export interface CanvasNodeState {
  id: CanvasNodeId
  panelId: string
  origin: Point
  size: Size
  zOrder: number
  creationIndex: number
  preMaximizeOrigin?: Point
  preMaximizeSize?: Size
  isPinned?: boolean
  split?: SplitState
  stackedPanelIds?: string[]
  activeStackIndex?: number
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
}

// -----------------------------------------------------------------------------
// Dock system types
// -----------------------------------------------------------------------------

export type DockZonePosition = 'left' | 'right' | 'bottom'

export type PanelLocation =
  | { type: 'canvas' }
  | { type: 'dock'; zone: DockZonePosition; tabIndex: number }
  | { type: 'detached'; windowId: number }

export interface DockZoneState {
  position: DockZonePosition
  panelIds: string[]
  activePanelIndex: number
  size: number
  collapsed: boolean
}

export interface DockLayoutState {
  zones: Record<DockZonePosition, DockZoneState>
}

export const DOCK_ZONE_DEFAULTS: Record<DockZonePosition, { size: number; minSize: number }> = {
  left: { size: 300, minSize: 180 },
  right: { size: 350, minSize: 180 },
  bottom: { size: 250, minSize: 120 },
}

export const DOCK_EDGE_TRIGGER_PX = 60

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
}

// -----------------------------------------------------------------------------
// Workspace state
// -----------------------------------------------------------------------------

export interface WorkspaceState {
  id: string
  name: string
  color: string
  rootPath: string
  panels: Record<string, PanelState>
  canvasNodes: Record<CanvasNodeId, CanvasNodeState>
  regions: Record<string, CanvasRegion>
  zoomLevel: number
  viewportOffset: Point
  focusedNodeId: CanvasNodeId | null
  dockLayout?: DockLayoutState
}

// -----------------------------------------------------------------------------
// Canvas grid style
// -----------------------------------------------------------------------------

export type CanvasGridStyle = 'blank' | 'lines' | 'dots'

// -----------------------------------------------------------------------------
// Appearance mode
// -----------------------------------------------------------------------------

export type AppearanceMode = 'system' | 'light' | 'dark'

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
  | 'toggleLeftDock'
  | 'toggleRightDock'
  | 'toggleBottomDock'

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
  'toggleLeftDock',
  'toggleRightDock',
  'toggleBottomDock',
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
  toggleLeftDock: 'Toggle Left Dock',
  toggleRightDock: 'Toggle Right Dock',
  toggleBottomDock: 'Toggle Bottom Dock',
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
  toggleLeftDock: storedShortcut('b', { command: true, option: true }),
  toggleRightDock: storedShortcut('j', { command: true, option: true }),
  toggleBottomDock: storedShortcut('y', { command: true, option: true }),
}

// -----------------------------------------------------------------------------
// Activity / status types
// -----------------------------------------------------------------------------

export type NodeActivityState =
  | { type: 'normal' }
  | { type: 'commandFinished'; exitCode: number }
  | { type: 'claudeWaitingForInput' }

export type ClaudeCodeState = 'notRunning' | 'running' | 'waitingForInput' | 'finished'

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
  regionId?: string
}

export interface DockSnapshotPanel {
  panelId: string
  panelType: PanelType
  title: string
  filePath?: string | null
  url?: string | null
}

export interface DockZoneSnapshot {
  panelIds: string[]
  activePanelIndex: number
  size: number
  collapsed: boolean
  panels: DockSnapshotPanel[]
}

export interface SessionSnapshot {
  workspaceId?: string
  workspaceName: string
  rootPath: string | null
  viewportOffset: Point
  zoomLevel: number
  nodes: NodeSnapshot[]
  regions?: Record<string, CanvasRegion>
  dockLayout?: Record<DockZonePosition, DockZoneSnapshot>
}

export interface MultiWorkspaceSession {
  version: 2
  selectedWorkspaceIndex: number | null
  workspaces: SessionSnapshot[]
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
// App settings — mirrors AppSettings.swift with all defaults
// -----------------------------------------------------------------------------

export interface AppSettings {
  // General
  restoreSessionOnLaunch: boolean
  defaultShellPath: string
  warnBeforeQuit: boolean

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

  // Terminal
  terminalFontFamily: string
  terminalFontSize: number

  // Browser
  browserHomepage: string
  browserSearchEngine: BrowserSearchEngine

  // Sidebar
  sidebarTintOpacity: number
  showFileExplorerOnLaunch: boolean

  // Notifications
  soundNotificationsEnabled: boolean
  visualNotificationsEnabled: boolean

  // Plugins (Task 25: Plugin/Extension System scaffold)
  pluginDirectory: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  // General
  restoreSessionOnLaunch: true,
  defaultShellPath: '/bin/zsh',
  warnBeforeQuit: false,

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

  // Terminal
  terminalFontFamily: '',
  terminalFontSize: 0,

  // Browser
  browserHomepage: 'about:blank',
  browserSearchEngine: 'google',

  // Sidebar
  sidebarTintOpacity: 1.0,
  showFileExplorerOnLaunch: false,

  // Notifications
  soundNotificationsEnabled: true,
  visualNotificationsEnabled: true,

  // Plugins (Task 25: Plugin/Extension System scaffold)
  pluginDirectory: '',
}

// -----------------------------------------------------------------------------
// Panel size constants — from CanvasLayoutEngine.swift
// -----------------------------------------------------------------------------

export const PANEL_DEFAULT_SIZES: Record<PanelType, Size> = {
  terminal: { width: 640, height: 400 },
  browser: { width: 800, height: 600 },
  editor: { width: 600, height: 500 },
  aiChat: { width: 400, height: 600 },
  git: { width: 500, height: 600 },
  fileExplorer: { width: 300, height: 500 },
  projectList: { width: 300, height: 400 },
}

export const PANEL_MINIMUM_SIZES: Record<PanelType, Size> = {
  terminal: { width: 320, height: 200 },
  browser: { width: 400, height: 300 },
  editor: { width: 300, height: 250 },
  aiChat: { width: 300, height: 300 },
  git: { width: 350, height: 300 },
  fileExplorer: { width: 180, height: 200 },
  projectList: { width: 180, height: 200 },
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
