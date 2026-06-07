// =============================================================================
// IPC channel name constants for main <-> renderer communication
// =============================================================================

// Terminal
export const TERMINAL_CREATE = 'terminal:create'
export const TERMINAL_WRITE = 'terminal:write'
export const TERMINAL_RESIZE = 'terminal:resize'
export const TERMINAL_KILL = 'terminal:kill'
export const TERMINAL_DATA = 'terminal:data' // main -> renderer
export const TERMINAL_EXIT = 'terminal:exit' // main -> renderer
export const TERMINAL_GET_CWD = 'terminal:getCwd'
export const TERMINAL_LOG_READ = 'terminal:logRead'
export const TERMINAL_SCROLLBACK_SAVE = 'terminal:scrollbackSave'
export const TERMINAL_SET_VISIBILITY = 'terminal:setVisibility'

// Filesystem
export const FS_READ_FILE = 'fs:readFile'
export const FS_WRITE_FILE = 'fs:writeFile'
export const FS_READ_DIR = 'fs:readDir'
export const FS_WATCH_START = 'fs:watchStart'
export const FS_WATCH_STOP = 'fs:watchStop'
export const FS_WATCH_EVENT = 'fs:watchEvent' // main -> renderer
export const FS_STAT = 'fs:stat'
export const FS_DELETE = 'fs:delete'
export const FS_RENAME = 'fs:rename'
export const FS_MKDIR = 'fs:mkdir'
export const FS_COPY = 'fs:copy'
export const FS_IMPORT_ENTRIES = 'fs:import-entries'
export const FS_SEARCH = 'fs:search'
export const FS_READ_BINARY = 'fs:readBinary'

// Content search (ripgrep-backed Search view)
export const SEARCH_START = 'search:start'    // renderer -> main (invoke, returns searchId)
export const SEARCH_CANCEL = 'search:cancel'  // renderer -> main (invoke)
export const SEARCH_RESULT = 'search:result'  // main -> renderer (streamed batch)
export const SEARCH_DONE = 'search:done'      // main -> renderer (terminal event)

// Shell utilities
export const SHELL_SHOW_IN_FOLDER = 'shell:showInFolder'

// Git
export const GIT_IS_REPO = 'git:isRepo'
export const GIT_INIT = 'git:init'
export const GIT_LS_FILES = 'git:lsFiles'
export const GIT_BRANCH_UPDATE = 'git:branch-update'         // main -> renderer
export const GIT_MONITOR_START = 'git:monitor-start'
export const GIT_MONITOR_STOP = 'git:monitor-stop'
export const GIT_STATUS = 'git:status'
export const GIT_DIFF = 'git:diff'
export const GIT_STAGE = 'git:stage'
export const GIT_UNSTAGE = 'git:unstage'
export const GIT_COMMIT = 'git:commit'
export const GIT_WORKTREE_LIST = 'git:worktreeList'
export const GIT_WORKTREE_ADD = 'git:worktreeAdd'
export const GIT_WORKTREE_REMOVE = 'git:worktreeRemove'
export const GIT_WORKTREE_PRUNE = 'git:worktreePrune'
export const GIT_WORKTREE_STATUS = 'git:worktreeStatus'
export const GIT_WORKTREE_MERGE_TO = 'git:worktreeMergeTo'
export const GIT_WORKTREE_ADD_FROM_PR = 'git:worktreeAddFromPr'
export const GIT_WORKTREE_UPDATE_FROM = 'git:worktreeUpdateFrom'
export const GIT_CREATE_PR = 'git:createPR'
export const GIT_PR_STATUS = 'git:prStatus'
export const GIT_PR_LIST = 'git:prList'
export const GIT_PUSH = 'git:push'
export const GIT_PULL = 'git:pull'
export const GIT_FETCH = 'git:fetch'
export const GIT_LOG = 'git:log'
export const GIT_BRANCH_LIST = 'git:branchList'
export const GIT_BRANCH_CREATE = 'git:branchCreate'
export const GIT_BRANCH_DELETE = 'git:branchDelete'
export const GIT_CHECKOUT = 'git:checkout'
export const GIT_DIFF_STAGED = 'git:diffStaged'
export const GIT_STASH = 'git:stash'
export const GIT_STASH_POP = 'git:stashPop'
export const GIT_DISCARD_FILE = 'git:discardFile'

