import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  TERMINAL_CREATE,
  TERMINAL_WRITE,
  TERMINAL_RESIZE,
  TERMINAL_KILL,
  TERMINAL_DATA,
  TERMINAL_EXIT,
  TERMINAL_GET_CWD,
  TERMINAL_LOG_READ,
  TERMINAL_LOG_DELETE,
  TERMINAL_SCROLLBACK_SAVE,
  FS_READ_FILE,
  FS_WRITE_FILE,
  FS_READ_DIR,
  FS_WATCH_START,
  FS_WATCH_STOP,
  FS_WATCH_EVENT,
  FS_STAT,
  GIT_IS_REPO,
  GIT_LS_FILES,
  GIT_BRANCH_UPDATE,
  GIT_MONITOR_START,
  GIT_MONITOR_STOP,
  GIT_STATUS,
  GIT_DIFF,
  GIT_STAGE,
  GIT_UNSTAGE,
  GIT_COMMIT,
  GIT_WORKTREE_LIST,
  GIT_PUSH,
  GIT_PULL,
  GIT_FETCH,
  GIT_LOG,
  GIT_BRANCH_LIST,
  GIT_BRANCH_CREATE,
  GIT_BRANCH_DELETE,
  GIT_CHECKOUT,
  GIT_DIFF_STAGED,
  GIT_STASH,
  GIT_STASH_POP,
  GIT_DISCARD_FILE,
  SHELL_REGISTER_TERMINAL,
  SHELL_UNREGISTER_TERMINAL,
  SHELL_ACTIVITY_UPDATE,
  SHELL_PORTS_UPDATE,
  SHELL_CWD_UPDATE,
  SHELL_KILL_PROCESS,
  SETTINGS_GET,
  SETTINGS_SET,
  SETTINGS_GET_ALL,
  SETTINGS_RESET,
  SESSION_SAVE,
  SESSION_LOAD,
  SESSION_CLEAR,
  SESSION_FLUSH_SAVE,
  SESSION_FLUSH_SAVE_DONE,
  APP_GET_PATH,
  APP_OPEN_PATH,
  CRASH_REPORT_SAVE,
  MENU_OPEN_SETTINGS,
  MENU_TRIGGER_ACTION,
  MENU_SHOW_CONTEXT,
  DIALOG_OPEN_FOLDER,
  DIALOG_SAVE_FILE,
  DIALOG_CONFIRM_UNSAVED,
  DIALOG_CONFIRM_CLOSE_CANVAS,
  RECENT_PROJECTS_GET,
  RECENT_PROJECTS_ADD,
  LAYOUT_SAVE,
  LAYOUT_LIST,
  LAYOUT_LOAD,
  LAYOUT_DELETE,
  SHELL_WHICH,
  FS_DELETE,
  FS_RENAME,
  FS_MKDIR,
  FS_SEARCH,
  SHELL_SHOW_IN_FOLDER,
  HTTP_FETCH,
  MCP_SPAWN,
  MCP_STOP,
  MCP_TEST,
  MCP_STATUS_UPDATE,
  NOTIFY_OS,
  NOTIFY_ACTION,
  WINDOW_CREATE,
  WINDOW_GET_ID,
  WINDOW_GET_TYPE,
  WINDOW_SET_TITLE,
  PANEL_TRANSFER,
  PANEL_RECEIVE,
  PANEL_TRANSFER_ACK,
  PANEL_WINDOWS_LIST,
  PANEL_WINDOW_DOCK_BACK,
  PANEL_WINDOW_SYNC_PTY,
  DRAG_START,
  DRAG_DETACH,
  WINDOW_FULLSCREEN_STATE,
  DRAG_END,
  DOCK_WINDOW_INIT,
  DOCK_WINDOW_SYNC_STATE,
  DOCK_WINDOWS_LIST,
  CROSS_WINDOW_DRAG_START,
  CROSS_WINDOW_DRAG_UPDATE,
  CROSS_WINDOW_DRAG_DROP,
  CROSS_WINDOW_DRAG_CANCEL,
  CROSS_WINDOW_DRAG_RESOLVE,
  WORKSPACE_LIST,
  WORKSPACE_CREATE,
  WORKSPACE_UPDATE,
  WORKSPACE_REMOVE,
  WORKSPACE_GET,
  WORKSPACE_CHANGED,
  USAGE_GET_SUMMARY,
  USAGE_GET_PROJECT,
  USAGE_UPDATE,
  WEBVIEW_SCREENSHOT,
  NATIVE_FILE_DRAG,
  CAPTURE_PAGE,
} from '../shared/ipc-channels'

