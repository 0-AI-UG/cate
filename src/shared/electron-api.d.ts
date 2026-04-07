// =============================================================================
// Type declaration for window.electronAPI exposed via contextBridge
// =============================================================================

import type { AppSettings, AgentState, CateWindowParams, DockWindowInitPayload, DetachedDockWindowSnapshot, DockStateSnapshot, FileTreeNode, GitInfo, NotificationAction, PanelState, PanelTransferSnapshot, PanelWindowSnapshot, Point, ProjectUsage, SessionSnapshot, TerminalActivity, UsageSummary, WorkspaceInfo } from './types'

export interface NativeContextMenuItem {
  id?: string
  label?: string
  accelerator?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
  submenu?: NativeContextMenuItem[]
}

export interface ElectronAPI {
  // ---------------------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------------------

  /** Create a new PTY terminal. Returns the terminal ID. */
  terminalCreate(options: {
    cols: number
    rows: number
    cwd?: string
    shell?: string
  }): Promise<string>

  /** Write data (keystrokes) to a terminal. */
  terminalWrite(terminalId: string, data: string): Promise<void>

  /** Resize a terminal PTY. */
  terminalResize(terminalId: string, cols: number, rows: number): Promise<void>

  /** Kill a terminal process. */
  terminalKill(terminalId: string): Promise<void>

  /** Subscribe to terminal data output (main -> renderer). */
  onTerminalData(callback: (terminalId: string, data: string) => void): () => void

  /** Subscribe to terminal exit events (main -> renderer). */
  onTerminalExit(callback: (terminalId: string, exitCode: number) => void): () => void

  /** Get the current working directory of a PTY process by ID. */
  terminalGetCwd(ptyId: string): Promise<string | null>

  /** Read the persisted scrollback log for a terminal. */
  terminalLogRead(terminalId: string): Promise<string | null>

  /** Delete the persisted scrollback log for a terminal. */
  terminalLogDelete(terminalId: string): Promise<void>

