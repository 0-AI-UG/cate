// =============================================================================
// Type declaration for window.electronAPI exposed via contextBridge
// =============================================================================

import type { AgentCreateOptions, AgentEventEnvelope, AgentExtensionUIResponse, AgentImageAttachment, AgentModelRef, AgentModelDescriptor, AgentRpcState, AgentSessionListEntry, AgentSessionStats, AgentSlashCommand, AgentThinkingLevel, AgentToolApprovalRequest, AppSettings, AgentState, AuthProviderDescriptor, AuthProviderStatus, CanvasLayoutSnapshot, CateWindowParams, CustomOpenAIProvider, DockWindowInitPayload, DetachedDockWindowSnapshot, DockStateSnapshot, FileSearchOptions, FileSearchResult, FileTreeNode, GitInfo, SearchOptions, SearchResultBatch, SearchDoneEvent, NotificationAction, OAuthFlowEvent, PanelState, PanelTransferSnapshot, PanelWindowSnapshot, PerfSnapshot, Point, SessionSnapshot, SidebarSession, TerminalActivity, WorkspaceInfo, WorkspaceMutationResult, RemoteConnectSpec, CompanionConnectResult, CompanionStatusEvent, CompanionConnection, CompanionPhase, RemoteProjectEntry, SshHostEntry, UIState } from './types'
import type { SavedSkill, InstalledSkill, SkillEntry, SkillSource, SkillTargetId } from './skills'

export interface NativeContextMenuItem {
  id?: string
  label?: string
  accelerator?: string
  enabled?: boolean
  type?: 'normal' | 'separator'
  submenu?: NativeContextMenuItem[]
}

export interface ElectronAPI {
  /** True when launched with CATE_E2E=1 (Playwright). Renderer uses this to
   *  install the test harness on window.__cateE2E. */
  isE2E: boolean

  /** True when launched with CATE_PERF=1. Renderer mounts the resource HUD. */
  isPerf: boolean

  /** Pull the latest main-process resource snapshot (null until first sample). */
  perfGetSnapshot(): Promise<PerfSnapshot | null>

  /** Set this window's UI zoom factor (Cate chrome only). Clamped to 0.5–2.0. */
  setUiScale(scale: number): void

  // ---------------------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------------------