// Cache native-fullscreen state so renderer drag handlers can synchronously
// check it without an IPC round-trip on every mousemove. Main BROADCASTS
// `WINDOW_FULLSCREEN_STATE` whenever any window enters/leaves fullscreen
// (push updates) AND also supports `sendSync` with the same channel as a
// definitive pull — used once per drag start to avoid stale state.
let cachedFullscreen = false
ipcRenderer.on(WINDOW_FULLSCREEN_STATE, (_event, value: boolean) => {
  cachedFullscreen = Boolean(value)
})
function fullscreenLiveCheck(): boolean {
  try {
    const v = ipcRenderer.sendSync(WINDOW_FULLSCREEN_STATE)
    cachedFullscreen = Boolean(v)
    return cachedFullscreen
  } catch {
    return cachedFullscreen
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ---------------------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------------------

  terminalCreate(options: {
    cols: number
    rows: number
    cwd?: string
    shell?: string
  }): Promise<string> {
    return ipcRenderer.invoke(TERMINAL_CREATE, options)
  },

  terminalWrite(terminalId: string, data: string): Promise<void> {
    return ipcRenderer.invoke(TERMINAL_WRITE, terminalId, data)
  },

  terminalResize(terminalId: string, cols: number, rows: number): Promise<void> {
    return ipcRenderer.invoke(TERMINAL_RESIZE, terminalId, cols, rows)
  },

  terminalKill(terminalId: string): Promise<void> {
    return ipcRenderer.invoke(TERMINAL_KILL, terminalId)
  },

  onTerminalData(callback: (terminalId: string, data: string) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalId: string,
      data: string,
    ): void => {
      callback(terminalId, data)
    }
    ipcRenderer.on(TERMINAL_DATA, listener)
    return () => {
      ipcRenderer.removeListener(TERMINAL_DATA, listener)
    }
  },

  terminalGetCwd(ptyId: string): Promise<string | null> {
    return ipcRenderer.invoke(TERMINAL_GET_CWD, ptyId)
  },

  terminalLogRead(terminalId: string): Promise<string | null> {
    return ipcRenderer.invoke(TERMINAL_LOG_READ, terminalId)
  },

  terminalLogDelete(terminalId: string): Promise<void> {
    return ipcRenderer.invoke(TERMINAL_LOG_DELETE, terminalId)
  },

  terminalScrollbackSave(ptyId: string, content: string): Promise<void> {
    return ipcRenderer.invoke(TERMINAL_SCROLLBACK_SAVE, ptyId, content)
  },

  onTerminalExit(callback: (terminalId: string, exitCode: number) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalId: string,
      exitCode: number,
    ): void => {
      callback(terminalId, exitCode)
    }
    ipcRenderer.on(TERMINAL_EXIT, listener)
    return () => {
      ipcRenderer.removeListener(TERMINAL_EXIT, listener)
    }
  },

  // ---------------------------------------------------------------------------
  // Filesystem
  // ---------------------------------------------------------------------------

  fsReadFile(filePath: string): Promise<string> {
    return ipcRenderer.invoke(FS_READ_FILE, filePath)
  },

  fsWriteFile(filePath: string, content: string): Promise<void> {
    return ipcRenderer.invoke(FS_WRITE_FILE, filePath, content)
  },

  fsReadDir(dirPath: string): Promise<unknown[]> {
    return ipcRenderer.invoke(FS_READ_DIR, dirPath)
  },

  fsSearch(rootPath: string, query: string, options?: unknown): Promise<unknown[]> {
    return ipcRenderer.invoke(FS_SEARCH, rootPath, query, options)
  },

  fsWatchStart(dirPath: string): Promise<void> {
    return ipcRenderer.invoke(FS_WATCH_START, dirPath)
  },

  fsWatchStop(dirPath: string): Promise<void> {
    return ipcRenderer.invoke(FS_WATCH_STOP, dirPath)
  },

  fsStat(filePath: string): Promise<{ isDirectory: boolean; isFile: boolean }> {
    return ipcRenderer.invoke(FS_STAT, filePath)
  },

  onFsWatchEvent(
    callback: (event: { type: 'create' | 'update' | 'delete'; path: string }) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      watchEvent: { type: 'create' | 'update' | 'delete'; path: string },
    ): void => {
      callback(watchEvent)
    }
    ipcRenderer.on(FS_WATCH_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(FS_WATCH_EVENT, listener)
    }
  },

  // ---------------------------------------------------------------------------
  // Git
  // ---------------------------------------------------------------------------

  gitIsRepo(dirPath: string): Promise<boolean> {
    return ipcRenderer.invoke(GIT_IS_REPO, dirPath)
  },

  gitLsFiles(dirPath: string): Promise<string[]> {
    return ipcRenderer.invoke(GIT_LS_FILES, dirPath)
  },

  gitStatus(cwd: string): Promise<unknown> {
    return ipcRenderer.invoke(GIT_STATUS, cwd)
  },

  gitDiff(cwd: string, filePath?: string): Promise<string> {
    return ipcRenderer.invoke(GIT_DIFF, cwd, filePath)
  },

  gitStage(cwd: string, filePath: string): Promise<void> {
    return ipcRenderer.invoke(GIT_STAGE, cwd, filePath)
  },

  gitUnstage(cwd: string, filePath: string): Promise<void> {
    return ipcRenderer.invoke(GIT_UNSTAGE, cwd, filePath)
  },

  gitCommit(cwd: string, message: string): Promise<void> {
    return ipcRenderer.invoke(GIT_COMMIT, cwd, message)
  },

  gitWorktreeList(cwd: string): Promise<Array<{ path: string; branch: string; isBare: boolean; isCurrent: boolean }>> {
    return ipcRenderer.invoke(GIT_WORKTREE_LIST, cwd)
  },

  gitPush(cwd: string, remote?: string, branch?: string): Promise<void> {
    return ipcRenderer.invoke(GIT_PUSH, cwd, remote, branch)
  },

  gitPull(cwd: string, remote?: string, branch?: string): Promise<unknown> {
    return ipcRenderer.invoke(GIT_PULL, cwd, remote, branch)
  },

  gitFetch(cwd: string, remote?: string): Promise<void> {
    return ipcRenderer.invoke(GIT_FETCH, cwd, remote)
  },

  gitLog(cwd: string, maxCount?: number): Promise<Array<{ hash: string; message: string; author_name: string; author_email: string; date: string }>> {
    return ipcRenderer.invoke(GIT_LOG, cwd, maxCount)
  },

  gitBranchList(cwd: string): Promise<{ current: string; branches: Array<{ name: string; current: boolean; commit: string; label: string; isRemote: boolean }> }> {
    return ipcRenderer.invoke(GIT_BRANCH_LIST, cwd)
  },

  gitBranchCreate(cwd: string, branchName: string, startPoint?: string): Promise<void> {
    return ipcRenderer.invoke(GIT_BRANCH_CREATE, cwd, branchName, startPoint)
  },

  gitBranchDelete(cwd: string, branchName: string, force?: boolean): Promise<void> {
    return ipcRenderer.invoke(GIT_BRANCH_DELETE, cwd, branchName, force)
  },

  gitCheckout(cwd: string, branchName: string): Promise<void> {
    return ipcRenderer.invoke(GIT_CHECKOUT, cwd, branchName)
  },

  gitDiffStaged(cwd: string, filePath?: string): Promise<string> {
    return ipcRenderer.invoke(GIT_DIFF_STAGED, cwd, filePath)
  },

  gitStash(cwd: string, message?: string): Promise<void> {
    return ipcRenderer.invoke(GIT_STASH, cwd, message)
  },

  gitStashPop(cwd: string): Promise<void> {
    return ipcRenderer.invoke(GIT_STASH_POP, cwd)
  },

  gitDiscardFile(cwd: string, filePath: string): Promise<void> {
    return ipcRenderer.invoke(GIT_DISCARD_FILE, cwd, filePath)
  },

  // ---------------------------------------------------------------------------
  // Shell / Process Monitor
  // ---------------------------------------------------------------------------

  shellRegisterTerminal(terminalId: string, pid?: number): Promise<void> {
    return ipcRenderer.invoke(SHELL_REGISTER_TERMINAL, terminalId, pid)
  },

  shellUnregisterTerminal(terminalId: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_UNREGISTER_TERMINAL, terminalId)
  },

  shellKillProcess(terminalId: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_KILL_PROCESS, terminalId)
  },

  onShellActivityUpdate(
    callback: (terminalId: string, activity: unknown, agentState: unknown, agentName: unknown) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalId: string,
      activity: unknown,
      agentState: unknown,
      agentName: unknown,
    ): void => {
      callback(terminalId, activity, agentState, agentName)
    }
    ipcRenderer.on(SHELL_ACTIVITY_UPDATE, listener)
    return () => {
      ipcRenderer.removeListener(SHELL_ACTIVITY_UPDATE, listener)
    }
  },

  onShellPortsUpdate(callback: (terminalId: string, ports: number[]) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalId: string,
      ports: number[],
    ): void => {
      callback(terminalId, ports)
    }
    ipcRenderer.on(SHELL_PORTS_UPDATE, listener)
    return () => {
      ipcRenderer.removeListener(SHELL_PORTS_UPDATE, listener)
    }
  },

  onShellCwdUpdate(callback: (terminalId: string, cwd: string) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalId: string,
      cwd: string,
    ): void => {
      callback(terminalId, cwd)
    }
    ipcRenderer.on(SHELL_CWD_UPDATE, listener)
    return () => {
      ipcRenderer.removeListener(SHELL_CWD_UPDATE, listener)
    }
  },

  onGitBranchUpdate(
    callback: (workspaceId: string, branch: string, isDirty: boolean) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      workspaceId: string,
      branch: string,
      isDirty: boolean,
    ): void => {
      callback(workspaceId, branch, isDirty)
    }
    ipcRenderer.on(GIT_BRANCH_UPDATE, listener)
    return () => {
      ipcRenderer.removeListener(GIT_BRANCH_UPDATE, listener)
    }
  },

  gitMonitorStart(workspaceId: string, rootPath: string): void {
    ipcRenderer.send(GIT_MONITOR_START, workspaceId, rootPath)
  },

  gitMonitorStop(workspaceId: string): void {
    ipcRenderer.send(GIT_MONITOR_STOP, workspaceId)
  },

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  settingsGet(key: string): Promise<unknown> {
    return ipcRenderer.invoke(SETTINGS_GET, key)
  },

  settingsSet(key: string, value: unknown): Promise<void> {
    return ipcRenderer.invoke(SETTINGS_SET, key, value)
  },

  settingsGetAll(): Promise<unknown> {
    return ipcRenderer.invoke(SETTINGS_GET_ALL)
  },

  settingsReset(key?: string): Promise<void> {
    return ipcRenderer.invoke(SETTINGS_RESET, key)
  },

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  sessionSave(snapshot: unknown): Promise<void> {
    return ipcRenderer.invoke(SESSION_SAVE, snapshot)
  },

  sessionLoad(): Promise<unknown> {
    return ipcRenderer.invoke(SESSION_LOAD)
  },

  sessionClear(): Promise<void> {
    return ipcRenderer.invoke(SESSION_CLEAR)
  },

  onSessionFlushSave(callback: () => void): () => void {
    const handler = () => callback()
    ipcRenderer.on(SESSION_FLUSH_SAVE, handler)
    return () => ipcRenderer.removeListener(SESSION_FLUSH_SAVE, handler)
  },

  sessionFlushSaveDone(): void {
    ipcRenderer.send(SESSION_FLUSH_SAVE_DONE)
  },

  // ---------------------------------------------------------------------------
  // App
  // ---------------------------------------------------------------------------

  appGetPath(name: string): Promise<string> {
    return ipcRenderer.invoke(APP_GET_PATH, name)
  },

  onOpenPath(callback: (filePath: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, filePath: string): void => {
      callback(filePath)
    }
    ipcRenderer.on(APP_OPEN_PATH, listener)
    return () => { ipcRenderer.removeListener(APP_OPEN_PATH, listener) }
  },

  // ---------------------------------------------------------------------------
  // Crash reporting
  // ---------------------------------------------------------------------------

  /** Save a crash report from the renderer process (shown on next launch). */
  crashReportSave(error: { name?: string; message: string; stack?: string }): Promise<void> {
    return ipcRenderer.invoke(CRASH_REPORT_SAVE, error)
  },

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------

  openFolderDialog(): Promise<string | null> {
    return ipcRenderer.invoke(DIALOG_OPEN_FOLDER)
  },

  saveFileDialog(options: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null> {
    return ipcRenderer.invoke(DIALOG_SAVE_FILE, options)
  },

  confirmUnsavedChanges(payload: { fileName?: string; multiple?: boolean }): Promise<'save' | 'discard' | 'cancel'> {
    return ipcRenderer.invoke(DIALOG_CONFIRM_UNSAVED, payload)
  },

  confirmCloseCanvas(payload: { panelCount: number; isLast: boolean }): Promise<'move' | 'delete' | 'close' | 'cancel'> {
    return ipcRenderer.invoke(DIALOG_CONFIRM_CLOSE_CANVAS, payload)
  },

  // ---------------------------------------------------------------------------
  // Recent Projects
  // ---------------------------------------------------------------------------

  recentProjectsGet(): Promise<string[]> {
    return ipcRenderer.invoke(RECENT_PROJECTS_GET)
  },

  recentProjectsAdd(projectPath: string): Promise<void> {
    return ipcRenderer.invoke(RECENT_PROJECTS_ADD, projectPath)
  },

  // ---------------------------------------------------------------------------
  // Layouts
  // ---------------------------------------------------------------------------

  layoutSave(name: string, layout: unknown): Promise<void> {
    return ipcRenderer.invoke(LAYOUT_SAVE, name, layout)
  },

  layoutList(): Promise<string[]> {
    return ipcRenderer.invoke(LAYOUT_LIST)
  },

  layoutLoad(name: string): Promise<unknown> {
    return ipcRenderer.invoke(LAYOUT_LOAD, name)
  },

  layoutDelete(name: string): Promise<void> {
    return ipcRenderer.invoke(LAYOUT_DELETE, name)
  },

  capturePage(): Promise<string | null> {
    return ipcRenderer.invoke(CAPTURE_PAGE)
  },

  webviewScreenshot(webContentsId: number): Promise<{ filePath: string; dataUrl: string } | null> {
    return ipcRenderer.invoke(WEBVIEW_SCREENSHOT, webContentsId)
  },

  nativeFileDrag(filePath: string): Promise<void> {
    return ipcRenderer.invoke(NATIVE_FILE_DRAG, filePath)
  },

  // ---------------------------------------------------------------------------
  // Shell utilities
  // ---------------------------------------------------------------------------

  shellWhich(command: string): Promise<string | null> {
    return ipcRenderer.invoke(SHELL_WHICH, command)
  },

  fsDelete(filePath: string): Promise<void> {
    return ipcRenderer.invoke(FS_DELETE, filePath)
  },

  fsRename(oldPath: string, newPath: string): Promise<void> {
    return ipcRenderer.invoke(FS_RENAME, oldPath, newPath)
  },

  fsMkdir(dirPath: string): Promise<void> {
    return ipcRenderer.invoke(FS_MKDIR, dirPath)
  },

  shellShowInFolder(filePath: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_SHOW_IN_FOLDER, filePath)
  },

  httpFetch(url: string): Promise<{ ok: boolean; status: number; text: string }> {
    return ipcRenderer.invoke(HTTP_FETCH, url)
  },

  // ---------------------------------------------------------------------------
  // MCP Server Management
  // ---------------------------------------------------------------------------

  mcpSpawn(name: string, command: string, args: string[], env: Record<string, string>): Promise<void> {
    return ipcRenderer.invoke(MCP_SPAWN, name, command, args, env)
  },

  mcpStop(name: string): Promise<void> {
    return ipcRenderer.invoke(MCP_STOP, name)
  },

  mcpTest(command: string, args: string[], env: Record<string, string>) {
    return ipcRenderer.invoke(MCP_TEST, command, args, env)
  },

  onMcpStatusUpdate(callback: (update: { name: string; status: string; error?: string }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, update: { name: string; status: string; error?: string }): void => {
      callback(update)
    }
    ipcRenderer.on(MCP_STATUS_UPDATE, listener)
    return () => { ipcRenderer.removeListener(MCP_STATUS_UPDATE, listener) }
  },

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  notifyOS(payload: { title: string; body: string; action?: unknown }): Promise<void> {
    return ipcRenderer.invoke(NOTIFY_OS, payload)
  },

  onNotifyAction(callback: (action: unknown) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, action: unknown): void => {
      callback(action)
    }
    ipcRenderer.on(NOTIFY_ACTION, listener)
    return () => { ipcRenderer.removeListener(NOTIFY_ACTION, listener) }
  },

  // ---------------------------------------------------------------------------
  // Window management
  // ---------------------------------------------------------------------------

  windowCreate(params?: unknown): Promise<number> {
    return ipcRenderer.invoke(WINDOW_CREATE, params)
  },

  windowGetId(): Promise<number | null> {
    return ipcRenderer.invoke(WINDOW_GET_ID)
  },

  windowGetType(): Promise<string> {
    return ipcRenderer.invoke(WINDOW_GET_TYPE)
  },

  windowSetTitle(title: string): Promise<void> {
    return ipcRenderer.invoke(WINDOW_SET_TITLE, title)
  },

  // ---------------------------------------------------------------------------
  // Panel transfer (cross-window)
  // ---------------------------------------------------------------------------

  panelTransfer(snapshot: unknown, targetWindowId?: number): Promise<number | void> {
    return ipcRenderer.invoke(PANEL_TRANSFER, snapshot, targetWindowId)
  },

  panelTransferAck(ptyId?: string): Promise<void> {
    return ipcRenderer.invoke(PANEL_TRANSFER_ACK, ptyId)
  },

  onPanelReceive(callback: (snapshot: unknown) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown): void => {
      callback(snapshot)
    }
    ipcRenderer.on(PANEL_RECEIVE, listener)
    return () => { ipcRenderer.removeListener(PANEL_RECEIVE, listener) }
  },

  panelWindowsList(): Promise<unknown[]> {
    return ipcRenderer.invoke(PANEL_WINDOWS_LIST)
  },

  panelWindowSyncPty(ptyId: string): Promise<void> {
    return ipcRenderer.invoke(PANEL_WINDOW_SYNC_PTY, ptyId)
  },

  panelWindowDockBack(): Promise<void> {
    return ipcRenderer.invoke(PANEL_WINDOW_DOCK_BACK)
  },

  onPanelWindowDockBack(callback: (panelWindowId: number) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, panelWindowId: number): void => {
      callback(panelWindowId)
    }
    ipcRenderer.on(PANEL_WINDOW_DOCK_BACK, listener)
    return () => { ipcRenderer.removeListener(PANEL_WINDOW_DOCK_BACK, listener) }
  },

  // ---------------------------------------------------------------------------
  // Cross-window drag-and-drop
  // ---------------------------------------------------------------------------

  dragStart(snapshot: unknown): Promise<void> {
    return ipcRenderer.invoke(DRAG_START, snapshot)
  },

  dragDetach(snapshot: unknown, workspaceId?: string): Promise<number | null> {
    return ipcRenderer.invoke(DRAG_DETACH, snapshot, workspaceId)
  },

  /** Synchronous check: is any Cate BrowserWindow currently in macOS
   *  native fullscreen? Uses the cached push value when available and
   *  falls back to a sync IPC for the authoritative answer. Drag handlers
   *  call this on every mousemove — that's fine at ~60 Hz. */
  isMainWindowFullscreen(): boolean {
    return fullscreenLiveCheck()
  },

  /** Subscribe to fullscreen state changes. Fires whenever any Cate window
   *  enters or leaves macOS native fullscreen. */
  onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, value: boolean): void => {
      callback(Boolean(value))
    }
    ipcRenderer.on(WINDOW_FULLSCREEN_STATE, listener)
    return () => { ipcRenderer.removeListener(WINDOW_FULLSCREEN_STATE, listener) }
  },

  onDragEnd(callback: () => void): () => void {
    const listener = (): void => { callback() }
    ipcRenderer.on(DRAG_END, listener)
    return () => { ipcRenderer.removeListener(DRAG_END, listener) }
  },

  // ---------------------------------------------------------------------------
  // Dock window management
  // ---------------------------------------------------------------------------

  onDockWindowInit(callback: (payload: unknown) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      callback(payload)
    }
    ipcRenderer.on(DOCK_WINDOW_INIT, listener)
    return () => { ipcRenderer.removeListener(DOCK_WINDOW_INIT, listener) }
  },

  dockWindowSyncState(state: unknown): Promise<void> {
    return ipcRenderer.invoke(DOCK_WINDOW_SYNC_STATE, state)
  },

  dockWindowsList(): Promise<unknown[]> {
    return ipcRenderer.invoke(DOCK_WINDOWS_LIST)
  },

  // ---------------------------------------------------------------------------
  // Cross-window drag coordination
  // ---------------------------------------------------------------------------

  crossWindowDragStart(snapshot: unknown, screenPos: unknown): Promise<void> {
    return ipcRenderer.invoke(CROSS_WINDOW_DRAG_START, snapshot, screenPos)
  },

  onCrossWindowDragUpdate(callback: (screenPos: unknown, snapshot: unknown) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, screenPos: unknown, snapshot: unknown): void => {
      callback(screenPos, snapshot)
    }
    ipcRenderer.on(CROSS_WINDOW_DRAG_UPDATE, listener)
    return () => { ipcRenderer.removeListener(CROSS_WINDOW_DRAG_UPDATE, listener) }
  },

  crossWindowDragDrop(panelId: string): Promise<void> {
    return ipcRenderer.invoke(CROSS_WINDOW_DRAG_DROP, panelId)
  },

  crossWindowDragCancel(): Promise<void> {
    return ipcRenderer.invoke(CROSS_WINDOW_DRAG_CANCEL)
  },

  crossWindowDragResolve(): Promise<{ claimed: boolean }> {
    return ipcRenderer.invoke(CROSS_WINDOW_DRAG_RESOLVE)
  },

  // ---------------------------------------------------------------------------
  // Workspace management (main process is source of truth)
  // ---------------------------------------------------------------------------

  workspaceList(): Promise<unknown[]> {
    return ipcRenderer.invoke(WORKSPACE_LIST)
  },

  workspaceCreate(options?: { name?: string; rootPath?: string; id?: string }): Promise<unknown> {
    return ipcRenderer.invoke(WORKSPACE_CREATE, options)
  },

  workspaceUpdate(id: string, changes: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke(WORKSPACE_UPDATE, id, changes)
  },

  workspaceRemove(id: string): Promise<boolean> {
    return ipcRenderer.invoke(WORKSPACE_REMOVE, id)
  },

  workspaceGet(id: string): Promise<unknown> {
    return ipcRenderer.invoke(WORKSPACE_GET, id)
  },

  onWorkspaceChanged(callback: (workspaces: unknown[], originWindowId: number | null) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      workspaces: unknown[],
      originWindowId: number | null,
    ): void => {
      callback(workspaces, originWindowId)
    }
    ipcRenderer.on(WORKSPACE_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(WORKSPACE_CHANGED, listener)
    }
  },

  // ---------------------------------------------------------------------------
  // File drag-and-drop helpers
  // ---------------------------------------------------------------------------

  /** Get the absolute file path for a File object from an OS drag-and-drop. */
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },

  // ---------------------------------------------------------------------------
  // Menu actions (main -> renderer)
  // ---------------------------------------------------------------------------

  showContextMenu(items: unknown): Promise<string | null> {
    return ipcRenderer.invoke(MENU_SHOW_CONTEXT, items)
  },

  onMenuOpenSettings(callback: () => void): () => void {
    const listener = (): void => { callback() }
    ipcRenderer.on(MENU_OPEN_SETTINGS, listener)
    return () => { ipcRenderer.removeListener(MENU_OPEN_SETTINGS, listener) }
  },

  onMenuTriggerAction(callback: (action: string) => void): () => void {
    const listener = (_e: unknown, action: string): void => { callback(action) }
    ipcRenderer.on(MENU_TRIGGER_ACTION, listener)
    return () => { ipcRenderer.removeListener(MENU_TRIGGER_ACTION, listener) }
  },

  // ---------------------------------------------------------------------------
  // Token usage tracking
  // ---------------------------------------------------------------------------

  usageGetSummary(): Promise<unknown> {
    return ipcRenderer.invoke(USAGE_GET_SUMMARY)
  },

  usageGetProject(projectPath: string): Promise<unknown> {
    return ipcRenderer.invoke(USAGE_GET_PROJECT, projectPath)
  },

  onUsageUpdate(callback: (changedProjects: string[]) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { changedProjects: string[] },
    ): void => {
      callback(payload.changedProjects)
    }
    ipcRenderer.on(USAGE_UPDATE, listener)
    return () => { ipcRenderer.removeListener(USAGE_UPDATE, listener) }
  },
})
