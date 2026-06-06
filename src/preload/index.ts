import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Phase 0 perf marker — capture preload entry as early as possible.
try { performance.mark('preload-start') } catch { /* noop */ }

import {
  TERMINAL_CREATE,
  TERMINAL_WRITE,
  TERMINAL_RESIZE,
  TERMINAL_KILL,
  TERMINAL_DATA,
  TERMINAL_EXIT,
  TERMINAL_GET_CWD,
  TERMINAL_LOG_READ,
  TERMINAL_SCROLLBACK_SAVE,
  TERMINAL_SET_VISIBILITY,
  FS_READ_FILE,
  FS_READ_BINARY,
  FS_WRITE_FILE,
  FS_READ_DIR,
  FS_WATCH_START,
  FS_WATCH_STOP,
  FS_WATCH_EVENT,
  FS_STAT,
  GIT_IS_REPO,
  GIT_INIT,
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
  GIT_WORKTREE_ADD,
  GIT_WORKTREE_REMOVE,
  GIT_WORKTREE_PRUNE,
  GIT_WORKTREE_STATUS,
  GIT_WORKTREE_MERGE_TO,
  GIT_WORKTREE_ADD_FROM_PR,
  GIT_WORKTREE_UPDATE_FROM,
  GIT_CREATE_PR,
  GIT_PR_STATUS,
  GIT_PR_LIST,
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
  SHELL_AGENT_SCREEN_STATE,
  SETTINGS_GET,
  SETTINGS_SET,
  SETTINGS_GET_ALL,
  SETTINGS_RESET,
  SETTINGS_CHANGED,
  SETTINGS_OPEN_IN_EDITOR,
  SETTINGS_RELOADED,
  UI_STATE_GET_ALL,
  UI_STATE_SET,
  SESSION_FLUSH_SAVE,
  SESSION_FLUSH_SAVE_DONE,
  PROJECT_STATE_SAVE,
  PROJECT_STATE_LOAD,
  WORKSPACE_EXTERNAL_EDIT,
  WORKSPACE_EXTERNAL_EDIT_DISMISS,
  BOOT_SNAPSHOT_WRITE,
  APP_OPEN_PATH,
  MENU_OPEN_SETTINGS,
  MENU_TRIGGER_ACTION,
  MENU_LOAD_LAYOUT,
  MENU_CREATE_PANEL,
  BROWSER_SHORTCUT,
  MENU_SHOW_CONTEXT,
  DIALOG_OPEN_FOLDER,
  DIALOG_OPEN_IMAGE,
  CANVAS_READ_BACKGROUND_IMAGE,
  DIALOG_SAVE_FILE,
  DIALOG_CONFIRM_UNSAVED,
  DIALOG_CONFIRM_CLOSE_TERMINAL,
  DIALOG_CONFIRM_CLOSE_CANVAS,
  DIALOG_CONFIRM_RELOAD_WORKSPACE,
  DIALOG_CONFIRM_IMPORT,
  DIALOG_TERMINAL_LINK_OPEN,
  RECENT_PROJECTS_GET,
  RECENT_PROJECTS_ADD,
  RECENT_PROJECTS_REMOVE,
  SIDEBAR_SESSION_GET,
  SIDEBAR_SESSION_SET,
  REMOTE_PROJECTS_GET,
  REMOTE_PROJECTS_SET,
  LAYOUT_SAVE,
  LAYOUT_LIST,
  LAYOUT_LOAD,
  LAYOUT_DELETE,
  FS_DELETE,
  FS_RENAME,
  FS_MKDIR,
  FS_COPY,
  FS_IMPORT_ENTRIES,
  FS_SEARCH,
  SEARCH_START,
  SEARCH_CANCEL,
  SEARCH_RESULT,
  SEARCH_DONE,
  SHELL_SHOW_IN_FOLDER,
  NOTIFY_OS,
  NOTIFY_ACTION,
  WINDOW_SET_TITLE,
  PANEL_TRANSFER,
  PANEL_RECEIVE,
  PANEL_TRANSFER_ACK,
  PANEL_WINDOWS_LIST,
  PANEL_WINDOW_DOCK_BACK,
  PANEL_WINDOW_SYNC_PTY,
  PANEL_WINDOW_SYNC_META,
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
  WORKSPACE_CREATE,
  WORKSPACE_UPDATE,
  WORKSPACE_REMOVE,
  WORKSPACE_CHANGED,
  COMPANION_CONNECT,
  COMPANION_ENSURE,
  COMPANION_LIST,
  COMPANION_WSL_DISTROS,
  COMPANION_SSH_HOSTS,
  COMPANION_DELETE,
  COMPANION_INSTALL,
  COMPANION_STATUS,
  COMPANION_LOCAL_STATUS,
  WEBVIEW_SCREENSHOT,
  BROWSER_SET_PROXY,
  NATIVE_FILE_DRAG,
  CAPTURE_PAGE,
  UPDATE_STATUS,
  UPDATE_INSTALL,
  UPDATE_DOWNLOAD,
  UPDATE_OPEN_RELEASE,
  ANALYTICS_FEEDBACK_PROMPT,
  ANALYTICS_FEEDBACK_SUBMIT,
  ANALYTICS_FEEDBACK_DISMISS,
  ANALYTICS_FEEDBACK_ENGAGED,
  ANALYTICS_FEEDBACK_GET_PENDING,
  ANALYTICS_LINK_CLICK,
  ANALYTICS_TRACK_USAGE,
  TELEMETRY_SET_CONSENT,
  OPEN_EXTERNAL_URL,
  AGENT_CREATE,
  AGENT_PROMPT,
  AGENT_INTERRUPT,
  AGENT_DISPOSE,
  AGENT_SET_MODEL,
  AGENT_GET_COMMANDS,
  AGENT_TOOL_DECISION,
  AGENT_EVENT,
  AGENT_TOOL_REQUEST,
  AGENT_OPEN_SKILLS_FOLDER,
  AGENT_OPEN_SKILL_FILE,
  AGENT_DELETE_SKILL_FILE,
  AGENT_CREATE_SKILL,
  AGENT_LIST_SKILL_FILES,
  AGENT_STEER,
  AGENT_FOLLOW_UP,
  AGENT_SET_THINKING_LEVEL,
  AGENT_COMPACT,
  AGENT_SET_AUTO_COMPACTION,
  AGENT_SET_AUTO_RETRY,
  AGENT_ABORT_RETRY,
  AGENT_GET_SESSION_STATS,
  AGENT_GET_STATE,
  AGENT_EXPORT_HTML,
  AGENT_NEW_SESSION,
  AGENT_SWITCH_SESSION,
  AGENT_FORK,
  AGENT_CLONE,
  AGENT_GET_FORK_MESSAGES,
  AGENT_GET_LAST_ASSISTANT_TEXT,
  AGENT_SET_SESSION_NAME,
  AGENT_GET_MESSAGES,
  AGENT_BASH,
  AGENT_ABORT_BASH,
  AGENT_SET_STEERING_MODE,
  AGENT_SET_FOLLOW_UP_MODE,
  AGENT_GET_AVAILABLE_MODELS,
  AGENT_UI_RESPONSE,
  AGENT_LIST_SESSIONS,
  AGENT_LOAD_SESSION_MESSAGES,
  AGENT_DELETE_SESSION,
  AGENT_MARKETPLACE_LIST,
  AGENT_MARKETPLACE_LIST_INSTALLED,
  AGENT_MARKETPLACE_INSTALL,
  AGENT_MARKETPLACE_UNINSTALL,
  AGENT_CUSTOM_MODELS_GET,
  AGENT_CUSTOM_MODELS_SAVE,
  AUTH_LIST_PROVIDERS,
  AUTH_STATUS,
  AUTH_OAUTH_START,
  AUTH_OAUTH_PROMPT_REPLY,
  AUTH_OAUTH_EVENT,
  AUTH_SAVE_API_KEY,
  AUTH_DELETE,
  PERF_GET,
} from '../shared/ipc-channels'
import type { AppSettings, SidebarSession, SearchOptions, SearchResultBatch, SearchDoneEvent } from '../shared/types'

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
  isE2E: process.env.CATE_E2E === '1',
  isPerf: process.env.CATE_PERF === '1',

  /** Pull the latest main-process resource snapshot (null until first sample). */
  perfGetSnapshot(): Promise<unknown> {
    return ipcRenderer.invoke(PERF_GET)
  },
  // ---------------------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------------------

  terminalCreate(options: {
    cols: number
    rows: number
    cwd?: string
    shell?: string
    workspaceId?: string
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

  terminalScrollbackSave(ptyId: string, content: string): Promise<void> {
    return ipcRenderer.invoke(TERMINAL_SCROLLBACK_SAVE, ptyId, content)
  },

  terminalSetVisibility(terminalId: string, visible: boolean): Promise<void> {
    return ipcRenderer.invoke(TERMINAL_SET_VISIBILITY, terminalId, visible)
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

  fsReadFile(filePath: string, workspaceId?: string): Promise<string> {
    return ipcRenderer.invoke(FS_READ_FILE, filePath, workspaceId)
  },

  fsReadBinary(filePath: string, workspaceId?: string): Promise<ArrayBuffer> {
    return ipcRenderer.invoke(FS_READ_BINARY, filePath, workspaceId)
  },

  fsWriteFile(filePath: string, content: string, workspaceId?: string): Promise<void> {
    return ipcRenderer.invoke(FS_WRITE_FILE, filePath, content, workspaceId)
  },

  fsReadDir(dirPath: string, workspaceId?: string): Promise<unknown[]> {
    return ipcRenderer.invoke(FS_READ_DIR, dirPath, workspaceId)
  },

  fsSearch(rootPath: string, query: string, options?: unknown, workspaceId?: string): Promise<unknown[]> {
    return ipcRenderer.invoke(FS_SEARCH, rootPath, query, options, workspaceId)
  },

  fsWatchStart(dirPath: string, workspaceId?: string): Promise<void> {
    return ipcRenderer.invoke(FS_WATCH_START, dirPath, workspaceId)
  },

  fsWatchStop(dirPath: string, workspaceId?: string): Promise<void> {
    return ipcRenderer.invoke(FS_WATCH_STOP, dirPath, workspaceId)
  },

  fsStat(filePath: string, workspaceId?: string): Promise<{ isDirectory: boolean; isFile: boolean }> {
    return ipcRenderer.invoke(FS_STAT, filePath, workspaceId)
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
  // Content search (ripgrep-backed Search view)
  // ---------------------------------------------------------------------------

  searchStart(rootPath: string, searchId: string, options: SearchOptions, workspaceId?: string): Promise<string> {
    return ipcRenderer.invoke(SEARCH_START, rootPath, searchId, options, workspaceId)
  },

  searchCancel(): Promise<void> {
    return ipcRenderer.invoke(SEARCH_CANCEL)
  },

  onSearchResult(callback: (batch: SearchResultBatch) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, batch: SearchResultBatch): void => {
      callback(batch)
    }
    ipcRenderer.on(SEARCH_RESULT, listener)
    return () => {
      ipcRenderer.removeListener(SEARCH_RESULT, listener)
    }
  },

  onSearchDone(callback: (event: SearchDoneEvent) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, done: SearchDoneEvent): void => {
      callback(done)
    }
    ipcRenderer.on(SEARCH_DONE, listener)
    return () => {
      ipcRenderer.removeListener(SEARCH_DONE, listener)
    }
  },

  // ---------------------------------------------------------------------------
  // Git
  // ---------------------------------------------------------------------------

  gitIsRepo(dirPath: string): Promise<boolean> {
    return ipcRenderer.invoke(GIT_IS_REPO, dirPath)
  },

  gitInit(dirPath: string): Promise<void> {
    return ipcRenderer.invoke(GIT_INIT, dirPath)
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

  gitWorktreeAdd(
    repoCwd: string,
    branch: string,
    targetPath: string,
    options?: { createBranch?: boolean; baseRef?: string },
  ): Promise<{ path: string; branch: string }> {
    return ipcRenderer.invoke(GIT_WORKTREE_ADD, repoCwd, branch, targetPath, options)
  },

  gitWorktreeRemove(repoCwd: string, worktreePath: string, options?: { force?: boolean }): Promise<void> {
    return ipcRenderer.invoke(GIT_WORKTREE_REMOVE, repoCwd, worktreePath, options)
  },

  gitWorktreePrune(repoCwd: string): Promise<{ output: string }> {
    return ipcRenderer.invoke(GIT_WORKTREE_PRUNE, repoCwd)
  },

  gitWorktreeStatus(worktreePath: string): Promise<{
    branch: string
    dirty: boolean
    ahead: number
    behind: number
    staged: number
    unstaged: number
    untracked: number
  } | null> {
    return ipcRenderer.invoke(GIT_WORKTREE_STATUS, worktreePath)
  },

  gitWorktreeMergeTo(
    repoCwd: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<{ ok: true; result: unknown } | { ok: false; conflict: boolean; message: string }> {
    return ipcRenderer.invoke(GIT_WORKTREE_MERGE_TO, repoCwd, fromBranch, toBranch)
  },

  gitWorktreeUpdateFrom(
    worktreePath: string,
    fromBranch: string,
  ): Promise<{ ok: true; result: unknown } | { ok: false; conflict: boolean; message: string }> {
    return ipcRenderer.invoke(GIT_WORKTREE_UPDATE_FROM, worktreePath, fromBranch)
  },

  gitWorktreeAddFromPr(
    repoCwd: string,
    prNumber: number,
    targetPath: string,
  ): Promise<{ path: string; branch: string }> {
    return ipcRenderer.invoke(GIT_WORKTREE_ADD_FROM_PR, repoCwd, prNumber, targetPath)
  },

  gitPrList(
    repoCwd: string,
  ): Promise<Array<{ number: number; title: string; headRefName: string; author: string; isFork: boolean }>> {
    return ipcRenderer.invoke(GIT_PR_LIST, repoCwd)
  },

  gitCreatePR(
    worktreePath: string,
    branch: string,
  ): Promise<
    | { ok: true; created: boolean; url: string; fallback?: boolean }
    | { ok: false; message: string }
  > {
    return ipcRenderer.invoke(GIT_CREATE_PR, worktreePath, branch)
  },

  gitPrStatus(
    worktreePath: string,
    branch: string,
  ): Promise<{ number: number; state: string; url: string; isDraft: boolean } | null> {
    return ipcRenderer.invoke(GIT_PR_STATUS, worktreePath, branch)
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

  onShellActivityUpdate(
    callback: (
      terminalId: string,
      activity: unknown,
      agentName: unknown,
      agentPresent: unknown,
    ) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalId: string,
      activity: unknown,
      agentName: unknown,
      agentPresent: unknown,
    ): void => {
      callback(terminalId, activity, agentName, agentPresent)
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

  shellReportAgentScreenState(terminalId: string, state: string): void {
    ipcRenderer.send(SHELL_AGENT_SCREEN_STATE, terminalId, state)
  },

  onAgentScreenStateUpdate(
    callback: (terminalId: string, state: string) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalId: string,
      state: string,
    ): void => {
      callback(terminalId, state)
    }
    ipcRenderer.on(SHELL_AGENT_SCREEN_STATE, listener)
    return () => {
      ipcRenderer.removeListener(SHELL_AGENT_SCREEN_STATE, listener)
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

  uiStateGetAll(): Promise<unknown> {
    return ipcRenderer.invoke(UI_STATE_GET_ALL)
  },

  uiStateSet(key: string, value: unknown): Promise<void> {
    return ipcRenderer.invoke(UI_STATE_SET, key, value)
  },

  onSettingsChanged(callback: (key: keyof AppSettings, value: unknown) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, key: keyof AppSettings, value: unknown): void => {
      callback(key, value)
    }
    ipcRenderer.on(SETTINGS_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(SETTINGS_CHANGED, listener)
    }
  },

  settingsOpenInEditor(): Promise<string> {
    return ipcRenderer.invoke(SETTINGS_OPEN_IN_EDITOR)
  },

  onSettingsReloaded(callback: (settings: AppSettings) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, settings: AppSettings): void => {
      callback(settings)
    }
    ipcRenderer.on(SETTINGS_RELOADED, listener)
    return () => {
      ipcRenderer.removeListener(SETTINGS_RELOADED, listener)
    }
  },

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------


  onSessionFlushSave(callback: () => void): () => void {
    const handler = () => callback()
    ipcRenderer.on(SESSION_FLUSH_SAVE, handler)
    return () => ipcRenderer.removeListener(SESSION_FLUSH_SAVE, handler)
  },

  sessionFlushSaveDone(): void {
    ipcRenderer.send(SESSION_FLUSH_SAVE_DONE)
  },

  projectStateSave(rootPath: string, workspace: unknown, session: unknown): Promise<void> {
    return ipcRenderer.invoke(PROJECT_STATE_SAVE, rootPath, workspace, session)
  },

  projectStateLoad(rootPath: string): Promise<unknown> {
    return ipcRenderer.invoke(PROJECT_STATE_LOAD, rootPath)
  },


  /** Push a partial boot snapshot to main (geometry, theme, etc.). Main
   *  debounces and writes `<userData>/boot.json` for the next cold launch. */
  bootSnapshotWrite(partial: Record<string, unknown>): Promise<void> {
    return ipcRenderer.invoke(BOOT_SNAPSHOT_WRITE, partial)
  },

  // ---------------------------------------------------------------------------
  // App
  // ---------------------------------------------------------------------------

  onOpenPath(callback: (filePath: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, filePath: string): void => {
      callback(filePath)
    }
    ipcRenderer.on(APP_OPEN_PATH, listener)
    return () => { ipcRenderer.removeListener(APP_OPEN_PATH, listener) }
  },

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------

  openFolderDialog(): Promise<string | null> {
    return ipcRenderer.invoke(DIALOG_OPEN_FOLDER)
  },

  openImageDialog(): Promise<string | null> {
    return ipcRenderer.invoke(DIALOG_OPEN_IMAGE)
  },

  readCanvasBackgroundImage(filePath: string): Promise<string | null> {
    return ipcRenderer.invoke(CANVAS_READ_BACKGROUND_IMAGE, filePath)
  },

  saveFileDialog(payload?: { defaultName?: string; defaultPath?: string }): Promise<string | null> {
    return ipcRenderer.invoke(DIALOG_SAVE_FILE, payload ?? {})
  },

  confirmUnsavedChanges(payload: { fileName?: string; multiple?: boolean; filePath?: string }): Promise<'save' | 'discard' | 'cancel'> {
    return ipcRenderer.invoke(DIALOG_CONFIRM_UNSAVED, payload)
  },

  confirmCloseTerminal(payload: { count: number; processName?: string | null }): Promise<'close' | 'cancel'> {
    return ipcRenderer.invoke(DIALOG_CONFIRM_CLOSE_TERMINAL, payload)
  },

  confirmCloseCanvas(payload: { panelCount: number; isLast: boolean }): Promise<'move' | 'delete' | 'close' | 'cancel'> {
    return ipcRenderer.invoke(DIALOG_CONFIRM_CLOSE_CANVAS, payload)
  },

  confirmReloadWorkspace(payload: { name?: string }): Promise<'reload' | 'cancel'> {
    return ipcRenderer.invoke(DIALOG_CONFIRM_RELOAD_WORKSPACE, payload)
  },

  confirmImportEntries(payload: { count: number; destName: string }): Promise<'copy' | 'move' | 'cancel'> {
    return ipcRenderer.invoke(DIALOG_CONFIRM_IMPORT, payload)
  },

  promptTerminalLinkOpen(url: string): Promise<'canvas' | 'external' | 'cancel'> {
    return ipcRenderer.invoke(DIALOG_TERMINAL_LINK_OPEN, { url })
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
  recentProjectsRemove(projectPath: string): Promise<void> {
    return ipcRenderer.invoke(RECENT_PROJECTS_REMOVE, projectPath)
  },

  sidebarSessionGet(): Promise<SidebarSession | null> {
    return ipcRenderer.invoke(SIDEBAR_SESSION_GET)
  },

  sidebarSessionSet(session: SidebarSession): Promise<void> {
    return ipcRenderer.invoke(SIDEBAR_SESSION_SET, session)
  },

  remoteProjectsGet(): Promise<unknown> {
    return ipcRenderer.invoke(REMOTE_PROJECTS_GET)
  },

  remoteProjectsSet(entries: unknown): Promise<void> {
    return ipcRenderer.invoke(REMOTE_PROJECTS_SET, entries)
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

  browserSetProxy(partition: string, proxyUrl?: string): Promise<void> {
    return ipcRenderer.invoke(BROWSER_SET_PROXY, partition, proxyUrl)
  },

  nativeFileDrag(filePath: string): Promise<void> {
    return ipcRenderer.invoke(NATIVE_FILE_DRAG, filePath)
  },

  // ---------------------------------------------------------------------------
  // Shell utilities
  // ---------------------------------------------------------------------------

  fsDelete(filePath: string, workspaceId?: string): Promise<void> {
    return ipcRenderer.invoke(FS_DELETE, filePath, workspaceId)
  },

  fsRename(oldPath: string, newPath: string, workspaceId?: string): Promise<void> {
    return ipcRenderer.invoke(FS_RENAME, oldPath, newPath, workspaceId)
  },

  fsMkdir(dirPath: string, workspaceId?: string): Promise<void> {
    return ipcRenderer.invoke(FS_MKDIR, dirPath, workspaceId)
  },

  fsCopy(srcPath: string, destDir: string, workspaceId?: string): Promise<string> {
    return ipcRenderer.invoke(FS_COPY, srcPath, destDir, workspaceId)
  },

  fsImportEntries(
    sources: string[],
    destDir: string,
    mode: 'copy' | 'move',
    workspaceId?: string,
  ): Promise<{ created: string[]; failed: number }> {
    return ipcRenderer.invoke(FS_IMPORT_ENTRIES, sources, destDir, mode, workspaceId)
  },

  shellShowInFolder(filePath: string): Promise<void> {
    return ipcRenderer.invoke(SHELL_SHOW_IN_FOLDER, filePath)
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

  windowSetTitle(title: string): Promise<void> {
    return ipcRenderer.invoke(WINDOW_SET_TITLE, title)
  },

  // ---------------------------------------------------------------------------
  // Panel transfer (cross-window)
  // ---------------------------------------------------------------------------

  panelTransfer(snapshot: unknown, targetWindowId?: number, workspaceId?: string): Promise<number | void> {
    return ipcRenderer.invoke(PANEL_TRANSFER, snapshot, targetWindowId, workspaceId)
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

  panelWindowSyncMeta(payload: { panel: unknown; workspaceId?: string }): Promise<void> {
    return ipcRenderer.invoke(PANEL_WINDOW_SYNC_META, payload)
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

  onDragEnd(callback: () => void): () => void {
    const listener = (): void => { callback() }
    ipcRenderer.on(DRAG_END, listener)
    return () => { ipcRenderer.removeListener(DRAG_END, listener) }
  },

  /** Subscribe to native-fullscreen state changes. Fires with the new boolean
   *  whenever any Cate window enters or leaves macOS native fullscreen. */
  onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, value: boolean): void => {
      callback(Boolean(value))
    }
    ipcRenderer.on(WINDOW_FULLSCREEN_STATE, listener)
    return () => { ipcRenderer.removeListener(WINDOW_FULLSCREEN_STATE, listener) }
  },

  /** Subscribe to workspace.json external-edit state. Fires whenever a project's
   *  on-disk workspace file diverges from what Cate last wrote (edited
   *  externally) or comes back in sync after a reload. */
  onWorkspaceExternalEdit(callback: (payload: { rootPath: string }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: { rootPath: string }): void => {
      callback(payload)
    }
    ipcRenderer.on(WORKSPACE_EXTERNAL_EDIT, listener)
    return () => { ipcRenderer.removeListener(WORKSPACE_EXTERNAL_EDIT, listener) }
  },

  /** Tell main the user declined the reload prompt — resume saving so the
   *  current in-app layout overwrites the external edit. */
  dismissWorkspaceExternalEdit(rootPath: string): Promise<void> {
    return ipcRenderer.invoke(WORKSPACE_EXTERNAL_EDIT_DISMISS, rootPath)
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

  workspaceCreate(options?: { name?: string; rootPath?: string; id?: string; connection?: unknown }): Promise<unknown> {
    return ipcRenderer.invoke(WORKSPACE_CREATE, options)
  },

  // --- Companion connections (remote / WSL) ---
  companionConnect(spec: unknown): Promise<unknown> {
    return ipcRenderer.invoke(COMPANION_CONNECT, spec)
  },
  companionEnsure(connection: unknown): Promise<unknown> {
    return ipcRenderer.invoke(COMPANION_ENSURE, connection)
  },
  companionList(): Promise<string[]> {
    return ipcRenderer.invoke(COMPANION_LIST)
  },
  companionLocalStatus(): Promise<{ phase: string; message?: string }> {
    return ipcRenderer.invoke(COMPANION_LOCAL_STATUS)
  },
  companionWslDistros(): Promise<string[]> {
    return ipcRenderer.invoke(COMPANION_WSL_DISTROS)
  },
  companionSshHosts(): Promise<unknown[]> {
    return ipcRenderer.invoke(COMPANION_SSH_HOSTS)
  },
  companionInstall(connection: unknown): Promise<unknown> {
    return ipcRenderer.invoke(COMPANION_INSTALL, connection)
  },
  companionDelete(connection: unknown): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(COMPANION_DELETE, connection)
  },
  onCompanionStatus(callback: (event: unknown) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      callback(payload)
    }
    ipcRenderer.on(COMPANION_STATUS, listener)
    return () => {
      ipcRenderer.removeListener(COMPANION_STATUS, listener)
    }
  },

  workspaceUpdate(id: string, changes: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke(WORKSPACE_UPDATE, id, changes)
  },

  workspaceRemove(id: string): Promise<boolean> {
    return ipcRenderer.invoke(WORKSPACE_REMOVE, id)
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

  onMenuLoadLayout(callback: (name: string) => void): () => void {
    const listener = (_e: unknown, name: string): void => { callback(name) }
    ipcRenderer.on(MENU_LOAD_LAYOUT, listener)
    return () => { ipcRenderer.removeListener(MENU_LOAD_LAYOUT, listener) }
  },

  onMenuCreatePanel(callback: (payload: { action: string; workspaceId?: string }) => void): () => void {
    const listener = (_e: unknown, payload: { action: string; workspaceId?: string }): void => { callback(payload) }
    ipcRenderer.on(MENU_CREATE_PANEL, listener)
    return () => { ipcRenderer.removeListener(MENU_CREATE_PANEL, listener) }
  },

  onBrowserShortcut(callback: (action: string) => void): () => void {
    const listener = (_e: unknown, action: string): void => { callback(action) }
    ipcRenderer.on(BROWSER_SHORTCUT, listener)
    return () => { ipcRenderer.removeListener(BROWSER_SHORTCUT, listener) }
  },

  // ---------------------------------------------------------------------------
  // Auto-updater
  // ---------------------------------------------------------------------------

  onUpdateStatus(callback: (status: unknown) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, status: unknown): void => callback(status)
    ipcRenderer.on(UPDATE_STATUS, listener)
    return () => { ipcRenderer.removeListener(UPDATE_STATUS, listener) }
  },

  updateGetStatus(): Promise<unknown> {
    return ipcRenderer.invoke('update:getStatus')
  },

  updateDownload(): void { ipcRenderer.send(UPDATE_DOWNLOAD) },
  updateInstall(): void { ipcRenderer.send(UPDATE_INSTALL) },
  updateOpenRelease(url?: string): void { ipcRenderer.send(UPDATE_OPEN_RELEASE, url) },

  // ---------------------------------------------------------------------------
  // Analytics — post-update feedback prompt
  // ---------------------------------------------------------------------------

  onFeedbackPrompt(callback: (payload: { fromVersion: string; toVersion: string }) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, payload: { fromVersion: string; toVersion: string }): void => callback(payload)
    ipcRenderer.on(ANALYTICS_FEEDBACK_PROMPT, listener)
    return () => { ipcRenderer.removeListener(ANALYTICS_FEEDBACK_PROMPT, listener) }
  },

  submitFeedback(payload: { rating: number; comment?: string }): Promise<{ ok: boolean; buffered?: boolean }> {
    return ipcRenderer.invoke(ANALYTICS_FEEDBACK_SUBMIT, payload)
  },

  dismissFeedback(method: string): void {
    ipcRenderer.send(ANALYTICS_FEEDBACK_DISMISS, method)
  },

  trackFeedbackEngagement(): void {
    ipcRenderer.send(ANALYTICS_FEEDBACK_ENGAGED)
  },

  getPendingFeedback(): Promise<{ fromVersion: string; toVersion: string } | null> {
    return ipcRenderer.invoke(ANALYTICS_FEEDBACK_GET_PENDING)
  },

  trackLinkClick(link: string): void {
    ipcRenderer.send(ANALYTICS_LINK_CLICK, link)
  },

  setTelemetryConsent(choice: { crashReporting: boolean; usageAnalytics: boolean }): Promise<void> {
    return ipcRenderer.invoke(TELEMETRY_SET_CONSENT, choice)
  },

  trackFeatureUsed(feature: string, props?: Record<string, string | number | boolean>): void {
    ipcRenderer.send(ANALYTICS_TRACK_USAGE, { feature, props })
  },

  openExternalUrl(url: string): void {
    ipcRenderer.send(OPEN_EXTERNAL_URL, url)
  },

  // ---------------------------------------------------------------------------
  // Pi agent
  // ---------------------------------------------------------------------------

  agentCreate(options: unknown): Promise<unknown> {
    return ipcRenderer.invoke(AGENT_CREATE, options)
  },

  agentPrompt(panelId: string, text: string, images?: unknown[]): Promise<void> {
    return ipcRenderer.invoke(AGENT_PROMPT, panelId, text, images)
  },

  agentSteer(panelId: string, text: string, images?: unknown[]): Promise<void> {
    return ipcRenderer.invoke(AGENT_STEER, panelId, text, images)
  },

  agentFollowUp(panelId: string, text: string, images?: unknown[]): Promise<void> {
    return ipcRenderer.invoke(AGENT_FOLLOW_UP, panelId, text, images)
  },

  agentSetThinkingLevel(panelId: string, level: string): Promise<void> {
    return ipcRenderer.invoke(AGENT_SET_THINKING_LEVEL, panelId, level)
  },

  agentCompact(panelId: string, customInstructions?: string): Promise<unknown> {
    return ipcRenderer.invoke(AGENT_COMPACT, panelId, customInstructions)
  },

  agentSetAutoCompaction(panelId: string, enabled: boolean): Promise<void> {
    return ipcRenderer.invoke(AGENT_SET_AUTO_COMPACTION, panelId, enabled)
  },

  agentSetAutoRetry(panelId: string, enabled: boolean): Promise<void> {
    return ipcRenderer.invoke(AGENT_SET_AUTO_RETRY, panelId, enabled)
  },

  agentAbortRetry(panelId: string): Promise<void> {
    return ipcRenderer.invoke(AGENT_ABORT_RETRY, panelId)
  },

  agentGetSessionStats(panelId: string): Promise<unknown> {
    return ipcRenderer.invoke(AGENT_GET_SESSION_STATS, panelId)
  },

  agentGetState(panelId: string): Promise<unknown> {
    return ipcRenderer.invoke(AGENT_GET_STATE, panelId)
  },

  agentExportHtml(panelId: string, outputPath?: string): Promise<{ path: string }> {
    return ipcRenderer.invoke(AGENT_EXPORT_HTML, panelId, outputPath)
  },

  agentNewSession(panelId: string, parentSession?: string): Promise<{ cancelled: boolean }> {
    return ipcRenderer.invoke(AGENT_NEW_SESSION, panelId, parentSession)
  },

  agentSwitchSession(panelId: string, sessionPath: string): Promise<{ cancelled: boolean }> {
    return ipcRenderer.invoke(AGENT_SWITCH_SESSION, panelId, sessionPath)
  },

  agentFork(panelId: string, entryId: string): Promise<{ text: string; cancelled: boolean }> {
    return ipcRenderer.invoke(AGENT_FORK, panelId, entryId)
  },

  agentClone(panelId: string): Promise<{ cancelled: boolean }> {
    return ipcRenderer.invoke(AGENT_CLONE, panelId)
  },

  agentGetForkMessages(panelId: string): Promise<Array<{ entryId: string; text: string }>> {
    return ipcRenderer.invoke(AGENT_GET_FORK_MESSAGES, panelId)
  },

  agentGetLastAssistantText(panelId: string): Promise<string | null> {
    return ipcRenderer.invoke(AGENT_GET_LAST_ASSISTANT_TEXT, panelId)
  },

  agentSetSessionName(panelId: string, name: string): Promise<void> {
    return ipcRenderer.invoke(AGENT_SET_SESSION_NAME, panelId, name)
  },

  agentGetMessages(panelId: string): Promise<unknown[]> {
    return ipcRenderer.invoke(AGENT_GET_MESSAGES, panelId)
  },

  agentBash(panelId: string, command: string): Promise<unknown> {
    return ipcRenderer.invoke(AGENT_BASH, panelId, command)
  },

  agentAbortBash(panelId: string): Promise<void> {
    return ipcRenderer.invoke(AGENT_ABORT_BASH, panelId)
  },

  agentSetSteeringMode(panelId: string, mode: 'all' | 'one-at-a-time'): Promise<void> {
    return ipcRenderer.invoke(AGENT_SET_STEERING_MODE, panelId, mode)
  },

  agentSetFollowUpMode(panelId: string, mode: 'all' | 'one-at-a-time'): Promise<void> {
    return ipcRenderer.invoke(AGENT_SET_FOLLOW_UP_MODE, panelId, mode)
  },

  agentGetAvailableModels(panelId: string): Promise<unknown[]> {
    return ipcRenderer.invoke(AGENT_GET_AVAILABLE_MODELS, panelId)
  },

  agentUiResponse(panelId: string, response: unknown): void {
    ipcRenderer.send(AGENT_UI_RESPONSE, panelId, response)
  },

  agentListSessions(cwd: string): Promise<unknown[]> {
    return ipcRenderer.invoke(AGENT_LIST_SESSIONS, cwd)
  },

  agentLoadSessionMessages(sessionFile: string): Promise<unknown[]> {
    return ipcRenderer.invoke(AGENT_LOAD_SESSION_MESSAGES, sessionFile)
  },

  agentDeleteSession(sessionFile: string): Promise<void> {
    return ipcRenderer.invoke(AGENT_DELETE_SESSION, sessionFile)
  },

  agentInterrupt(panelId: string): Promise<void> {
    return ipcRenderer.invoke(AGENT_INTERRUPT, panelId)
  },

  agentDispose(panelId: string): Promise<void> {
    return ipcRenderer.invoke(AGENT_DISPOSE, panelId)
  },

  agentSetModel(panelId: string, model: unknown): Promise<void> {
    return ipcRenderer.invoke(AGENT_SET_MODEL, panelId, model)
  },

  agentGetCommands(panelId: string): Promise<unknown[]> {
    return ipcRenderer.invoke(AGENT_GET_COMMANDS, panelId)
  },

  agentToolDecision(panelId: string, toolCallId: string, decision: 'allow' | 'deny', reason?: string): Promise<void> {
    return ipcRenderer.invoke(AGENT_TOOL_DECISION, panelId, toolCallId, decision, reason)
  },

  agentOpenSkillsFolder(cwd: string, kind: 'agents' | 'prompts' | 'skills'): Promise<void> {
    return ipcRenderer.invoke(AGENT_OPEN_SKILLS_FOLDER, cwd, kind)
  },

  agentOpenSkillFile(filePath: string): Promise<void> {
    return ipcRenderer.invoke(AGENT_OPEN_SKILL_FILE, filePath)
  },

  agentDeleteSkillFile(cwd: string, filePath: string): Promise<void> {
    return ipcRenderer.invoke(AGENT_DELETE_SKILL_FILE, cwd, filePath)
  },

  agentCreateSkill(cwd: string, kind: 'agents' | 'prompts' | 'skills', name: string): Promise<string> {
    return ipcRenderer.invoke(AGENT_CREATE_SKILL, cwd, kind, name)
  },

  agentListSkillFiles(cwd: string, kind: 'agents' | 'prompts' | 'skills'): Promise<Array<{ name: string; description?: string; path: string }>> {
    return ipcRenderer.invoke(AGENT_LIST_SKILL_FILES, cwd, kind)
  },

  agentMarketplaceList(
    params?: { page?: number; query?: string; sort?: 'downloads' | 'recent' | 'name' },
  ): Promise<unknown> {
    return ipcRenderer.invoke(AGENT_MARKETPLACE_LIST, params)
  },

  agentMarketplaceListInstalled(cwd: string): Promise<unknown[]> {
    return ipcRenderer.invoke(AGENT_MARKETPLACE_LIST_INSTALLED, cwd)
  },

  agentMarketplaceInstall(cwd: string, name: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(AGENT_MARKETPLACE_INSTALL, cwd, name)
  },

  agentMarketplaceUninstall(cwd: string, name: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(AGENT_MARKETPLACE_UNINSTALL, cwd, name)
  },

  onAgentEvent(callback: (envelope: unknown) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, envelope: unknown): void => { callback(envelope) }
    ipcRenderer.on(AGENT_EVENT, listener)
    return () => { ipcRenderer.removeListener(AGENT_EVENT, listener) }
  },

  onAgentToolRequest(callback: (req: unknown) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, req: unknown): void => { callback(req) }
    ipcRenderer.on(AGENT_TOOL_REQUEST, listener)
    return () => { ipcRenderer.removeListener(AGENT_TOOL_REQUEST, listener) }
  },

  agentCustomModelsGet(): Promise<unknown> {
    return ipcRenderer.invoke(AGENT_CUSTOM_MODELS_GET)
  },

  agentCustomModelsSave(cfg: unknown): Promise<void> {
    return ipcRenderer.invoke(AGENT_CUSTOM_MODELS_SAVE, cfg)
  },

  // ---------------------------------------------------------------------------
  // Pi auth / providers
  // ---------------------------------------------------------------------------

  authListProviders(): Promise<unknown[]> {
    return ipcRenderer.invoke(AUTH_LIST_PROVIDERS)
  },

  authStatus(): Promise<unknown[]> {
    return ipcRenderer.invoke(AUTH_STATUS)
  },

  authOAuthStart(providerId: string): Promise<unknown> {
    return ipcRenderer.invoke(AUTH_OAUTH_START, providerId)
  },

  authOAuthPromptReply(promptId: string, value: string | null): Promise<void> {
    return ipcRenderer.invoke(AUTH_OAUTH_PROMPT_REPLY, promptId, value)
  },

  onAuthOAuthEvent(callback: (providerId: string, event: unknown) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, providerId: string, event: unknown): void => {
      callback(providerId, event)
    }
    ipcRenderer.on(AUTH_OAUTH_EVENT, listener)
    return () => { ipcRenderer.removeListener(AUTH_OAUTH_EVENT, listener) }
  },

  authSaveApiKey(providerId: string, apiKey: string): Promise<void> {
    return ipcRenderer.invoke(AUTH_SAVE_API_KEY, providerId, apiKey)
  },

  authDelete(providerId: string): Promise<void> {
    return ipcRenderer.invoke(AUTH_DELETE, providerId)
  },

})