// Shell / Process Monitor
export const SHELL_REGISTER_TERMINAL = 'shell:registerTerminal'
export const SHELL_UNREGISTER_TERMINAL = 'shell:unregisterTerminal'
export const SHELL_ACTIVITY_UPDATE = 'shell:activityUpdate' // main -> renderer
export const SHELL_PORTS_UPDATE = 'shell:ports-update'       // main -> renderer
export const SHELL_CWD_UPDATE = 'shell:cwd-update'           // main -> renderer
// Renderer (where the xterm buffer lives) reports the agent's screen-derived
// state up to main; main re-broadcasts so every window's sidebar agrees.
export const SHELL_AGENT_SCREEN_STATE = 'shell:agentScreenState'

// Settings
export const SETTINGS_GET = 'settings:get'
export const SETTINGS_SET = 'settings:set'
export const SETTINGS_GET_ALL = 'settings:getAll'
export const SETTINGS_RESET = 'settings:reset'
export const SETTINGS_CHANGED = 'settings:changed' // main -> renderer (broadcast)
// Grant the calling window access to settings.json and return its path so the
// renderer can open it in an editor panel (VS Code "Open Settings (JSON)").
export const SETTINGS_OPEN_IN_EDITOR = 'settings:openInEditor'
// Broadcast when settings.json was edited externally (the user editing the
// file directly). Carries the full settings object so renderers merge live.
export const SETTINGS_RELOADED = 'settings:reloaded' // main -> renderer (broadcast)

// UI state — transient cosmetic UI placement (minimap position/size) persisted
// to <userData>/ui-state.json. Kept out of settings.json so the user-facing
// settings file stays focused on preferences.
export const UI_STATE_GET_ALL = 'uiState:getAll' // renderer -> main
export const UI_STATE_SET = 'uiState:set'        // renderer -> main

// Session
export const SESSION_FLUSH_SAVE = 'session:flushSave' // main -> renderer
export const SESSION_FLUSH_SAVE_DONE = 'session:flushSaveDone' // renderer -> main

// Project-local workspace persistence (.cate/)
export const PROJECT_STATE_SAVE = 'project:stateSave'     // renderer -> main
export const PROJECT_STATE_LOAD = 'project:stateLoad'     // renderer -> main
// Fired when a project's workspace.json is found to differ on disk from what
// Cate last wrote (edited externally) — or back in sync after a reload.
export const WORKSPACE_EXTERNAL_EDIT = 'project:externalEdit' // main -> renderer
// Renderer tells main the user declined the reload prompt — resume saving so
// the current in-app layout overwrites the external edit.
export const WORKSPACE_EXTERNAL_EDIT_DISMISS = 'project:externalEditDismiss' // renderer -> main

// Boot snapshot — a tiny JSON file (geometry, theme, last workspace id, native
// tabs flag) written by the renderer whenever the relevant settings change.
// Read synchronously at launch by the main process to construct the
// BrowserWindow with the correct bounds + background color, eliminating the
// white-flash before the renderer mounts.
export const BOOT_SNAPSHOT_WRITE = 'boot:snapshotWrite' // renderer -> main

// App
/** Main -> renderer: user dropped a folder on the dock icon (or opened one
 *  via OS "Open With..."). Renderer opens it as a new workspace. */
export const APP_OPEN_PATH = 'app:openPath'

