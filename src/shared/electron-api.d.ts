// =============================================================================
// Type declaration for window.electronAPI exposed via contextBridge
// =============================================================================

import type { AppSettings, ClaudeCodeState, FileTreeNode, GitInfo, SessionSnapshot, TerminalActivity } from './types'

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
    callback: (terminalId: string, activity: TerminalActivity, claudeState: ClaudeCodeState) => void,
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

  // ---------------------------------------------------------------------------
  // Shell utilities
  // ---------------------------------------------------------------------------

  shellWhich(command: string): Promise<string | null>
  fsDelete(filePath: string): Promise<void>
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
  // Menu actions (main -> renderer)
  // ---------------------------------------------------------------------------

  onMenuOpenSettings(callback: () => void): () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
