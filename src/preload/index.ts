import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'

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
  TERMINAL_CLIPBOARD_WRITE,
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
  BROWSER_SHORTCUT,
  MENU_SHOW_CONTEXT,
  MENU_GET_BAR_ITEMS,
  MENU_POPUP_BAR_ITEM,
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
  WINDOW_MINIMIZE,
  WINDOW_TOGGLE_MAXIMIZE,
  WINDOW_CLOSE,
  WINDOW_IS_MAXIMIZED,
  WINDOW_MAXIMIZE_STATE,
  PANEL_TRANSFER,
  PANEL_RECEIVE,
  PANEL_TRANSFER_ACK,
  PANEL_WINDOW_DOCK_BACK,
  WINDOW_CLOSE_FOR_WORKSPACE,
  RUN_ACTION_IN_MAIN,
  DRAG_START,
  DRAG_DETACH,
  WINDOW_FULLSCREEN_STATE,
  DRAG_END,
  DOCK_WINDOW_INIT,
  DOCK_WINDOW_SYNC_STATE,
  DOCK_WINDOW_RESTORE,
  DOCK_WINDOW_FLUSH_SYNC,
  DOCK_WINDOW_FLUSH_SYNC_DONE,
  DOCK_WINDOWS_LIST,
  WINDOW_PANELS_CHANGED,
  FOCUS_WINDOW_PANEL,
  REVEAL_PANEL_IN_WINDOW,
  WINDOW_PANELS_REPORT,
  CROSS_WINDOW_DRAG_START,
  CROSS_WINDOW_DRAG_UPDATE,
  CROSS_WINDOW_DRAG_DROP,
  CROSS_WINDOW_DRAG_CANCEL,
  CROSS_WINDOW_DRAG_RESOLVE,
  WORKSPACE_CREATE,
  WORKSPACE_UPDATE,
  WORKSPACE_REMOVE,
  WORKSPACE_CHANGED,
  RUNTIME_CONNECT,
  RUNTIME_ENSURE,
  RUNTIME_LIST,
  RUNTIME_WSL_DISTROS,
  RUNTIME_SSH_HOSTS,
  RUNTIME_DELETE,
  RUNTIME_INSTALL,
  RUNTIME_STATUS,
  RUNTIME_LOCAL_STATUS,
  RUNTIME_PICK_SSH_KEY,
  WEBVIEW_SCREENSHOT,
  BROWSER_SET_PROXY,
  NATIVE_FILE_DRAG,
  CAPTURE_PAGE,
  UPDATE_STATUS,
  UPDATE_QUIT_AND_INSTALL,
  UPDATE_GET_STATUS,
  ANALYTICS_FEEDBACK_PROMPT,
  ANALYTICS_FEEDBACK_SUBMIT,
  ANALYTICS_FEEDBACK_DISMISS,
  ANALYTICS_FEEDBACK_GET_PENDING,
  ANALYTICS_LINK_CLICK,
  ANALYTICS_TRACK_USAGE,
  TELEMETRY_ACKNOWLEDGE_NOTICE,
  OPEN_EXTERNAL_URL,
  AGENT_CREATE,
  AGENT_PROMPT,
  AGENT_INTERRUPT,
  AGENT_DISPOSE,
  AGENT_SET_MODEL,
  AGENT_GET_COMMANDS,
  AGENT_EVENT,
  AGENT_OPEN_SKILLS_FOLDER,
  AGENT_OPEN_SKILL_FILE,
  AGENT_DELETE_SKILL_FILE,
  AGENT_CREATE_SKILL,
  AGENT_LIST_SKILL_FILES,
  AGENT_STEER,
  AGENT_SET_THINKING_LEVEL,
  AGENT_COMPACT,
  AGENT_SET_AUTO_COMPACTION,
  AGENT_ABORT_RETRY,
  AGENT_GET_SESSION_STATS,
  AGENT_GET_STATE,
  AGENT_FORK,
  AGENT_GET_FORK_MESSAGES,
  AGENT_LIST_MODELS,
  AGENT_UI_RESPONSE,
  AGENT_LIST_SESSIONS,
  AGENT_LOAD_SESSION_MESSAGES,
  AGENT_DELETE_SESSION,
  AGENT_CUSTOM_MODELS_GET,
  AGENT_CUSTOM_MODELS_SAVE,
  SKILLS_GET_INDEX,
  SKILLS_REFRESH,
  SKILLS_GET_PREVIEW,
  SKILLS_INSTALL,
  SKILLS_UNINSTALL,
  SKILLS_LIST_INSTALLED,
  SKILLS_LIST_SAVED,
  SKILLS_SAVE,
  SKILLS_UNSAVE,
  SKILLS_LIST_SOURCES,
  SKILLS_ADD_SOURCE,
  SKILLS_REMOVE_SOURCE,
  SKILLS_GET_TOKEN,
  SKILLS_SET_TOKEN,
  AUTH_LIST_PROVIDERS,
  AUTH_STATUS,
  AUTH_OAUTH_START,
  AUTH_OAUTH_PROMPT_REPLY,
  AUTH_OAUTH_EVENT,
  AUTH_CHANGED,
  AUTH_SAVE_API_KEY,
  AUTH_DELETE,
  PERF_GET,
} from '../shared/ipc-channels'
import type { AppSettings, SearchResultBatch, SearchDoneEvent } from '../shared/types'
import type { ElectronAPI, UpdateStatus } from '../shared/electron-api'

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