// Analytics — post-update feedback prompt
// Main -> renderer: show the modal. Payload: { fromVersion, toVersion }
export const ANALYTICS_FEEDBACK_PROMPT = 'analytics:feedbackPrompt'
// Renderer -> main: user submitted feedback. Payload: { rating: 1-5, comment? }
export const ANALYTICS_FEEDBACK_SUBMIT = 'analytics:feedbackSubmit'
// Renderer -> main: user dismissed the modal without submitting.
export const ANALYTICS_FEEDBACK_DISMISS = 'analytics:feedbackDismiss'
// Renderer -> main: user interacted with the feedback modal (first star click or textarea focus).
export const ANALYTICS_FEEDBACK_ENGAGED = 'analytics:feedbackEngaged'
// Renderer -> main: pull-based check for pending feedback (returns payload or null).
export const ANALYTICS_FEEDBACK_GET_PENDING = 'analytics:feedbackGetPending'
// Renderer -> main: track a promo link click (Product Hunt, GitHub, newsletter).
export const ANALYTICS_LINK_CLICK = 'analytics:linkClick'
// Renderer -> main: first-run telemetry consent decision.
// Payload: { crashReporting: boolean, usageAnalytics: boolean }
export const TELEMETRY_SET_CONSENT = 'telemetry:setConsent'
// Renderer -> main: a feature was used (anonymous usage signal). Payload:
// { feature: string, props?: Record<string, string|number|boolean> }
export const ANALYTICS_TRACK_USAGE = 'analytics:trackUsage'

// Open an external URL in the user's default browser (renderer -> main).
export const OPEN_EXTERNAL_URL = 'open:externalUrl'


// Menu actions (main -> renderer)
export const MENU_OPEN_SETTINGS = 'menu:openSettings'
/** Generic menu-action dispatch — main sends a MenuActionId and the focused
 *  renderer runs the matching handler (via useShortcuts). */
export const MENU_TRIGGER_ACTION = 'menu:triggerAction'
/** Load a named saved layout — main sends the layout name and the focused
 *  renderer restores it (replacing the workspace). */
export const MENU_LOAD_LAYOUT = 'menu:loadLayout'
/** Create-panel dispatch routed to a *main* window. Sent when a panel-creation
 *  shortcut/menu item fires from a detached dock/panel window (which has no
 *  canvas): main forwards it to the workspace's main window so the new panel
 *  lands on the canvas. Payload carries the action and the originating
 *  workspace id. */
export const MENU_CREATE_PANEL = 'menu:createPanel'

/** Browser navigation shortcut (main -> renderer). Sent when a webview guest
 *  swallows a browser key (Cmd+R/[/]/L) via before-input-event, or from the
 *  Browser menu. The focused BrowserPanel acts on it. */
export const BROWSER_SHORTCUT = 'browser:shortcut'

/** Configure the proxy for a browser panel's Electron session partition
 *  (renderer -> main). Awaited before the panel mounts its <webview> so the
 *  first request already goes through the proxy. */
export const BROWSER_SET_PROXY = 'browser:setProxy'

// Native context menu (renderer -> main)
export const MENU_SHOW_CONTEXT = 'menu:showContext'

// Dialog
export const DIALOG_OPEN_FOLDER = 'dialog:openFolder'
export const DIALOG_OPEN_IMAGE = 'dialog:openImage'
export const DIALOG_SAVE_FILE = 'dialog:saveFile'
export const DIALOG_CONFIRM_UNSAVED = 'dialog:confirmUnsaved'
export const DIALOG_CONFIRM_CLOSE_TERMINAL = 'dialog:confirmCloseTerminal'
export const DIALOG_CONFIRM_CLOSE_CANVAS = 'dialog:confirmCloseCanvas'
export const DIALOG_CONFIRM_IMPORT = 'dialog:confirmImport'
export const DIALOG_CONFIRM_RELOAD_WORKSPACE = 'dialog:confirmReloadWorkspace'
export const DIALOG_TERMINAL_LINK_OPEN = 'dialog:terminalLinkOpen'

// Canvas wallpaper — read an arbitrary image file as a data URL (the file is
// usually outside the workspace allowed roots, so it bypasses the fs IPC).
export const CANVAS_READ_BACKGROUND_IMAGE = 'canvas:readBackgroundImage'

// Panel window: renderer pushes an updated PanelState snapshot to main so
// the windowRegistry's panel meta (used by session persistence and the
// panel-window list) stays current — needed after Save-As turns an
// untitled buffer into a real file inside a detached panel window.
export const PANEL_WINDOW_SYNC_META = 'panel:windowSyncMeta'

// Recent Projects
export const RECENT_PROJECTS_GET = 'recent-projects:get'
export const RECENT_PROJECTS_ADD = 'recent-projects:add'
export const RECENT_PROJECTS_REMOVE = 'recent-projects:remove'