  /** Save terminal scrollback content (plain text) for session restore. */
  terminalScrollbackSave(ptyId: string, content: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Filesystem
  // ---------------------------------------------------------------------------

  /** Read a file as UTF-8 text. */
  fsReadFile(filePath: string): Promise<string>

  /** Write UTF-8 text to a file. */
  fsWriteFile(filePath: string, content: string): Promise<void>

  /** Read a directory and return FileTreeNode entries. */
  fsReadDir(dirPath: string): Promise<FileTreeNode[]>

  /** Start watching a directory for changes. */
  fsWatchStart(dirPath: string): Promise<void>

  /** Stop watching a directory. */
  fsWatchStop(dirPath: string): Promise<void>

  /** Stat a path to determine if it is a file or directory. */
  fsStat(filePath: string): Promise<{ isDirectory: boolean; isFile: boolean }>

  /** Subscribe to filesystem watch events (main -> renderer). */
  onFsWatchEvent(
    callback: (event: { type: 'create' | 'update' | 'delete'; path: string }) => void,
  ): () => void

  // ---------------------------------------------------------------------------
  // Git
  // ---------------------------------------------------------------------------

  /** Check if a path is inside a git repository. */
  gitIsRepo(dirPath: string): Promise<boolean>

  /** List tracked + untracked files (git ls-files --cached --others --exclude-standard). */
  gitLsFiles(dirPath: string): Promise<string[]>

  /** Get git status for a repository. */
  gitStatus(cwd: string): Promise<{
    files: Array<{ path: string; index: string; working_dir: string }>
    current: string | null
    tracking: string | null
    ahead: number
    behind: number
  }>

  /** Get diff output for a file or the whole working tree. */
  gitDiff(cwd: string, filePath?: string): Promise<string>

  /** Stage a file. */
  gitStage(cwd: string, filePath: string): Promise<void>

  /** Unstage a file. */
  gitUnstage(cwd: string, filePath: string): Promise<void>

  /** Commit staged changes with a message. */
  gitCommit(cwd: string, message: string): Promise<void>

  /** List git worktrees for a repository. */
  gitWorktreeList(cwd: string): Promise<Array<{
    path: string
    branch: string
    isBare: boolean
    isCurrent: boolean
  }>>

  /** Push to remote. */
  gitPush(cwd: string, remote?: string, branch?: string): Promise<void>

  /** Pull from remote. */
  gitPull(cwd: string, remote?: string, branch?: string): Promise<{
    summary: { changes: number; insertions: number; deletions: number }
  }>

  /** Fetch from remote. */
  gitFetch(cwd: string, remote?: string): Promise<void>

  /** Get commit log. */
  gitLog(cwd: string, maxCount?: number): Promise<Array<{
    hash: string
    message: string
    author_name: string
    author_email: string
    date: string
  }>>

  /** List all branches. */
  gitBranchList(cwd: string): Promise<{
    current: string
    branches: Array<{
      name: string
      current: boolean
      commit: string
      label: string
      isRemote: boolean
    }>
  }>

  /** Create a new branch and switch to it. */
  gitBranchCreate(cwd: string, branchName: string, startPoint?: string): Promise<void>

  /** Delete a branch. */
  gitBranchDelete(cwd: string, branchName: string, force?: boolean): Promise<void>

  /** Checkout a branch. */
  gitCheckout(cwd: string, branchName: string): Promise<void>

  /** Get diff of staged changes. */
  gitDiffStaged(cwd: string, filePath?: string): Promise<string>

  /** Stash changes. */
  gitStash(cwd: string, message?: string): Promise<void>

  /** Pop stashed changes. */
  gitStashPop(cwd: string): Promise<void>

  /** Discard changes to a file (checkout -- file). */
  gitDiscardFile(cwd: string, filePath: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Shell / Process Monitor
  // ---------------------------------------------------------------------------

  /** Register a terminal for process activity monitoring. */
  shellRegisterTerminal(terminalId: string, pid?: number): Promise<void>

  /** Unregister a terminal from process monitoring. */
  shellUnregisterTerminal(terminalId: string): Promise<void>

  /** Subscribe to shell activity updates (main -> renderer). */
  onShellActivityUpdate(
    callback: (terminalId: string, activity: TerminalActivity, agentState: AgentState, agentName: string | null) => void,
  ): () => void

  /** Subscribe to port scan updates (main -> renderer). */
  onShellPortsUpdate(callback: (terminalId: string, ports: number[]) => void): () => void

  /** Subscribe to CWD updates (main -> renderer). */
  onShellCwdUpdate(callback: (terminalId: string, cwd: string) => void): () => void

  /** Subscribe to git branch updates (main -> renderer). */
  onGitBranchUpdate(
    callback: (workspaceId: string, branch: string, isDirty: boolean) => void,
  ): () => void

  /** Start git monitoring for a workspace. */
  gitMonitorStart(workspaceId: string, rootPath: string): void

  /** Stop git monitoring for a workspace. */
  gitMonitorStop(workspaceId: string): void

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  /** Get a single setting value. */
  settingsGet<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]>

  /** Set a single setting value. */
  settingsSet<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>

  /** Get all settings. */
  settingsGetAll(): Promise<AppSettings>

  /** Reset all settings to defaults. */
  settingsReset(): Promise<void>

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  /** Save a session snapshot. */
  sessionSave(snapshot: SessionSnapshot): Promise<void>

  /** Load the last saved session snapshot. Returns null if none exists. */
  sessionLoad(): Promise<SessionSnapshot | null>

  /** Register a callback for flush-save requests from the main process. Returns unsubscribe. */
  onSessionFlushSave(callback: () => void): () => void

  // ---------------------------------------------------------------------------
  // App
  // ---------------------------------------------------------------------------

  /** Get a well-known application path (e.g. 'userData', 'home'). */
  appGetPath(name: string): Promise<string>

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------

  /** Open a native folder picker. Returns the selected path or null if canceled. */
  openFolderDialog(): Promise<string | null>

  /** Open a native save dialog. Returns the chosen file path or null if canceled. */
  saveFileDialog(options: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>

  /** Native unsaved-changes confirmation. Returns 'save' | 'discard' | 'cancel'. */
  confirmUnsavedChanges(payload: { fileName?: string; multiple?: boolean }): Promise<'save' | 'discard' | 'cancel'>

  // ---------------------------------------------------------------------------
  // Recent Projects
  // ---------------------------------------------------------------------------

  /** Get list of recently opened project folders. */
  recentProjectsGet(): Promise<string[]>

  /** Add a project path to the recent projects list. */
  recentProjectsAdd(projectPath: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Layouts
  // ---------------------------------------------------------------------------

  /** Save a named layout snapshot. */
  layoutSave(name: string, layout: unknown): Promise<void>

  /** List names of all saved layouts. */
  layoutList(): Promise<string[]>

  /** Load a named layout snapshot. Returns null if not found. */
  layoutLoad(name: string): Promise<unknown>

  /** Delete a named layout. */
  layoutDelete(name: string): Promise<void>

  /** Capture the current page as a data URL for panel previews. */
  capturePage(): Promise<string | null>

  /** Capture a webview's content and save as PNG. Returns file path + data URL or null. */
  webviewScreenshot(webContentsId: number): Promise<{ filePath: string; dataUrl: string } | null>

  /** Initiate a native OS file drag from the renderer. */
  nativeFileDrag(filePath: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Shell utilities
  // ---------------------------------------------------------------------------

  shellWhich(command: string): Promise<string | null>
  fsDelete(filePath: string): Promise<void>
  fsRename(oldPath: string, newPath: string): Promise<void>
  fsMkdir(dirPath: string): Promise<void>
  shellShowInFolder(filePath: string): Promise<void>
  httpFetch(url: string): Promise<{ ok: boolean; status: number; text: string }>

  // ---------------------------------------------------------------------------
  // MCP Server Management
  // ---------------------------------------------------------------------------

  mcpSpawn(name: string, command: string, args: string[], env: Record<string, string>): Promise<void>
  mcpStop(name: string): Promise<void>
  mcpTest(command: string, args: string[], env: Record<string, string>): Promise<{ success: boolean; error?: string }>
  onMcpStatusUpdate(callback: (update: { name: string; status: string; error?: string }) => void): () => void

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  /** Send an OS notification via the main process. */
  notifyOS(payload: { title: string; body: string; action?: NotificationAction }): Promise<void>

  /** Subscribe to notification action events (OS notification clicked, main -> renderer). */
  onNotifyAction(callback: (action: NotificationAction) => void): () => void

  // ---------------------------------------------------------------------------
  // Window management
  // ---------------------------------------------------------------------------

  /** Create a new Cate window. Returns the Electron window ID. */
  windowCreate(params?: CateWindowParams): Promise<number>

  /** Get the Electron window ID for this renderer's window. */
  windowGetId(): Promise<number | null>

  /** Get the window type for this renderer's window. */
  windowGetType(): Promise<string>

  // ---------------------------------------------------------------------------
  // Panel transfer (cross-window)
  // ---------------------------------------------------------------------------

  /** Initiate a cross-window panel transfer. Returns new window ID if a window was created. */
  panelTransfer(snapshot: PanelTransferSnapshot, targetWindowId?: number): Promise<number | void>

  /** Acknowledge receipt of a panel transfer (flushes buffered terminal data). */
  panelTransferAck(ptyId?: string): Promise<void>

  /** Subscribe to incoming panel transfers (main -> renderer). */
  onPanelReceive(callback: (snapshot: PanelTransferSnapshot) => void): () => void

  /** List all active panel windows with their metadata and bounds. */
  panelWindowsList(): Promise<Array<{ windowId: number; panel: PanelState; workspaceId?: string; bounds: { x: number; y: number; width: number; height: number }; terminalPtyId?: string }>>

  /** Report the terminal ptyId for this panel window so the main process can persist it. */
  panelWindowSyncPty(ptyId: string): Promise<void>

  /** Request this panel window to dock back into the main window. */
  panelWindowDockBack(): Promise<void>

  /** Subscribe to dock-back requests from panel windows (main -> renderer). */
  onPanelWindowDockBack(callback: (panelWindowId: number) => void): () => void

  // ---------------------------------------------------------------------------
  // Cross-window drag-and-drop
  // ---------------------------------------------------------------------------

  /** Start an OS-level drag with a panel transfer snapshot. */
  dragStart(snapshot: PanelTransferSnapshot): Promise<void>

  /** Panel was dropped on desktop — create a new dock window. Resolves to
   *  `null` when the main window is in macOS native fullscreen; the caller
   *  should treat that as "detach refused" and keep the panel where it was. */
  dragDetach(snapshot: PanelTransferSnapshot, workspaceId?: string): Promise<number | null>

  /** Synchronous cached check: is the main window currently in native
   *  fullscreen? Drag handlers use this to refuse cross-window detach
   *  without an IPC round-trip per mousemove. */
  isMainWindowFullscreen(): boolean

  /** Subscribe to fullscreen enter/leave events for any Cate window. */
  onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void

  /** Subscribe to drag end events (main -> renderer). */
  onDragEnd(callback: () => void): () => void

  // ---------------------------------------------------------------------------
  // Dock window management
  // ---------------------------------------------------------------------------

  /** Subscribe to dock window initialization (main -> renderer). */
  onDockWindowInit(callback: (payload: DockWindowInitPayload) => void): () => void

  /** Sync dock window state to main process for session persistence. */
  dockWindowSyncState(state: DockStateSnapshot & { panels: Record<string, PanelState>; terminalPtyIds?: Record<string, string> }): Promise<void>

  /** List all dock windows with their state and bounds. */
  dockWindowsList(): Promise<DetachedDockWindowSnapshot[]>

  // ---------------------------------------------------------------------------
  // Cross-window drag coordination
  // ---------------------------------------------------------------------------

  /** Start a cross-window drag — notifies main to broadcast to other windows. */
  crossWindowDragStart(snapshot: PanelTransferSnapshot, screenPos: Point): Promise<void>

  /** Subscribe to cross-window drag cursor updates (main -> renderer). */
  onCrossWindowDragUpdate(callback: (screenPos: Point, snapshot: PanelTransferSnapshot) => void): () => void

  /** Report that this window accepted a cross-window drop. */
  crossWindowDragDrop(panelId: string): Promise<void>

  /** Cancel an active cross-window drag. */
  crossWindowDragCancel(): Promise<void>

  /** Resolve a cross-window drag on mouseup. Returns whether a target window claimed the drop.
   *  If not claimed, the caller should fall back to dragDetach(). */
  crossWindowDragResolve(): Promise<{ claimed: boolean }>

  // ---------------------------------------------------------------------------
  // Workspace management (main process is source of truth)
  // ---------------------------------------------------------------------------

  /** List all workspace metadata from the main process. */
  workspaceList(): Promise<WorkspaceInfo[]>

  /** Create a new workspace in the main process. Returns the created WorkspaceInfo. */
  workspaceCreate(options?: { name?: string; rootPath?: string; id?: string }): Promise<WorkspaceInfo>

  /** Update workspace metadata in the main process. Returns the updated WorkspaceInfo. */
  workspaceUpdate(id: string, changes: Partial<Omit<WorkspaceInfo, 'id'>>): Promise<WorkspaceInfo | null>

  /** Remove a workspace from the main process. Returns true if removed. */
  workspaceRemove(id: string): Promise<boolean>

  /** Get a single workspace's metadata by ID. */
  workspaceGet(id: string): Promise<WorkspaceInfo | null>

  /** Subscribe to workspace list changes broadcast from main process. */
  onWorkspaceChanged(callback: (workspaces: WorkspaceInfo[], originWindowId: number | null) => void): () => void

  // ---------------------------------------------------------------------------
  // File drag-and-drop helpers
  // ---------------------------------------------------------------------------

  /** Get the absolute file path for a File object from an OS drag-and-drop. */
  getPathForFile(file: File): string

  // ---------------------------------------------------------------------------
  // Menu actions (main -> renderer)
  // ---------------------------------------------------------------------------

  onMenuOpenSettings(callback: () => void): () => void

  /** Subscribe to native menu action dispatches (File, Edit, etc.). */
  onMenuTriggerAction(callback: (action: import('./types').MenuActionId) => void): () => void

  /** Show a native context menu. Returns the clicked item id, or null if dismissed. */
  showContextMenu(items: NativeContextMenuItem[]): Promise<string | null>

  // ---------------------------------------------------------------------------
  // Token usage tracking
  // ---------------------------------------------------------------------------

  /** Get the full usage summary across all tools and projects. */
  usageGetSummary(): Promise<UsageSummary>

  /** Get usage detail for a specific project path. Returns null if not found. */
  usageGetProject(projectPath: string): Promise<ProjectUsage | null>

  /** Subscribe to usage update events (main -> renderer). Returns unsubscribe. */
  onUsageUpdate(callback: (changedProjects: string[]) => void): () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