  /** Create a new PTY terminal. Returns the terminal ID. */
  terminalCreate(options: {
    cols: number
    rows: number
    cwd?: string
    shell?: string
    workspaceId?: string
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

  /** Notify main of a terminal panel's on-screen visibility. Used by the
   *  idle-suspend logic to SIGSTOP terminals that are offscreen and silent. */
  terminalSetVisibility(terminalId: string, visible: boolean): Promise<void>

  // ---------------------------------------------------------------------------
  // Filesystem
  // ---------------------------------------------------------------------------

  /** Read a file as UTF-8 text. The optional workspaceId scopes path
   *  validation to the owning workspace's allowed roots. */
  fsReadFile(filePath: string, workspaceId?: string): Promise<string>

  /** Read a file as binary (ArrayBuffer). */
  fsReadBinary(filePath: string, workspaceId?: string): Promise<ArrayBuffer>

  /** Write UTF-8 text to a file. */
  fsWriteFile(filePath: string, content: string, workspaceId?: string): Promise<void>

  /** Read a directory and return FileTreeNode entries. */
  fsReadDir(dirPath: string, workspaceId?: string): Promise<FileTreeNode[]>

  /** Quick file finder — matches file names only (flat result list). */
  fsSearch(rootPath: string, query: string, options?: FileSearchOptions, workspaceId?: string): Promise<FileSearchResult[]>

  /** Start watching a directory for changes. */
  fsWatchStart(dirPath: string, workspaceId?: string): Promise<void>

  /** Stop watching a directory. */
  fsWatchStop(dirPath: string, workspaceId?: string): Promise<void>

  /** Stat a path to determine if it is a file or directory. */
  fsStat(filePath: string, workspaceId?: string): Promise<{ isDirectory: boolean; isFile: boolean }>

  /** Subscribe to filesystem watch events (main -> renderer). */
  onFsWatchEvent(
    callback: (event: { type: 'create' | 'update' | 'delete'; path: string }) => void,
  ): () => void

  // ---------------------------------------------------------------------------
  // Content search (ripgrep-backed Search view)
  // ---------------------------------------------------------------------------

  /** Start a streaming content search. The caller supplies a searchId (set in
   *  the store first) so streamed events can be correlated without a race.
   *  Cancels any previous search for this window. */
  searchStart(rootPath: string, searchId: string, options: SearchOptions, workspaceId?: string): Promise<string>

  /** Cancel the in-flight search for this window. */
  searchCancel(): Promise<void>

  /** Subscribe to streamed search result batches (main -> renderer). */
  onSearchResult(callback: (batch: SearchResultBatch) => void): () => void

  /** Subscribe to the terminal search event with final stats / error. */
  onSearchDone(callback: (event: SearchDoneEvent) => void): () => void

  // ---------------------------------------------------------------------------
  // Git
  // ---------------------------------------------------------------------------

  /** Check if a path is inside a git repository. */
  gitIsRepo(dirPath: string): Promise<boolean>

  /** Initialize a new git repository at the given directory. */
  gitInit(dirPath: string): Promise<void>

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

  /** Create a new git worktree at `targetPath` checked out on `branch`. When
   *  `options.createBranch` is true, the branch is created from `baseRef`
   *  (defaults to HEAD). */
  gitWorktreeAdd(
    repoCwd: string,
    branch: string,
    targetPath: string,
    options?: { createBranch?: boolean; baseRef?: string },
  ): Promise<{ path: string; branch: string }>

  /** Remove a git worktree registration and delete its directory from disk. */
  gitWorktreeRemove(repoCwd: string, worktreePath: string, options?: { force?: boolean }): Promise<void>

  /** Prune git worktree metadata for directories that no longer exist. */
  gitWorktreePrune(repoCwd: string): Promise<{ output: string }>

  /** Cheap status snapshot for a worktree — used for sidebar badges. */
  gitWorktreeStatus(worktreePath: string): Promise<{
    branch: string
    dirty: boolean
    ahead: number
    behind: number
    staged: number
    unstaged: number
    untracked: number
  } | null>

  /** Fetch + checkout `toBranch` + merge `fromBranch` into it. Returns
   *  `{ ok: false, conflict }` on merge failure so the renderer can show a
   *  conflict prompt instead of throwing. */
  gitWorktreeMergeTo(
    repoCwd: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<{ ok: true; result: unknown } | { ok: false; conflict: boolean; message: string }>

  /** Fetch + merge `fromBranch` (the primary branch) into a worktree's own
   *  branch, run inside the worktree so the primary checkout is untouched. */
  gitWorktreeUpdateFrom(
    worktreePath: string,
    fromBranch: string,
  ): Promise<{ ok: true; result: unknown } | { ok: false; conflict: boolean; message: string }>

  /** Check out an open pull request (including fork branches) into its own
   *  worktree via `gh pr checkout`. Requires the `gh` CLI. */
  gitWorktreeAddFromPr(
    repoCwd: string,
    prNumber: number,
    targetPath: string,
  ): Promise<{ path: string; branch: string }>

  /** List open pull requests for the branch picker. Returns [] without `gh`. */
  gitPrList(
    repoCwd: string,
  ): Promise<Array<{ number: number; title: string; headRefName: string; author: string; isFork: boolean }>>

  /** Push the branch (with upstream) and open a GitHub PR via the `gh` CLI,
   *  falling back to a github.com compare URL when `gh` is unavailable. */
  gitCreatePR(
    worktreePath: string,
    branch: string,
  ): Promise<
    | { ok: true; created: boolean; url: string; fallback?: boolean }
    | { ok: false; message: string }
  >

  /** Look up the PR for a branch via `gh`. Returns null when `gh` is missing
   *  or the branch has no PR. */
  gitPrStatus(
    worktreePath: string,
    branch: string,
  ): Promise<{ number: number; state: string; url: string; isDraft: boolean } | null>

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
    callback: (
      terminalId: string,
      activity: TerminalActivity,
      agentName: string | null,
      agentPresent: boolean,
    ) => void,
  ): () => void

  /** Subscribe to port scan updates (main -> renderer). */
  onShellPortsUpdate(callback: (terminalId: string, ports: number[]) => void): () => void

  /** Subscribe to CWD updates (main -> renderer). */
  onShellCwdUpdate(callback: (terminalId: string, cwd: string) => void): () => void

  /**
   * Report an agent's screen-derived state up to main. The renderer that owns
   * the xterm instance reads its buffer to detect prompt vs. working, and
   * pushes the result here so other windows' sidebars can mirror it.
   */
  shellReportAgentScreenState(terminalId: string, state: AgentState): void

  /** Subscribe to screen-state broadcasts from main (originating in any window). */
  onAgentScreenStateUpdate(
    callback: (terminalId: string, state: AgentState) => void,
  ): () => void

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

  /** Get all transient UI state (minimap placement) from ui-state.json. */
  uiStateGetAll(): Promise<UIState>

  /** Set a single UI-state value. */
  uiStateSet<K extends keyof UIState>(key: K, value: UIState[K]): Promise<void>

  /** Subscribe to setting-change broadcasts from main (key + new value). Returns unsubscribe. */
  onSettingsChanged(callback: (key: keyof AppSettings, value: unknown) => void): () => void

  /** Grant this window access to settings.json and return its absolute path so
   *  it can be opened in an editor panel. */
  settingsOpenInEditor(): Promise<string>

  /** Subscribe to full-settings broadcasts emitted when settings.json is edited
   *  externally. Returns unsubscribe. */
  onSettingsReloaded(callback: (settings: AppSettings) => void): () => void

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------


  /** Register a callback for flush-save requests from the main process. Returns unsubscribe. */
  onSessionFlushSave(callback: () => void): () => void

  /** Notify the main process that the flush save completed. */
  sessionFlushSaveDone(): void

  /** Save project-local workspace + session state to .cate/ directory. */
  projectStateSave(
    rootPath: string,
    workspace: import('./types').ProjectWorkspaceFile,
    session: import('./types').ProjectSessionFile,
  ): Promise<void>

  /** Load project-local state from .cate/ directory. Returns null if not found. */
  projectStateLoad(rootPath: string): Promise<{
    workspace: import('./types').ProjectWorkspaceFile
    session: import('./types').ProjectSessionFile | null
  } | null>

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

  /** Open a native image picker for the canvas wallpaper. Returns the selected
   *  absolute path or null if canceled. */
  openImageDialog(): Promise<string | null>

  /** Read a canvas-wallpaper image file as a `data:` URL (or null if the path is
   *  missing, not an image, or too large). Reads in main, so the file may live
   *  outside the workspace allowed roots. */
  readCanvasBackgroundImage(filePath: string): Promise<string | null>

  /** Open a native Save-As dialog. Returns the chosen path or null if canceled.
   *  defaultName is used as the filename pre-fill, defaultPath as the starting
   *  directory + filename (takes precedence). The returned path is the canonical
   *  (realpath-of-parent + basename) form that the main process granted access
   *  to — store that exact string on the panel state to keep future
   *  reads/writes aligned with the grant set. */
  saveFileDialog(payload?: { defaultName?: string; defaultPath?: string }): Promise<string | null>

  /** Native unsaved-changes confirmation. Returns 'save' | 'discard' | 'cancel'.
   *  `filePath`, when supplied for a single dirty file, is shown as the dialog
   *  detail so the user can see exactly which file on disk is about to change. */
  confirmUnsavedChanges(payload: { fileName?: string; multiple?: boolean; filePath?: string }): Promise<'save' | 'discard' | 'cancel'>

  /** Native confirmation shown when closing a terminal whose PTY is currently
   *  running a foreground process (a dev server, an editor, an agent like Claude
   *  or Codex, …). `processName`, when known for a single terminal, is shown so
   *  the user sees what is about to be killed. Returns 'close' | 'cancel'. */
  confirmCloseTerminal(payload: { count: number; processName?: string | null }): Promise<'close' | 'cancel'>

  /** Native confirmation shown when closing a canvas panel. When the canvas is
   *  not the last and has open panels, returns 'move' | 'delete' | 'cancel'.
   *  Otherwise returns 'close' | 'cancel'. */
  confirmCloseCanvas(payload: { panelCount: number; isLast: boolean }): Promise<'move' | 'delete' | 'close' | 'cancel'>

  /** Confirm reloading the canvas after workspace.json changed on disk. */
  confirmReloadWorkspace(payload: { name?: string }): Promise<'reload' | 'cancel'>

  /** Native confirmation shown when external files/folders are dropped onto the
   *  file explorer. Returns 'copy' (duplicate into the directory), 'move'
   *  (relocate into the directory, removing the originals), or 'cancel'. */
  confirmImportEntries(payload: { count: number; destName: string }): Promise<'copy' | 'move' | 'cancel'>

  /** Native dialog asking where a Cmd/Ctrl+clicked terminal link should open,
   *  shown the first time while the terminalLinkOpenTarget setting is 'ask'.
   *  Returns 'canvas' (in-app browser panel), 'external' (system browser), or
   *  'cancel'. The renderer remembers the choice by writing the setting. */
  promptTerminalLinkOpen(url: string): Promise<'canvas' | 'external' | 'cancel'>

  // ---------------------------------------------------------------------------
  // Recent Projects
  // ---------------------------------------------------------------------------

  /** Get list of recently opened project folders. */
  recentProjectsGet(): Promise<string[]>

  /** Add a project path to the recent projects list. */
  recentProjectsAdd(projectPath: string): Promise<void>

  /** Remove a project path from the recent projects list (issue #220 — forget on close). */
  recentProjectsRemove(projectPath: string): Promise<void>

  /** Get the persisted sidebar arrangement (workspace order + active workspace). */
  sidebarSessionGet(): Promise<SidebarSession | null>

  /** Persist the sidebar arrangement (workspace order + active workspace). */
  sidebarSessionSet(session: SidebarSession): Promise<void>

  /** Get persisted remote-workspace restore entries (cate-companion:// only). */
  remoteProjectsGet(): Promise<RemoteProjectEntry[]>

  /** Persist remote-workspace restore entries (cate-companion:// only). */
  remoteProjectsSet(entries: RemoteProjectEntry[]): Promise<void>

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

  /** Configure the proxy for a browser panel's session partition (issue #241).
   *  Pass an empty/undefined proxyUrl to use a direct connection. */
  browserSetProxy(partition: string, proxyUrl?: string): Promise<void>

  /** Initiate a native OS file drag from the renderer. */
  nativeFileDrag(filePath: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Shell utilities
  // ---------------------------------------------------------------------------

  fsDelete(filePath: string, workspaceId?: string): Promise<void>
  fsRename(oldPath: string, newPath: string, workspaceId?: string): Promise<void>
  fsMkdir(dirPath: string, workspaceId?: string): Promise<void>
  fsCopy(srcPath: string, destDir: string, workspaceId?: string): Promise<string>
  /** Import external files/folders (dragged in from the OS) into `destDir`,
   *  which must resolve inside a workspace root. `mode` is 'copy' or 'move'.
   *  Returns the created destination paths and a count of entries that failed. */
  fsImportEntries(sources: string[], destDir: string, mode: 'copy' | 'move', workspaceId?: string): Promise<{ created: string[]; failed: number }>
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

  /** Minimize the calling window. Used by the custom window controls on the
   *  frameless Windows/Linux chrome. */
  windowMinimize(): Promise<void>

  /** Toggle maximize/restore on the calling window. */
  windowToggleMaximize(): Promise<void>

  /** Close the calling window. */
  windowClose(): Promise<void>

  /** Synchronous cached check: is the calling window maximized? Backs the
   *  maximize/restore glyph swap in the custom window controls. */
  isWindowMaximized(): boolean

  /** Subscribe to the calling window's maximize-state changes. Fires with the
   *  new boolean whenever the window is maximized or restored. */
  onWindowMaximizeChange(callback: (isMaximized: boolean) => void): () => void

  // ---------------------------------------------------------------------------
  // Panel transfer (cross-window)
  // ---------------------------------------------------------------------------

  /** Initiate a cross-window panel transfer. Returns new window ID if a window was created. */
  panelTransfer(snapshot: PanelTransferSnapshot, targetWindowId?: number, workspaceId?: string): Promise<number | void>

  /** Acknowledge receipt of a panel transfer (flushes buffered terminal data). */
  panelTransferAck(ptyId?: string): Promise<void>

  /** Subscribe to incoming panel transfers (main -> renderer). */
  onPanelReceive(callback: (snapshot: PanelTransferSnapshot) => void): () => void

  /** List all active panel windows with their metadata and bounds. */
  panelWindowsList(): Promise<Array<{ windowId: number; panel: PanelState; workspaceId?: string; bounds: { x: number; y: number; width: number; height: number }; terminalPtyId?: string }>>

  /** Report the terminal ptyId for this panel window so the main process can persist it. */
  panelWindowSyncPty(ptyId: string): Promise<void>

  /** Push an updated PanelState snapshot for this panel window so the
   *  main-process windowRegistry meta (used by session persistence and the
   *  panel-window list) reflects post-Save-As filePath/title/dirty state. */
  panelWindowSyncMeta(payload: { panel: PanelState; workspaceId?: string }): Promise<void>

  /** Request this panel window to dock back into the main window. Passing the
   *  panel's full transfer snapshot lets the main window reconstruct the panel
   *  (its record was removed there on detach) and arms the PTY transfer home. */
  panelWindowDockBack(snapshot?: PanelTransferSnapshot): Promise<void>

  /** Subscribe to dock-back requests from panel windows (main -> renderer). The
   *  snapshot carries the panel + canvas/terminal state to re-integrate. */
  onPanelWindowDockBack(callback: (payload: { panelWindowId: number; snapshot?: PanelTransferSnapshot }) => void): () => void

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

  /** Subscribe to drag end events (main -> renderer). The optional `dragId`
   *  identifies which cross-window drag ended; a remote-drag listener ignores
   *  an end whose id doesn't match its own active drag. */
  onDragEnd(callback: (dragId?: string) => void): () => void

  /** Subscribe to native-fullscreen state changes. Fires with the new boolean
   *  whenever any Cate window enters or leaves macOS native fullscreen. */
  onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void

  /** Subscribe to external edits of a project's workspace.json. Fires when the
   *  on-disk file is found to differ from what Cate last wrote (i.e. a reload
   *  should be offered). */
  onWorkspaceExternalEdit(callback: (payload: { rootPath: string }) => void): () => void

  /** Tell main the user declined the reload prompt — resume normal saving so
   *  the current in-app layout overwrites the external edit. */
  dismissWorkspaceExternalEdit(rootPath: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Dock window management
  // ---------------------------------------------------------------------------

  /** Subscribe to dock window initialization (main -> renderer). */
  onDockWindowInit(callback: (payload: DockWindowInitPayload) => void): () => void

  /** Sync dock window state to main process for session persistence. */
  dockWindowSyncState(state: DockStateSnapshot & { panels: Record<string, PanelState>; terminalPtyIds?: Record<string, string>; canvasStates?: Record<string, CanvasLayoutSnapshot> }): Promise<void>

  /** List all dock windows with their state and bounds. */
  dockWindowsList(): Promise<DetachedDockWindowSnapshot[]>

  /** Re-create a detached dock window from its persisted snapshot (full restore:
   *  all top-level tabs, terminal replay, canvas children). Returns the new
   *  window id, or null when restore was refused. */
  dockWindowRestore(payload: DetachedDockWindowSnapshot & { initPayload: DockWindowInitPayload }): Promise<number | null>

  /** Subscribe to a final pre-quit sync request from main (dock windows). */
  onDockWindowFlushSync(callback: () => void): () => void

  /** ACK that this dock window's final pre-quit sync has been sent. */
  dockWindowFlushSyncDone(): void

  // ---------------------------------------------------------------------------
  // Cross-window drag coordination
  // ---------------------------------------------------------------------------

  /** Start a cross-window drag — notifies main to broadcast to other windows. */
  crossWindowDragStart(snapshot: PanelTransferSnapshot, screenPos: Point): Promise<void>

  /** Subscribe to cross-window drag cursor updates (main -> renderer). The
   *  `dragId` identifies the drag session so a window can match a later
   *  targeted DRAG_END against the drag it's tracking. */
  onCrossWindowDragUpdate(callback: (screenPos: Point, snapshot: PanelTransferSnapshot, dragId?: string) => void): () => void

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
  workspaceCreate(options?: { name?: string; rootPath?: string; id?: string; connection?: CompanionConnection }): Promise<WorkspaceMutationResult>

  /** Connect to a remote (SSH) or WSL companion. Returns the locator rootPath +
   *  connection record to create the workspace with. */
  companionConnect(spec: RemoteConnectSpec): Promise<CompanionConnectResult>

  /** Re-establish a connection from a stored connection record (session restore
   *  / reconnect). Auth comes from the encrypted secret store. No-op if already
   *  connected. */
  companionEnsure(connection: CompanionConnection): Promise<CompanionConnectResult>

  /** Ids of currently-connected remote/WSL companions. */
  companionList(): Promise<string[]>

  /** Current connection phase of the built-in LOCAL companion — a seed for the
   *  startup loading blocker, since the local connect can finish (or fail) before
   *  a window subscribes to the COMPANION_STATUS broadcast. */
  companionLocalStatus(): Promise<{ phase: CompanionPhase; message?: string }>

  /** Names of WSL distros installed on this host ([] on non-Windows / no WSL). */
  companionWslDistros(): Promise<string[]>

  /** Connectable host aliases from the user's ~/.ssh/config ([] if none). */
  companionSshHosts(): Promise<SshHostEntry[]>

  /** Explicit clean install of a remote companion's daemon (wipes the host
   *  install dir, re-pulls/pushes the bundle, then connects). The only call that
   *  installs — probes (connect/ensure) never do. */
  companionInstall(connection: CompanionConnection): Promise<CompanionConnectResult>

  /** Literally delete a companion: stop its daemon and rm -rf the host install,
   *  keeping the saved auth. Drops the workspace to `missing`; recover via
   *  Install. */
  companionDelete(connection: CompanionConnection): Promise<{ ok: boolean; error?: string }>

  /** Subscribe to companion connection status (main -> renderer). */
  onCompanionStatus(callback: (event: CompanionStatusEvent) => void): () => void

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

  /** Subscribe to "load this saved layout" dispatches from the native Layouts menu. */
  onMenuLoadLayout(callback: (name: string) => void): () => void

  /** Subscribe to panel-creation actions routed to this (main) window from a
   *  detached dock/panel window, so the new panel lands on the canvas. */
  onMenuCreatePanel(callback: (payload: import('./types').MenuCreatePanelPayload) => void): () => void

  /** Subscribe to browser navigation shortcuts forwarded from a focused webview
   *  guest (Cmd+R/[/]/L) or the Browser menu. */
  onBrowserShortcut(callback: (action: import('./types').BrowserShortcutAction) => void): () => void

  /** Show a native context menu. Returns the clicked item id, or null if dismissed. */
  showContextMenu(items: NativeContextMenuItem[]): Promise<string | null>

  // ---------------------------------------------------------------------------
  // Orchestrator (cate CLI graph sync)
  // ---------------------------------------------------------------------------

  /** Push a (panelId, webContentsId, alive) tuple to main so it can build a
   *  webContents → portal-panel reverse map for popup parent resolution. */
  orchRegisterPortalWc(payload: { panelId: string; webContentsId: number; alive: boolean }): void

  // -------------------------------------------------------------------------
  // Analytics — post-update feedback prompt
  // -------------------------------------------------------------------------

  /** Subscribe to the main-process request to show the feedback modal. */
  onFeedbackPrompt(
    callback: (payload: { fromVersion: string; toVersion: string }) => void,
  ): () => void
  /** Send a feedback submission (1-5 rating + optional comment). Resolves
   *  with `{ ok: true }` on a successful send, `{ ok: true, buffered: true }`
   *  if the request failed but was queued for retry, or `{ ok: false }` on
   *  fatal validation errors. The dialog uses this to show success/retry UX. */
  submitFeedback(payload: { rating: number; comment?: string }): Promise<{ ok: boolean; buffered?: boolean }>
  /** Mark the feedback prompt as dismissed without submitting. */
  dismissFeedback(method: string): void
  /** Track that the user engaged with the feedback modal (first interaction). */
  trackFeedbackEngagement(): void
  /** Pull-based check for pending feedback (renderer calls on mount). */
  getPendingFeedback(): Promise<{ fromVersion: string; toVersion: string } | null>
  /** Track a promo link click (e.g. product_hunt, github_star, newsletter). */
  trackLinkClick(link: string): void
  /** Record the first-run telemetry consent decision. Persists the choice and
   *  releases the deferred crash-reporting + analytics init. */
  setTelemetryConsent(choice: { crashReporting: boolean; usageAnalytics: boolean }): Promise<void>
  /** Report an anonymous feature-usage signal (gated by analytics consent).
   *  `feature` is a short key; `props` are small primitives, clamped in main. */
  trackFeatureUsed(feature: string, props?: Record<string, string | number | boolean>): void
  /** Open an external URL in the user's default browser. */
  openExternalUrl(url: string): void

  // ---------------------------------------------------------------------------
  // Pi agent
  // ---------------------------------------------------------------------------

  /** Create a new agent session bound to a panel. */
  agentCreate(options: AgentCreateOptions): Promise<{ ok: true } | { ok: false; error: string }>

  /** Send a user prompt to the panel's agent. Optional images go alongside as
   *  pi `ImageContent` blocks (base64 + mime). */
  agentPrompt(panelId: string, text: string, images?: AgentImageAttachment[]): Promise<void>

  /** Queue a steering message to deliver after the current assistant turn. */
  agentSteer(panelId: string, text: string, images?: AgentImageAttachment[]): Promise<void>

  /** Queue a follow-up message to deliver after the agent fully completes. */
  agentFollowUp(panelId: string, text: string, images?: AgentImageAttachment[]): Promise<void>

  /** Set the reasoning level (off/minimal/low/medium/high/xhigh). */
  agentSetThinkingLevel(panelId: string, level: AgentThinkingLevel): Promise<void>

  /** Manually compact session context. */
  agentCompact(panelId: string, customInstructions?: string): Promise<unknown>

  /** Enable/disable automatic compaction on context-threshold overflow. */
  agentSetAutoCompaction(panelId: string, enabled: boolean): Promise<void>

  /** Enable/disable automatic retry on transient (overload/5xx) errors. */
  agentSetAutoRetry(panelId: string, enabled: boolean): Promise<void>

  /** Abort an in-progress auto-retry (cancels backoff and stops retrying). */
  agentAbortRetry(panelId: string): Promise<void>

  /** Get token + cost + context-usage stats for the current session. */
  agentGetSessionStats(panelId: string): Promise<AgentSessionStats>

  /** Read the user-defined custom OpenAI-compatible provider config. */
  agentCustomModelsGet(): Promise<CustomOpenAIProvider | null>

  /** Save (or clear, with null) the custom OpenAI-compatible provider config. */
  agentCustomModelsSave(cfg: CustomOpenAIProvider | null): Promise<void>

  /** Get pi's RPC session state snapshot. */
  agentGetState(panelId: string): Promise<AgentRpcState>

  /** Export the current session to an HTML file. */
  agentExportHtml(panelId: string, outputPath?: string): Promise<{ path: string }>

  /** Start a new pi session in the same RPC process. */
  agentNewSession(panelId: string, parentSession?: string): Promise<{ cancelled: boolean }>

  /** Load a different pi session file in the same RPC process. */
  agentSwitchSession(panelId: string, sessionPath: string): Promise<{ cancelled: boolean }>

  /** Fork from a specific prior user message. */
  agentFork(panelId: string, entryId: string): Promise<{ text: string; cancelled: boolean }>

  /** Clone the current active branch into a new session. */
  agentClone(panelId: string): Promise<{ cancelled: boolean }>

  /** Fork-eligible user messages (entryId + text). */
  agentGetForkMessages(panelId: string): Promise<Array<{ entryId: string; text: string }>>

  /** Text of the last assistant message (or null). */
  agentGetLastAssistantText(panelId: string): Promise<string | null>

  /** Set a display name for the current session. */
  agentSetSessionName(panelId: string, name: string): Promise<void>

  /** Get all messages in the current pi session. */
  agentGetMessages(panelId: string): Promise<unknown[]>

  /** Execute a bash command in pi (result is added to the LLM context on the
   *  next prompt). Returns BashResult. */
  agentBash(panelId: string, command: string): Promise<unknown>

  /** Abort a running bash command. */
  agentAbortBash(panelId: string): Promise<void>

  /** Control how steering messages drain. */
  agentSetSteeringMode(panelId: string, mode: 'all' | 'one-at-a-time'): Promise<void>

  /** Control how follow-up messages drain. */
  agentSetFollowUpMode(panelId: string, mode: 'all' | 'one-at-a-time'): Promise<void>

  /** Selectable models, derived session-independently from connected providers
   *  in auth.json + the custom OpenAI endpoint. No agent session required. */
  agentListModels(): Promise<AgentModelDescriptor[]>

  /** Reply to a pending extension UI request (fire-and-forget). */
  agentUiResponse(panelId: string, response: AgentExtensionUIResponse): void

  /** List pi sessions on disk for a given workspace cwd. Newest first. */
  agentListSessions(cwd: string): Promise<AgentSessionListEntry[]>

  /** Load a pi session file from disk and return a renderer-shape transcript. */
  agentLoadSessionMessages(sessionFile: string): Promise<unknown[]>

  /** Delete a pi session file from disk. Refuses paths outside ~/.pi/agent/sessions. */
  agentDeleteSession(sessionFile: string): Promise<void>

  /** Interrupt the running agent (cancels current turn). */
  agentInterrupt(panelId: string): Promise<void>

  /** Dispose the agent session for this panel. */
  agentDispose(panelId: string): Promise<void>

  /** Change the model used by an existing agent session. */
  agentSetModel(panelId: string, model: AgentModelRef): Promise<void>

  /** Available slash commands (skills, prompt templates, extension commands). */
  agentGetCommands(panelId: string): Promise<AgentSlashCommand[]>

  /** Approve or deny a pending tool call. */
  agentToolDecision(panelId: string, toolCallId: string, decision: 'allow' | 'deny', reason?: string): Promise<void>

  /** Open <cwd>/.cate/pi-agent/{agents|prompts} in the OS file manager. */
  agentOpenSkillsFolder(cwd: string, kind: 'agents' | 'prompts' | 'skills'): Promise<void>

  /** Open a single skill/prompt/agent file in the OS default editor. */
  agentOpenSkillFile(filePath: string): Promise<void>

  /** Delete a skill/prompt/agent file. Only allowed under the workspace's pi-agent dir. */
  agentDeleteSkillFile(cwd: string, filePath: string): Promise<void>

  /** Create a new skill/prompt file from a template, then open it. */
  agentCreateSkill(cwd: string, kind: 'agents' | 'prompts' | 'skills', name: string): Promise<string>

  /** List user files under <cwd>/.cate/pi-agent/{agents|prompts}. */
  agentListSkillFiles(cwd: string, kind: 'agents' | 'prompts' | 'skills'): Promise<Array<{ name: string; description?: string; path: string }>>

  /** Browse-able marketplace catalog backed by a live scrape of pi.dev/packages
   *  (~2.9k entries, paginated). Returns an empty list when pi.dev is
   *  unreachable so the UI can render a "Catalog unavailable" state. */
  agentMarketplaceList(params?: {
    page?: number
    query?: string
    sort?: 'downloads' | 'recent' | 'name'
  }): Promise<{
    entries: Array<{
      name: string
      description: string
      author: string
      downloads: number
      type: string
      repoUrl: string
      requiresTerminal: boolean
    }>
    totalPages: number
    page: number
  }>

  /** List extensions currently present in <cwd>/.cate/pi-agent/extensions/. */
  agentMarketplaceListInstalled(cwd: string): Promise<Array<{
    name: string
    description?: string
    requiresTerminal: boolean
    path: string
  }>>

  /** Install an extension via `pi install npm:<name>`. Streams output to the log. */
  agentMarketplaceInstall(cwd: string, name: string): Promise<{ ok: boolean; error?: string }>

  /** Uninstall an extension via `pi remove npm:<name>`. */
  agentMarketplaceUninstall(cwd: string, name: string): Promise<{ ok: boolean; error?: string }>

  // ---------------------------------------------------------------------------
  // Cross-agent skills
  // ---------------------------------------------------------------------------

  /** The merged skill catalog: curated index ∪ live-crawled user repos. */
  skillsGetIndex(): Promise<SkillEntry[]>
  /** Bust the index caches and return the freshly-loaded catalog. */
  skillsRefresh(): Promise<SkillEntry[]>
  /** Fetch a skill's SKILL.md body for the detail preview. */
  skillsGetPreview(entry: SkillEntry): Promise<string>
  /** Install a skill into a workspace agent. Reuses an existing local install of
   *  the same skill, then the saved-library cache, else fetches from GitHub. */
  skillsInstall(entry: SkillEntry, targetId: SkillTargetId, cwd: string): Promise<{ ok: boolean; error?: string; warnings?: string[]; installed?: InstalledSkill }>
  /** Uninstall a skill from a workspace agent. */
  skillsUninstall(skillId: string, name: string, targetId: SkillTargetId, cwd: string): Promise<{ ok: boolean; error?: string }>
  /** Installs recorded in this workspace's .cate/skills.json. */
  skillsListInstalled(cwd: string): Promise<InstalledSkill[]>
  /** Skills saved to the user's Cate library (cached in userData). */
  skillsListSaved(): Promise<SavedSkill[]>
  /** Save a skill to the library: fetch its files + cache them in userData. */
  skillsSave(entry: SkillEntry): Promise<{ ok: boolean; error?: string }>
  /** Remove a skill from the library (drops the cached bytes). */
  skillsUnsave(skillId: string): Promise<{ ok: boolean; error?: string }>
  /** User-added repos crawled in addition to the curated index. */
  skillsListSources(): Promise<SkillSource[]>
  /** Add a repo ("owner/name" or URL) to the live-crawled sources. */
  skillsAddSource(repo: string, opts?: { ref?: string; path?: string }): Promise<{ ok: boolean; error?: string; source?: SkillSource }>
  /** Remove a user-added source. */
  skillsRemoveSource(id: string): Promise<{ ok: boolean }>
  /** Whether a GitHub token is stored (for higher rate limits / private repos). */
  skillsGetToken(): Promise<{ hasToken: boolean }>
  /** Store or clear the GitHub token. */
  skillsSetToken(token: string | null): Promise<{ ok: boolean }>

  /** Stream of agent events forwarded from the main process. */
  onAgentEvent(callback: (envelope: AgentEventEnvelope) => void): () => void

  /** Tool-call approvals requested by the agent. */
  onAgentToolRequest(callback: (req: AgentToolApprovalRequest) => void): () => void

  // ---------------------------------------------------------------------------
  // Pi auth / providers
  // ---------------------------------------------------------------------------

  /** List all known providers (built-in + custom). */
  authListProviders(): Promise<AuthProviderDescriptor[]>

  /** Get current connection status for each provider. */
  authStatus(): Promise<AuthProviderStatus[]>

  /** Begin an OAuth login flow for the given provider. Returns when done or errored. */
  authOAuthStart(providerId: string): Promise<{ ok: true } | { ok: false; error: string }>

  /** Reply to an OAuth interactive prompt (text or selected option id). */
  authOAuthPromptReply(promptId: string, value: string | null): Promise<void>

  /** Subscribe to OAuth flow events for the in-app login UI. */
  onAuthOAuthEvent(callback: (providerId: string, event: OAuthFlowEvent) => void): () => void

  /** Broadcast fired (to every window) after any credential change — OAuth
   *  sign-in, API-key save, or disconnect — once the shared auth.json has been
   *  mirrored into live sessions. Renderers re-fetch provider status + models. */
  onAuthChanged(callback: () => void): () => void

  /** Save an API key for a built-in keyed provider (encrypted via safeStorage). */
  authSaveApiKey(providerId: string, apiKey: string): Promise<void>

  /** Disconnect a provider (clears stored credentials). */
  authDelete(providerId: string): Promise<void>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