// Sidebar session (persisted workspace order + active workspace, by root path)
export const SIDEBAR_SESSION_GET = 'sidebar-session:get'
export const SIDEBAR_SESSION_SET = 'sidebar-session:set'

// Remote projects (persisted restore snapshots + reconnect info for
// cate-companion:// workspaces, which can't use the local .cate/ files)
export const REMOTE_PROJECTS_GET = 'remote-projects:get'
export const REMOTE_PROJECTS_SET = 'remote-projects:set'

// Layouts
export const LAYOUT_SAVE = 'layout:save'
export const LAYOUT_LIST = 'layout:list'
export const LAYOUT_LOAD = 'layout:load'
export const LAYOUT_DELETE = 'layout:delete'

// Notifications
export const NOTIFY_OS = 'notify:os'
export const NOTIFY_ACTION = 'notify:action' // main -> renderer (OS notification clicked)

// Window management
export const WINDOW_SET_TITLE = 'window:setTitle'
// Custom window controls (frameless Windows/Linux chrome). Each is per-window —
// the handler resolves the calling window from the IPC event sender.
export const WINDOW_MINIMIZE = 'window:minimize'              // renderer -> main
export const WINDOW_TOGGLE_MAXIMIZE = 'window:toggleMaximize' // renderer -> main
export const WINDOW_CLOSE = 'window:close'                    // renderer -> main
export const WINDOW_IS_MAXIMIZED = 'window:isMaximized'       // renderer -> main (sync pull)
export const WINDOW_MAXIMIZE_STATE = 'window:maximizeState'   // main -> renderer (push)

// Panel transfer (cross-window)
export const PANEL_TRANSFER = 'panel:transfer'
export const PANEL_RECEIVE = 'panel:receive'       // main -> renderer
export const PANEL_TRANSFER_ACK = 'panel:transferAck'

// Panel window queries (session persistence)
export const PANEL_WINDOWS_LIST = 'panel:windowsList'
export const PANEL_WINDOW_DOCK_BACK = 'panel:dockBack'  // renderer -> main (double-click title bar)
export const PANEL_WINDOW_SYNC_PTY = 'panel:windowSyncPty' // renderer -> main: register panelId -> ptyId for calling panel window

// Cross-window drag-and-drop
export const DRAG_START = 'drag:start'
export const DRAG_DETACH = 'drag:detach'
export const DRAG_END = 'drag:end'                 // main -> renderer

// Fullscreen state — main broadcasts every time a window enters/leaves native
// fullscreen. Renderers cache the value so drag handlers can synchronously
// refuse cross-window detach while fullscreen is active.
export const WINDOW_FULLSCREEN_STATE = 'window:fullscreenState' // main -> renderer

// Dock window management
export const DOCK_WINDOW_INIT = 'dock:windowInit'           // main -> renderer
export const DOCK_WINDOW_SYNC_STATE = 'dock:windowSyncState' // renderer -> main
export const DOCK_WINDOWS_LIST = 'dock:windowsList'          // renderer -> main
export const DOCK_WINDOW_RESTORE = 'dock:windowRestore'      // renderer -> main
// Final awaited sync from a dock window before quit reads listDockWindows().
export const DOCK_WINDOW_FLUSH_SYNC = 'dock:windowFlushSync' // main -> renderer
export const DOCK_WINDOW_FLUSH_SYNC_DONE = 'dock:windowFlushSyncDone' // renderer -> main

// Cross-window drag coordination
export const CROSS_WINDOW_DRAG_START = 'crossDrag:start'       // renderer -> main
export const CROSS_WINDOW_DRAG_UPDATE = 'crossDrag:update'     // main -> renderer
export const CROSS_WINDOW_DRAG_DROP = 'crossDrag:drop'         // renderer -> main
export const CROSS_WINDOW_DRAG_CANCEL = 'crossDrag:cancel'     // renderer -> main
export const CROSS_WINDOW_DRAG_RESOLVE = 'crossDrag:resolve'   // renderer -> main (mouseup — resolve drop or create window)