// This window's own maximize state, pushed by main on maximize/unmaximize. Cached
// so the custom window controls can render synchronously on first paint, with a
// `sendSync` pull as the authoritative fallback (mirrors the fullscreen pattern).
let cachedMaximized = false
ipcRenderer.on(WINDOW_MAXIMIZE_STATE, (_event, value: boolean) => {
  cachedMaximized = Boolean(value)
})
function maximizedLiveCheck(): boolean {
  try {
    const v = ipcRenderer.sendSync(WINDOW_IS_MAXIMIZED)
    cachedMaximized = Boolean(v)
    return cachedMaximized
  } catch {
    return cachedMaximized
  }
}

// Shared factory for the many `onXyz(callback)` subscription methods below.
// Registers an ipcRenderer listener that strips the IPC event and forwards the
// remaining args verbatim to `callback`, and returns an unsubscribe closure.
function createIpcListener<Args extends unknown[]>(
  channel: string,
  callback: (...args: Args) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: Args): void => {
    callback(...args)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// Shared factory for the many pure pass-through invoke methods below. Builds a
// forwarder that calls `ipcRenderer.invoke(channel, ...args)` and returns the
// promise verbatim. The type parameter pins each entry to its `ElectronAPI`
// method signature, so the `invokeForwarders` table (spread into the exposed
// object) is enforced by `satisfies ElectronAPI` at typecheck. Only fully pure
// forwarders live in the table — methods that transform args before invoking
// (saveFileDialog, promptTerminalLinkOpen, popupAppMenu) stay hand-written.
function makeInvoker<K extends keyof ElectronAPI>(channel: string): ElectronAPI[K] {
  return ((...args: unknown[]) => ipcRenderer.invoke(channel, ...args)) as ElectronAPI[K]
}

const invokeForwarders = {
  perfGetSnapshot: makeInvoker<'perfGetSnapshot'>(PERF_GET),

  // Terminal
  terminalCreate: makeInvoker<'terminalCreate'>(TERMINAL_CREATE),
  terminalWrite: makeInvoker<'terminalWrite'>(TERMINAL_WRITE),
  terminalResize: makeInvoker<'terminalResize'>(TERMINAL_RESIZE),
  terminalKill: makeInvoker<'terminalKill'>(TERMINAL_KILL),
  terminalGetCwd: makeInvoker<'terminalGetCwd'>(TERMINAL_GET_CWD),
  terminalLogRead: makeInvoker<'terminalLogRead'>(TERMINAL_LOG_READ),
  terminalScrollbackSave: makeInvoker<'terminalScrollbackSave'>(TERMINAL_SCROLLBACK_SAVE),
  terminalSetVisibility: makeInvoker<'terminalSetVisibility'>(TERMINAL_SET_VISIBILITY),
  terminalClipboardWrite: makeInvoker<'terminalClipboardWrite'>(TERMINAL_CLIPBOARD_WRITE),

  // Filesystem
  fsReadFile: makeInvoker<'fsReadFile'>(FS_READ_FILE),
  fsReadBinary: makeInvoker<'fsReadBinary'>(FS_READ_BINARY),
  fsWriteFile: makeInvoker<'fsWriteFile'>(FS_WRITE_FILE),
  fsReadDir: makeInvoker<'fsReadDir'>(FS_READ_DIR),
  fsSearch: makeInvoker<'fsSearch'>(FS_SEARCH),
  fsWatchStart: makeInvoker<'fsWatchStart'>(FS_WATCH_START),
  fsWatchStop: makeInvoker<'fsWatchStop'>(FS_WATCH_STOP),
  fsStat: makeInvoker<'fsStat'>(FS_STAT),
  fsDelete: makeInvoker<'fsDelete'>(FS_DELETE),
  fsRename: makeInvoker<'fsRename'>(FS_RENAME),
  fsMkdir: makeInvoker<'fsMkdir'>(FS_MKDIR),
  fsCopy: makeInvoker<'fsCopy'>(FS_COPY),
  fsImportEntries: makeInvoker<'fsImportEntries'>(FS_IMPORT_ENTRIES),

  // Content search
  searchStart: makeInvoker<'searchStart'>(SEARCH_START),
  searchCancel: makeInvoker<'searchCancel'>(SEARCH_CANCEL),

  // Git
  gitIsRepo: makeInvoker<'gitIsRepo'>(GIT_IS_REPO),
  gitInit: makeInvoker<'gitInit'>(GIT_INIT),
  gitLsFiles: makeInvoker<'gitLsFiles'>(GIT_LS_FILES),
  gitStatus: makeInvoker<'gitStatus'>(GIT_STATUS),
  gitDiff: makeInvoker<'gitDiff'>(GIT_DIFF),
  gitStage: makeInvoker<'gitStage'>(GIT_STAGE),
  gitUnstage: makeInvoker<'gitUnstage'>(GIT_UNSTAGE),
  gitCommit: makeInvoker<'gitCommit'>(GIT_COMMIT),
  gitWorktreeList: makeInvoker<'gitWorktreeList'>(GIT_WORKTREE_LIST),
  gitWorktreeAdd: makeInvoker<'gitWorktreeAdd'>(GIT_WORKTREE_ADD),
  gitWorktreeRemove: makeInvoker<'gitWorktreeRemove'>(GIT_WORKTREE_REMOVE),
  gitWorktreePrune: makeInvoker<'gitWorktreePrune'>(GIT_WORKTREE_PRUNE),
  gitWorktreeStatus: makeInvoker<'gitWorktreeStatus'>(GIT_WORKTREE_STATUS),
  gitWorktreeMergeTo: makeInvoker<'gitWorktreeMergeTo'>(GIT_WORKTREE_MERGE_TO),
  gitWorktreeUpdateFrom: makeInvoker<'gitWorktreeUpdateFrom'>(GIT_WORKTREE_UPDATE_FROM),
  gitWorktreeAddFromPr: makeInvoker<'gitWorktreeAddFromPr'>(GIT_WORKTREE_ADD_FROM_PR),
  gitPrList: makeInvoker<'gitPrList'>(GIT_PR_LIST),
  gitCreatePR: makeInvoker<'gitCreatePR'>(GIT_CREATE_PR),
  gitPrStatus: makeInvoker<'gitPrStatus'>(GIT_PR_STATUS),
  gitPush: makeInvoker<'gitPush'>(GIT_PUSH),
  gitPull: makeInvoker<'gitPull'>(GIT_PULL),
  gitFetch: makeInvoker<'gitFetch'>(GIT_FETCH),
  gitLog: makeInvoker<'gitLog'>(GIT_LOG),
  gitBranchList: makeInvoker<'gitBranchList'>(GIT_BRANCH_LIST),
  gitBranchCreate: makeInvoker<'gitBranchCreate'>(GIT_BRANCH_CREATE),
  gitBranchDelete: makeInvoker<'gitBranchDelete'>(GIT_BRANCH_DELETE),
  gitCheckout: makeInvoker<'gitCheckout'>(GIT_CHECKOUT),
  gitDiffStaged: makeInvoker<'gitDiffStaged'>(GIT_DIFF_STAGED),
  gitStash: makeInvoker<'gitStash'>(GIT_STASH),
  gitStashPop: makeInvoker<'gitStashPop'>(GIT_STASH_POP),
  gitDiscardFile: makeInvoker<'gitDiscardFile'>(GIT_DISCARD_FILE),

  // Shell / Process Monitor
  shellRegisterTerminal: makeInvoker<'shellRegisterTerminal'>(SHELL_REGISTER_TERMINAL),
  shellUnregisterTerminal: makeInvoker<'shellUnregisterTerminal'>(SHELL_UNREGISTER_TERMINAL),

  // Settings
  settingsGet: makeInvoker<'settingsGet'>(SETTINGS_GET),
  settingsSet: makeInvoker<'settingsSet'>(SETTINGS_SET),
  settingsGetAll: makeInvoker<'settingsGetAll'>(SETTINGS_GET_ALL),
  settingsReset: makeInvoker<'settingsReset'>(SETTINGS_RESET),
  uiStateGetAll: makeInvoker<'uiStateGetAll'>(UI_STATE_GET_ALL),
  uiStateSet: makeInvoker<'uiStateSet'>(UI_STATE_SET),
  settingsOpenInEditor: makeInvoker<'settingsOpenInEditor'>(SETTINGS_OPEN_IN_EDITOR),

  // Session
  projectStateSave: makeInvoker<'projectStateSave'>(PROJECT_STATE_SAVE),
  projectStateLoad: makeInvoker<'projectStateLoad'>(PROJECT_STATE_LOAD),

  // Dialog
  openFolderDialog: makeInvoker<'openFolderDialog'>(DIALOG_OPEN_FOLDER),
  openImageDialog: makeInvoker<'openImageDialog'>(DIALOG_OPEN_IMAGE),
  readCanvasBackgroundImage: makeInvoker<'readCanvasBackgroundImage'>(CANVAS_READ_BACKGROUND_IMAGE),
  confirmUnsavedChanges: makeInvoker<'confirmUnsavedChanges'>(DIALOG_CONFIRM_UNSAVED),
  confirmCloseTerminal: makeInvoker<'confirmCloseTerminal'>(DIALOG_CONFIRM_CLOSE_TERMINAL),
  confirmCloseCanvas: makeInvoker<'confirmCloseCanvas'>(DIALOG_CONFIRM_CLOSE_CANVAS),
  confirmReloadWorkspace: makeInvoker<'confirmReloadWorkspace'>(DIALOG_CONFIRM_RELOAD_WORKSPACE),
  confirmImportEntries: makeInvoker<'confirmImportEntries'>(DIALOG_CONFIRM_IMPORT),

  // Recent projects / sidebar / remote projects
  recentProjectsGet: makeInvoker<'recentProjectsGet'>(RECENT_PROJECTS_GET),
  recentProjectsAdd: makeInvoker<'recentProjectsAdd'>(RECENT_PROJECTS_ADD),
  recentProjectsRemove: makeInvoker<'recentProjectsRemove'>(RECENT_PROJECTS_REMOVE),
  sidebarSessionGet: makeInvoker<'sidebarSessionGet'>(SIDEBAR_SESSION_GET),
  sidebarSessionSet: makeInvoker<'sidebarSessionSet'>(SIDEBAR_SESSION_SET),
  remoteProjectsGet: makeInvoker<'remoteProjectsGet'>(REMOTE_PROJECTS_GET),
  remoteProjectsSet: makeInvoker<'remoteProjectsSet'>(REMOTE_PROJECTS_SET),

  // Layouts
  layoutSave: makeInvoker<'layoutSave'>(LAYOUT_SAVE),
  layoutList: makeInvoker<'layoutList'>(LAYOUT_LIST),
  layoutLoad: makeInvoker<'layoutLoad'>(LAYOUT_LOAD),
  layoutDelete: makeInvoker<'layoutDelete'>(LAYOUT_DELETE),

  // Capture / browser
  capturePage: makeInvoker<'capturePage'>(CAPTURE_PAGE),
  webviewScreenshot: makeInvoker<'webviewScreenshot'>(WEBVIEW_SCREENSHOT),
  browserSetProxy: makeInvoker<'browserSetProxy'>(BROWSER_SET_PROXY),
  nativeFileDrag: makeInvoker<'nativeFileDrag'>(NATIVE_FILE_DRAG),

  // Shell utilities
  shellShowInFolder: makeInvoker<'shellShowInFolder'>(SHELL_SHOW_IN_FOLDER),

  // Notifications
  notifyOS: makeInvoker<'notifyOS'>(NOTIFY_OS),

  // Window management
  windowMinimize: makeInvoker<'windowMinimize'>(WINDOW_MINIMIZE),
  windowToggleMaximize: makeInvoker<'windowToggleMaximize'>(WINDOW_TOGGLE_MAXIMIZE),
  windowClose: makeInvoker<'windowClose'>(WINDOW_CLOSE),
  windowsCloseForWorkspace: makeInvoker<'windowsCloseForWorkspace'>(WINDOW_CLOSE_FOR_WORKSPACE),
  runActionInMain: makeInvoker<'runActionInMain'>(RUN_ACTION_IN_MAIN),

  // Panel transfer (cross-window)
  panelTransfer: makeInvoker<'panelTransfer'>(PANEL_TRANSFER),
  panelTransferAck: makeInvoker<'panelTransferAck'>(PANEL_TRANSFER_ACK),
  panelWindowDockBack: makeInvoker<'panelWindowDockBack'>(PANEL_WINDOW_DOCK_BACK),

  // Cross-window drag-and-drop
  dragStart: makeInvoker<'dragStart'>(DRAG_START),
  dragDetach: makeInvoker<'dragDetach'>(DRAG_DETACH),

  // Workspace external edit
  dismissWorkspaceExternalEdit: makeInvoker<'dismissWorkspaceExternalEdit'>(WORKSPACE_EXTERNAL_EDIT_DISMISS),

  // Dock window management
  dockWindowSyncState: makeInvoker<'dockWindowSyncState'>(DOCK_WINDOW_SYNC_STATE),
  dockWindowsList: makeInvoker<'dockWindowsList'>(DOCK_WINDOWS_LIST),
  dockWindowRestore: makeInvoker<'dockWindowRestore'>(DOCK_WINDOW_RESTORE),

  // Cross-window panel discovery
  focusWindowPanel: makeInvoker<'focusWindowPanel'>(FOCUS_WINDOW_PANEL),
  reportWindowPanels: makeInvoker<'reportWindowPanels'>(WINDOW_PANELS_REPORT),

  // Cross-window drag coordination
  crossWindowDragStart: makeInvoker<'crossWindowDragStart'>(CROSS_WINDOW_DRAG_START),
  crossWindowDragDrop: makeInvoker<'crossWindowDragDrop'>(CROSS_WINDOW_DRAG_DROP),
  crossWindowDragCancel: makeInvoker<'crossWindowDragCancel'>(CROSS_WINDOW_DRAG_CANCEL),
  crossWindowDragResolve: makeInvoker<'crossWindowDragResolve'>(CROSS_WINDOW_DRAG_RESOLVE),

  // Workspace management
  workspaceCreate: makeInvoker<'workspaceCreate'>(WORKSPACE_CREATE),
  workspaceUpdate: makeInvoker<'workspaceUpdate'>(WORKSPACE_UPDATE),
  workspaceRemove: makeInvoker<'workspaceRemove'>(WORKSPACE_REMOVE),

  // Runtime connections (remote / WSL)
  runtimeConnect: makeInvoker<'runtimeConnect'>(RUNTIME_CONNECT),
  runtimeEnsure: makeInvoker<'runtimeEnsure'>(RUNTIME_ENSURE),
  runtimeList: makeInvoker<'runtimeList'>(RUNTIME_LIST),
  runtimeLocalStatus: makeInvoker<'runtimeLocalStatus'>(RUNTIME_LOCAL_STATUS),
  runtimeWslDistros: makeInvoker<'runtimeWslDistros'>(RUNTIME_WSL_DISTROS),
  runtimeSshHosts: makeInvoker<'runtimeSshHosts'>(RUNTIME_SSH_HOSTS),
  runtimePickSshKey: makeInvoker<'runtimePickSshKey'>(RUNTIME_PICK_SSH_KEY),
  runtimeInstall: makeInvoker<'runtimeInstall'>(RUNTIME_INSTALL),
  runtimeDelete: makeInvoker<'runtimeDelete'>(RUNTIME_DELETE),

  // Menu
  showContextMenu: makeInvoker<'showContextMenu'>(MENU_SHOW_CONTEXT),
  getAppMenuBarItems: makeInvoker<'getAppMenuBarItems'>(MENU_GET_BAR_ITEMS),

  // Auto-updater
  getUpdateStatus: makeInvoker<'getUpdateStatus'>(UPDATE_GET_STATUS),
  quitAndInstallUpdate: makeInvoker<'quitAndInstallUpdate'>(UPDATE_QUIT_AND_INSTALL),

  // Analytics feedback
  submitFeedback: makeInvoker<'submitFeedback'>(ANALYTICS_FEEDBACK_SUBMIT),
  getPendingFeedback: makeInvoker<'getPendingFeedback'>(ANALYTICS_FEEDBACK_GET_PENDING),
  acknowledgeTelemetryNotice: makeInvoker<'acknowledgeTelemetryNotice'>(TELEMETRY_ACKNOWLEDGE_NOTICE),

  // Pi agent
  agentCreate: makeInvoker<'agentCreate'>(AGENT_CREATE),
  agentPrompt: makeInvoker<'agentPrompt'>(AGENT_PROMPT),
  agentSteer: makeInvoker<'agentSteer'>(AGENT_STEER),
  agentSetThinkingLevel: makeInvoker<'agentSetThinkingLevel'>(AGENT_SET_THINKING_LEVEL),
  agentCompact: makeInvoker<'agentCompact'>(AGENT_COMPACT),
  agentSetAutoCompaction: makeInvoker<'agentSetAutoCompaction'>(AGENT_SET_AUTO_COMPACTION),
  agentAbortRetry: makeInvoker<'agentAbortRetry'>(AGENT_ABORT_RETRY),
  agentGetSessionStats: makeInvoker<'agentGetSessionStats'>(AGENT_GET_SESSION_STATS),
  agentGetState: makeInvoker<'agentGetState'>(AGENT_GET_STATE),
  agentFork: makeInvoker<'agentFork'>(AGENT_FORK),
  agentGetForkMessages: makeInvoker<'agentGetForkMessages'>(AGENT_GET_FORK_MESSAGES),
  agentListModels: makeInvoker<'agentListModels'>(AGENT_LIST_MODELS),
  agentListSessions: makeInvoker<'agentListSessions'>(AGENT_LIST_SESSIONS),
  agentLoadSessionMessages: makeInvoker<'agentLoadSessionMessages'>(AGENT_LOAD_SESSION_MESSAGES),
  agentDeleteSession: makeInvoker<'agentDeleteSession'>(AGENT_DELETE_SESSION),
  agentInterrupt: makeInvoker<'agentInterrupt'>(AGENT_INTERRUPT),
  agentDispose: makeInvoker<'agentDispose'>(AGENT_DISPOSE),
  agentSetModel: makeInvoker<'agentSetModel'>(AGENT_SET_MODEL),
  agentGetCommands: makeInvoker<'agentGetCommands'>(AGENT_GET_COMMANDS),
  agentOpenSkillsFolder: makeInvoker<'agentOpenSkillsFolder'>(AGENT_OPEN_SKILLS_FOLDER),
  agentOpenSkillFile: makeInvoker<'agentOpenSkillFile'>(AGENT_OPEN_SKILL_FILE),
  agentDeleteSkillFile: makeInvoker<'agentDeleteSkillFile'>(AGENT_DELETE_SKILL_FILE),
  agentCreateSkill: makeInvoker<'agentCreateSkill'>(AGENT_CREATE_SKILL),
  agentListSkillFiles: makeInvoker<'agentListSkillFiles'>(AGENT_LIST_SKILL_FILES),
  agentCustomModelsGet: makeInvoker<'agentCustomModelsGet'>(AGENT_CUSTOM_MODELS_GET),
  agentCustomModelsSave: makeInvoker<'agentCustomModelsSave'>(AGENT_CUSTOM_MODELS_SAVE),

  // Cross-agent skills
  skillsGetIndex: makeInvoker<'skillsGetIndex'>(SKILLS_GET_INDEX),
  skillsRefresh: makeInvoker<'skillsRefresh'>(SKILLS_REFRESH),
  skillsGetPreview: makeInvoker<'skillsGetPreview'>(SKILLS_GET_PREVIEW),
  skillsInstall: makeInvoker<'skillsInstall'>(SKILLS_INSTALL),
  skillsUninstall: makeInvoker<'skillsUninstall'>(SKILLS_UNINSTALL),
  skillsListInstalled: makeInvoker<'skillsListInstalled'>(SKILLS_LIST_INSTALLED),
  skillsListSaved: makeInvoker<'skillsListSaved'>(SKILLS_LIST_SAVED),
  skillsSave: makeInvoker<'skillsSave'>(SKILLS_SAVE),
  skillsUnsave: makeInvoker<'skillsUnsave'>(SKILLS_UNSAVE),
  skillsListSources: makeInvoker<'skillsListSources'>(SKILLS_LIST_SOURCES),
  skillsAddSource: makeInvoker<'skillsAddSource'>(SKILLS_ADD_SOURCE),
  skillsRemoveSource: makeInvoker<'skillsRemoveSource'>(SKILLS_REMOVE_SOURCE),
  skillsGetToken: makeInvoker<'skillsGetToken'>(SKILLS_GET_TOKEN),
  skillsSetToken: makeInvoker<'skillsSetToken'>(SKILLS_SET_TOKEN),

  // Pi auth / providers
  authListProviders: makeInvoker<'authListProviders'>(AUTH_LIST_PROVIDERS),
  authStatus: makeInvoker<'authStatus'>(AUTH_STATUS),
  authOAuthStart: makeInvoker<'authOAuthStart'>(AUTH_OAUTH_START),
  authOAuthPromptReply: makeInvoker<'authOAuthPromptReply'>(AUTH_OAUTH_PROMPT_REPLY),
  authSaveApiKey: makeInvoker<'authSaveApiKey'>(AUTH_SAVE_API_KEY),
  authDelete: makeInvoker<'authDelete'>(AUTH_DELETE),
} satisfies Partial<ElectronAPI>

contextBridge.exposeInMainWorld('electronAPI', {
  ...invokeForwarders,
  isE2E: process.env.CATE_E2E === '1',
  isPerf: process.env.CATE_PERF === '1',

  /** Set this window's UI zoom factor (Cate chrome only — webview content keeps
   *  its own zoom). Applied per-renderer; each window calls this on mount and
   *  whenever the uiScale setting changes. */
  setUiScale(scale: number): void {
    const clamped = Math.min(2, Math.max(0.5, Number.isFinite(scale) ? scale : 1))
    webFrame.setZoomFactor(clamped)
  },
  // ---------------------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------------------

  onTerminalData(callback: (terminalId: string, data: string) => void): () => void {
    return createIpcListener(TERMINAL_DATA, callback)
  },

  onTerminalExit(callback: (terminalId: string, exitCode: number) => void): () => void {
    return createIpcListener(TERMINAL_EXIT, callback)
  },

  // ---------------------------------------------------------------------------
  // Filesystem
  // ---------------------------------------------------------------------------

  onFsWatchEvent(
    callback: (event: { type: 'create' | 'update' | 'delete'; path: string }) => void,
  ): () => void {
    return createIpcListener(FS_WATCH_EVENT, callback)
  },

  // ---------------------------------------------------------------------------
  // Content search (ripgrep-backed Search view)
  // ---------------------------------------------------------------------------

  onSearchResult(callback: (batch: SearchResultBatch) => void): () => void {
    return createIpcListener(SEARCH_RESULT, callback)
  },

  onSearchDone(callback: (event: SearchDoneEvent) => void): () => void {
    return createIpcListener(SEARCH_DONE, callback)
  },

  // ---------------------------------------------------------------------------
  // Git
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Shell / Process Monitor
  // ---------------------------------------------------------------------------

  onShellActivityUpdate(
    callback: (
      terminalId: string,
      activity: unknown,
      agentName: unknown,
      agentPresent: unknown,
    ) => void,
  ): () => void {
    return createIpcListener(SHELL_ACTIVITY_UPDATE, callback)
  },

  onShellPortsUpdate(callback: (terminalId: string, ports: number[]) => void): () => void {
    return createIpcListener(SHELL_PORTS_UPDATE, callback)
  },

  shellReportAgentScreenState(terminalId: string, state: string): void {
    ipcRenderer.send(SHELL_AGENT_SCREEN_STATE, terminalId, state)
  },

  onAgentScreenStateUpdate(
    callback: (terminalId: string, state: string) => void,
  ): () => void {
    return createIpcListener(SHELL_AGENT_SCREEN_STATE, callback)
  },

  onShellCwdUpdate(callback: (terminalId: string, cwd: string) => void): () => void {
    return createIpcListener(SHELL_CWD_UPDATE, callback)
  },

  onGitBranchUpdate(
    callback: (workspaceId: string, branch: string, isDirty: boolean) => void,
  ): () => void {
    return createIpcListener(GIT_BRANCH_UPDATE, callback)
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

  onSettingsChanged(callback: (key: keyof AppSettings, value: unknown) => void): () => void {
    return createIpcListener(SETTINGS_CHANGED, callback)
  },

  onSettingsReloaded(callback: (settings: AppSettings) => void): () => void {
    return createIpcListener(SETTINGS_RELOADED, callback)
  },

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------


  onSessionFlushSave(callback: () => void): () => void {
    return createIpcListener(SESSION_FLUSH_SAVE, callback)
  },

  sessionFlushSaveDone(): void {
    ipcRenderer.send(SESSION_FLUSH_SAVE_DONE)
  },

  /** Push a partial boot snapshot to main (geometry, theme, etc.). Main
   *  debounces and writes `<userData>/boot.json` for the next cold launch.
   *  Not in the ElectronAPI interface yet, so hand-written rather than folded
   *  into the invokeForwarders table. */
  bootSnapshotWrite(partial: Record<string, unknown>): Promise<void> {
    return ipcRenderer.invoke(BOOT_SNAPSHOT_WRITE, partial)
  },

  // ---------------------------------------------------------------------------
  // App
  // ---------------------------------------------------------------------------

  onOpenPath(callback: (filePath: string) => void): () => void {
    return createIpcListener(APP_OPEN_PATH, callback)
  },

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------

  saveFileDialog(payload?: { defaultName?: string; defaultPath?: string }): Promise<string | null> {
    return ipcRenderer.invoke(DIALOG_SAVE_FILE, payload ?? {})
  },

  promptTerminalLinkOpen(url: string): Promise<'canvas' | 'external' | 'cancel'> {
    return ipcRenderer.invoke(DIALOG_TERMINAL_LINK_OPEN, { url })
  },

  // ---------------------------------------------------------------------------
  // Recent Projects
  // ---------------------------------------------------------------------------

  onNotifyAction(callback: (action: unknown) => void): () => void {
    return createIpcListener(NOTIFY_ACTION, callback)
  },

  // ---------------------------------------------------------------------------
  // Window management
  // ---------------------------------------------------------------------------

  /** Not in the ElectronAPI interface yet, so hand-written rather than folded
   *  into the invokeForwarders table. */
  windowSetTitle(title: string): Promise<void> {
    return ipcRenderer.invoke(WINDOW_SET_TITLE, title)
  },

  // ---------------------------------------------------------------------------
  // Panel transfer (cross-window)
  // ---------------------------------------------------------------------------

  onPanelReceive(callback: (snapshot: unknown) => void): () => void {
    return createIpcListener(PANEL_RECEIVE, callback)
  },

  onPanelWindowDockBack(callback: (payload: { panelWindowId: number; snapshot?: unknown }) => void): () => void {
    return createIpcListener(PANEL_WINDOW_DOCK_BACK, callback)
  },

  // ---------------------------------------------------------------------------
  // Cross-window drag-and-drop
  // ---------------------------------------------------------------------------

  /** Synchronous check: is any Cate BrowserWindow currently in macOS
   *  native fullscreen? Uses the cached push value when available and
   *  falls back to a sync IPC for the authoritative answer. Drag handlers
   *  call this on every mousemove — that's fine at ~60 Hz. */
  isMainWindowFullscreen(): boolean {
    return fullscreenLiveCheck()
  },

  /** Is the calling window currently maximized? Uses the cached push value and
   *  falls back to a sync IPC for the authoritative answer. */
  isWindowMaximized(): boolean {
    return maximizedLiveCheck()
  },
  /** Subscribe to this window's maximize-state changes. Fires with the new
   *  boolean whenever the window is maximized or restored. */
  onWindowMaximizeChange(callback: (isMaximized: boolean) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, value: boolean): void => {
      callback(Boolean(value))
    }
    ipcRenderer.on(WINDOW_MAXIMIZE_STATE, listener)
    return () => { ipcRenderer.removeListener(WINDOW_MAXIMIZE_STATE, listener) }
  },

  onDragEnd(callback: (dragId?: string) => void): () => void {
    return createIpcListener(DRAG_END, callback)
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
    return createIpcListener(WORKSPACE_EXTERNAL_EDIT, callback)
  },

  // ---------------------------------------------------------------------------
  // Dock window management
  // ---------------------------------------------------------------------------

  onDockWindowInit(callback: (payload: unknown) => void): () => void {
    return createIpcListener(DOCK_WINDOW_INIT, callback)
  },

  onDockWindowFlushSync(callback: () => void): () => void {
    return createIpcListener(DOCK_WINDOW_FLUSH_SYNC, callback)
  },

  dockWindowFlushSyncDone(): void {
    ipcRenderer.send(DOCK_WINDOW_FLUSH_SYNC_DONE)
  },

  // ---------------------------------------------------------------------------
  // Cross-window panel discovery
  // ---------------------------------------------------------------------------

  onWindowPanelsChanged(callback: (panels: unknown[]) => void): () => void {
    return createIpcListener(WINDOW_PANELS_CHANGED, callback)
  },

  onRevealPanelInWindow(callback: (panelId: string) => void): () => void {
    return createIpcListener(REVEAL_PANEL_IN_WINDOW, callback)
  },

  // ---------------------------------------------------------------------------
  // Cross-window drag coordination
  // ---------------------------------------------------------------------------

  onCrossWindowDragUpdate(callback: (screenPos: unknown, snapshot: unknown, dragId?: unknown) => void): () => void {
    return createIpcListener(CROSS_WINDOW_DRAG_UPDATE, callback)
  },

  // ---------------------------------------------------------------------------
  // Workspace management (main process is source of truth)
  // ---------------------------------------------------------------------------

  onRuntimeStatus(callback: (event: unknown) => void): () => void {
    return createIpcListener(RUNTIME_STATUS, callback)
  },

  onWorkspaceChanged(callback: (workspaces: unknown[], originWindowId: number | null) => void): () => void {
    return createIpcListener(WORKSPACE_CHANGED, callback)
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

  /** Pop the native submenu of top-level item `index` at window-relative (x, y)
   *  — directly below its label in the title bar. */
  popupAppMenu(index: number, x: number, y: number): Promise<void> {
    return ipcRenderer.invoke(MENU_POPUP_BAR_ITEM, { index, x, y })
  },

  onMenuOpenSettings(callback: () => void): () => void {
    return createIpcListener(MENU_OPEN_SETTINGS, callback)
  },

  onMenuTriggerAction(callback: (action: string) => void): () => void {
    return createIpcListener(MENU_TRIGGER_ACTION, callback)
  },

  onMenuLoadLayout(callback: (name: string) => void): () => void {
    return createIpcListener(MENU_LOAD_LAYOUT, callback)
  },

  onBrowserShortcut(callback: (action: string) => void): () => void {
    return createIpcListener(BROWSER_SHORTCUT, callback)
  },

  // ---------------------------------------------------------------------------
  // Analytics — post-update feedback prompt
  // ---------------------------------------------------------------------------

  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void {
    return createIpcListener(UPDATE_STATUS, callback)
  },

  onFeedbackPrompt(callback: (payload: { fromVersion: string; toVersion: string }) => void): () => void {
    return createIpcListener(ANALYTICS_FEEDBACK_PROMPT, callback)
  },

  dismissFeedback(method: string): void {
    ipcRenderer.send(ANALYTICS_FEEDBACK_DISMISS, method)
  },

  trackLinkClick(link: string): void {
    ipcRenderer.send(ANALYTICS_LINK_CLICK, link)
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

  agentUiResponse(panelId: string, response: unknown): void {
    ipcRenderer.send(AGENT_UI_RESPONSE, panelId, response)
  },

  onAgentEvent(callback: (envelope: unknown) => void): () => void {
    return createIpcListener(AGENT_EVENT, callback)
  },

  // ---------------------------------------------------------------------------
  // Pi auth / providers
  // ---------------------------------------------------------------------------

  onAuthOAuthEvent(callback: (providerId: string, event: unknown) => void): () => void {
    return createIpcListener(AUTH_OAUTH_EVENT, callback)
  },

  onAuthChanged(callback: () => void): () => void {
    return createIpcListener(AUTH_CHANGED, callback)
  },

})
