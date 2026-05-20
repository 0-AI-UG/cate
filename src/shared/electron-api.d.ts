// =============================================================================
// Type declaration for window.electronAPI exposed via contextBridge
// =============================================================================

import type { AppSettings, AgentState, CateWindowParams, DockWindowInitPayload, DetachedDockWindowSnapshot, DockStateSnapshot, FileSearchOptions, FileSearchResult, FileTreeNode, GitInfo, NotificationAction, PanelState, PanelTransferSnapshot, PanelWindowSnapshot, Point, SessionSnapshot, TerminalActivity, WorkspaceInfo, WorkspaceMutationResult } from './types'

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

  /** Search for files by name and content (flat result list). */
  fsSearch(rootPath: string, query: string, options?: FileSearchOptions): Promise<FileSearchResult[]>

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

  /** Notify the main process that the flush save completed. */
  sessionFlushSaveDone(): void

  // ---------------------------------------------------------------------------
  // App
  // ---------------------------------------------------------------------------

  /** Subscribe to folder/file paths forwarded from the OS — e.g. the user
   *  dropped a folder on the dock icon or opened one via "Open With Cate".
   *  Returns an unsubscribe function. */
  onOpenPath(callback: (filePath: string) => void): () => void

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------

  /** Open a native folder picker. Returns the selected path or null if canceled. */
  openFolderDialog(): Promise<string | null>

  /** Open a native image file picker (multi-select). Returns selected paths or null if canceled. */
  openImageDialog(): Promise<string[] | null>

  /** Read a file and return a base64 data URL if its bytes sniff as an image
   *  (PNG/JPEG/GIF/WebP/BMP/SVG). Returns null for non-image or oversized files. */
  readImageAsDataUrl(filePath: string): Promise<{ mime: string; dataUrl: string } | null>

  /** Native unsaved-changes confirmation. Returns 'save' | 'discard' | 'cancel'. */
  confirmUnsavedChanges(payload: { fileName?: string; multiple?: boolean }): Promise<'save' | 'discard' | 'cancel'>

  /** Native confirmation shown when closing a canvas panel. When the canvas is
   *  not the last and has open panels, returns 'move' | 'delete' | 'cancel'.
   *  Otherwise returns 'close' | 'cancel'. */
  confirmCloseCanvas(payload: { panelCount: number; isLast: boolean }): Promise<'move' | 'delete' | 'close' | 'cancel'>

  /** Native confirmation shown when deleting a region that has panels inside.
   *  Returns 'with-contents' (delete region + contents), 'region-only' (keep
   *  contents, just remove the region around them), or 'cancel'. */
  confirmDeleteRegion(payload: { panelCount: number }): Promise<'with-contents' | 'region-only' | 'cancel'>

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

  fsDelete(filePath: string): Promise<void>
  fsRename(oldPath: string, newPath: string): Promise<void>
  fsMkdir(dirPath: string): Promise<void>
  fsCopy(srcPath: string, destDir: string): Promise<string>
  shellShowInFolder(filePath: string): Promise<void>

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

  /** Create a new workspace in the main process. */
  workspaceCreate(options?: { name?: string; rootPath?: string; id?: string }): Promise<WorkspaceMutationResult>

  /** Update workspace metadata in the main process. */
  workspaceUpdate(id: string, changes: Partial<Omit<WorkspaceInfo, 'id'>>): Promise<WorkspaceMutationResult>

  /** Remove a workspace from the main process. Returns true if removed. */
  workspaceRemove(id: string): Promise<boolean>

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
  // Orchestrator (cate CLI graph sync)
  // ---------------------------------------------------------------------------

  /** Push a full snapshot of this window's terminals + canvas connections to
   *  the main-process orchestrator. Called on every relevant store change. */
  orchSyncRegistry(snapshot: {
    terminals: Array<{ ptyId: string | null; panelId: string; nodeId: string | null; name: string }>
    portals?: Array<{ panelId: string; nodeId: string | null; name: string }>
    connections: Array<{ from: string; to: string }>
  }): Promise<void>

  /** Subscribe to "ask in flight" events emitted by the orchestrator so the
   *  canvas can animate the connection line during a `cate ask`. Returns an
   *  unsubscribe function. */
  onOrchInflight(callback: (payload: { fromNodeId: string; toNodeId: string; active: boolean }) => void): () => void

  /** Subscribe to orchestrator-driven UI commands (recruit/dismiss/connect/note/portal).
   *  The handler is awaited; its return value is sent back to main as the response.
   *  Throw to signal failure. Returns an unsubscribe function. */
  onOrchCommand(handler: (req: { id: number; verb: string; args?: any }) => Promise<any>): () => void

  /** Push a (panelId, webContentsId, alive) tuple to main so it can build a
   *  webContents → portal-panel reverse map for popup parent resolution. */
  orchRegisterPortalWc(payload: { panelId: string; webContentsId: number; alive: boolean }): void

  // -------------------------------------------------------------------------
  // Auto-updater
  // -------------------------------------------------------------------------

  /** Subscribe to update-status broadcasts from the main process. */
  onUpdateStatus(callback: (status: unknown) => void): () => void
  /** Fetch the current update status (e.g. on window mount). */
  updateGetStatus(): Promise<unknown>
  /** Start downloading the available update (electron-updater path only). */
  updateDownload(): void
  /** Apply the downloaded update and restart the app. */
  updateInstall(): void
  /** Open the GitHub release page when auto-install is unavailable. */
  updateOpenRelease(url?: string): void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