// Webview
export const WEBVIEW_SCREENSHOT = 'webview:screenshot'
export const NATIVE_FILE_DRAG = 'native:fileDrag'

// Page capture
export const CAPTURE_PAGE = 'capture-page'

// Pi agent (renderer <-> main)
export const AGENT_CREATE = 'agent:create'           // renderer -> main
export const AGENT_PROMPT = 'agent:prompt'           // renderer -> main
export const AGENT_INTERRUPT = 'agent:interrupt'     // renderer -> main
export const AGENT_DISPOSE = 'agent:dispose'         // renderer -> main
export const AGENT_SET_MODEL = 'agent:setModel'      // renderer -> main
export const AGENT_GET_COMMANDS = 'agent:getCommands' // renderer -> main (skills + prompts + extension cmds)
export const AGENT_TOOL_DECISION = 'agent:toolDecision' // renderer -> main (allow/deny pending tool call)
export const AGENT_EVENT = 'agent:event'             // main -> renderer (forwarded pi event)
export const AGENT_TOOL_REQUEST = 'agent:toolRequest' // main -> renderer (approval needed)
export const AGENT_OPEN_SKILLS_FOLDER = 'agent:openSkillsFolder' // renderer -> main
export const AGENT_OPEN_SKILL_FILE = 'agent:openSkillFile' // renderer -> main
export const AGENT_DELETE_SKILL_FILE = 'agent:deleteSkillFile' // renderer -> main
export const AGENT_CREATE_SKILL = 'agent:createSkill' // renderer -> main
export const AGENT_LIST_SKILL_FILES = 'agent:listSkillFiles' // renderer -> main

// Pi agent — extended RPC surface
export const AGENT_STEER = 'agent:steer'                       // renderer -> main
export const AGENT_FOLLOW_UP = 'agent:followUp'                // renderer -> main
export const AGENT_SET_THINKING_LEVEL = 'agent:setThinkingLevel' // renderer -> main
export const AGENT_COMPACT = 'agent:compact'                   // renderer -> main
export const AGENT_SET_AUTO_COMPACTION = 'agent:setAutoCompaction'
export const AGENT_SET_AUTO_RETRY = 'agent:setAutoRetry'
export const AGENT_ABORT_RETRY = 'agent:abortRetry'
export const AGENT_GET_SESSION_STATS = 'agent:getSessionStats'
export const AGENT_GET_STATE = 'agent:getState'
export const AGENT_EXPORT_HTML = 'agent:exportHtml'
export const AGENT_NEW_SESSION = 'agent:newSession'
export const AGENT_SWITCH_SESSION = 'agent:switchSession'
export const AGENT_FORK = 'agent:fork'
export const AGENT_CLONE = 'agent:clone'
export const AGENT_GET_FORK_MESSAGES = 'agent:getForkMessages'
export const AGENT_GET_LAST_ASSISTANT_TEXT = 'agent:getLastAssistantText'
export const AGENT_SET_SESSION_NAME = 'agent:setSessionName'
export const AGENT_GET_MESSAGES = 'agent:getMessages'
export const AGENT_BASH = 'agent:bash'                         // renderer -> main
export const AGENT_ABORT_BASH = 'agent:abortBash'
export const AGENT_SET_STEERING_MODE = 'agent:setSteeringMode'
export const AGENT_SET_FOLLOW_UP_MODE = 'agent:setFollowUpMode'
export const AGENT_LIST_MODELS = 'agent:listModels'
export const AGENT_UI_RESPONSE = 'agent:uiResponse'            // renderer -> main (reply to extension_ui_request)

// Disk-backed pi sessions (~/.pi/agent/sessions/<encoded-cwd>/*.jsonl)
export const AGENT_LIST_SESSIONS = 'agent:listSessions'         // renderer -> main
export const AGENT_LOAD_SESSION_MESSAGES = 'agent:loadSessionMessages' // renderer -> main
export const AGENT_DELETE_SESSION = 'agent:deleteSession'       // renderer -> main

