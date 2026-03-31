import { contextBridge, ipcRenderer } from 'electron'
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
  SETTINGS_GET,
  SETTINGS_SET,
  SETTINGS_GET_ALL,
  SETTINGS_RESET,
  SESSION_SAVE,
  SESSION_LOAD,
  SESSION_CLEAR,
  APP_GET_PATH,
  MENU_OPEN_SETTINGS,
  DIALOG_OPEN_FOLDER,
  DIALOG_SAVE_FILE,
  RECENT_PROJECTS_GET,
  RECENT_PROJECTS_ADD,
  LAYOUT_SAVE,
  LAYOUT_LIST,
  LAYOUT_LOAD,
  LAYOUT_DELETE,
  SHELL_WHICH,
  FS_DELETE,
  SHELL_SHOW_IN_FOLDER,
  HTTP_FETCH,
  MCP_SPAWN,
  MCP_STOP,
  MCP_TEST,
  MCP_STATUS_UPDATE,
} from '../shared/ipc-channels'

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

  onShellActivityUpdate(
    callback: (terminalId: string, activity: unknown, claudeState: unknown) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalId: string,
      activity: unknown,
      claudeState: unknown,
    ): void => {
      callback(terminalId, activity, claudeState)
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

  // ---------------------------------------------------------------------------
  // App
  // ---------------------------------------------------------------------------

  appGetPath(name: string): Promise<string> {
    return ipcRenderer.invoke(APP_GET_PATH, name)
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
    return ipcRenderer.invoke('capture-page')
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

  mcpTest(command: string, args: string[], env: Record<string, string>): Promise<{ success: boolean; error?: string }> {
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
  // Menu actions (main -> renderer)
  // ---------------------------------------------------------------------------

  onMenuOpenSettings(callback: () => void): () => void {
    const listener = (): void => { callback() }
    ipcRenderer.on(MENU_OPEN_SETTINGS, listener)
    return () => { ipcRenderer.removeListener(MENU_OPEN_SETTINGS, listener) }
  },
})