// Pi extension marketplace
export const AGENT_MARKETPLACE_LIST = 'agent:marketplaceList'             // renderer -> main
export const AGENT_MARKETPLACE_LIST_INSTALLED = 'agent:marketplaceListInstalled' // renderer -> main
export const AGENT_MARKETPLACE_INSTALL = 'agent:marketplaceInstall'       // renderer -> main
export const AGENT_MARKETPLACE_UNINSTALL = 'agent:marketplaceUninstall'   // renderer -> main

// Custom OpenAI-compatible provider (pi models.json)
export const AGENT_CUSTOM_MODELS_GET = 'agent:customModelsGet'   // renderer -> main
export const AGENT_CUSTOM_MODELS_SAVE = 'agent:customModelsSave' // renderer -> main

// Skills (cross-agent skill manager)
export const SKILLS_GET_INDEX = 'skills:getIndex'             // renderer -> main (merged catalog)
export const SKILLS_REFRESH = 'skills:refresh'               // renderer -> main (bust caches)
export const SKILLS_GET_PREVIEW = 'skills:getPreview'         // renderer -> main (fetch SKILL.md body)
export const SKILLS_INSTALL = 'skills:install'               // renderer -> main
export const SKILLS_UNINSTALL = 'skills:uninstall'           // renderer -> main
export const SKILLS_LIST_INSTALLED = 'skills:listInstalled'   // renderer -> main (workspace manifest)
export const SKILLS_LIST_SAVED = 'skills:listSaved'           // renderer -> main (userData library)
export const SKILLS_SAVE = 'skills:save'                     // renderer -> main (fetch + cache to library)
export const SKILLS_UNSAVE = 'skills:unsave'                 // renderer -> main (drop from library)
export const SKILLS_LIST_SOURCES = 'skills:listSources'       // renderer -> main
export const SKILLS_ADD_SOURCE = 'skills:addSource'           // renderer -> main
export const SKILLS_REMOVE_SOURCE = 'skills:removeSource'     // renderer -> main
export const SKILLS_GET_TOKEN = 'skills:getToken'             // renderer -> main
export const SKILLS_SET_TOKEN = 'skills:setToken'             // renderer -> main

// Pi auth / providers
export const AUTH_LIST_PROVIDERS = 'auth:listProviders'
export const AUTH_STATUS = 'auth:status'
export const AUTH_OAUTH_START = 'auth:oauthStart'
export const AUTH_OAUTH_PROMPT_REPLY = 'auth:oauthPromptReply' // renderer -> main
export const AUTH_OAUTH_EVENT = 'auth:oauthEvent'              // main -> renderer
export const AUTH_CHANGED = 'auth:changed'                    // main -> renderer (broadcast)
export const AUTH_SAVE_API_KEY = 'auth:saveApiKey'
export const AUTH_DELETE = 'auth:delete'

// Workspace management (main process is source of truth)
export const WORKSPACE_CREATE = 'workspace:create'
export const WORKSPACE_UPDATE = 'workspace:update'
export const WORKSPACE_REMOVE = 'workspace:remove'
export const WORKSPACE_CHANGED = 'workspace:changed' // main -> renderer (broadcast)

// Companion connections (remote / WSL backends)
export const COMPANION_CONNECT = 'companion:connect'       // renderer -> main
export const COMPANION_ENSURE = 'companion:ensure'         // renderer -> main (reconnect from a stored connection)
export const COMPANION_LIST = 'companion:list'             // renderer -> main
export const COMPANION_WSL_DISTROS = 'companion:wsl-distros' // renderer -> main (list installed WSL distros)
export const COMPANION_SSH_HOSTS = 'companion:ssh-hosts'   // renderer -> main (host aliases from ~/.ssh/config)
export const COMPANION_INSTALL = 'companion:install'       // renderer -> main (explicit clean install + connect)
export const COMPANION_DELETE = 'companion:delete'         // renderer -> main (rm -rf the host install, keep saved auth)
export const COMPANION_STATUS = 'companion:status'         // main -> renderer (broadcast)
export const COMPANION_LOCAL_STATUS = 'companion:local-status' // renderer -> main (current LOCAL phase, seeds the loading blocker)


// Performance profiler (only active under CATE_PERF=1)
export const PERF_GET = 'perf:get' // renderer -> main (pull latest resource snapshot)
