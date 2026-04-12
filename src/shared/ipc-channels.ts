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
export const TERMINAL_LOG_DELETE = 'terminal:logDelete'
export const TERMINAL_SCROLLBACK_SAVE = 'terminal:scrollbackSave'

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

// Shell utilities
export const SHELL_SHOW_IN_FOLDER = 'shell:showInFolder'

// HTTP (main process, no CORS)
export const HTTP_FETCH = 'http:fetch'

// Git
export const GIT_IS_REPO = 'git:isRepo'
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
export const SHELL_WHICH = 'shell:which'
export const SHELL_REGISTER_TERMINAL = 'shell:registerTerminal'
export const SHELL_UNREGISTER_TERMINAL = 'shell:unregisterTerminal'
export const SHELL_ACTIVITY_UPDATE = 'shell:activityUpdate' // main -> renderer
export const SHELL_PORTS_UPDATE = 'shell:ports-update'       // main -> renderer
export const SHELL_CWD_UPDATE = 'shell:cwd-update'           // main -> renderer
export const SHELL_KILL_PROCESS = 'shell:killProcess'         // renderer -> main (kill child processes, keep terminal)

// Settings
export const SETTINGS_GET = 'settings:get'
export const SETTINGS_SET = 'settings:set'
export const SETTINGS_GET_ALL = 'settings:getAll'
export const SETTINGS_RESET = 'settings:reset'

// Session
export const SESSION_SAVE = 'session:save'
export const SESSION_LOAD = 'session:load'
export const SESSION_CLEAR = 'session:clear'
export const SESSION_FLUSH_SAVE = 'session:flushSave' // main -> renderer
export const SESSION_FLUSH_SAVE_DONE = 'session:flushSaveDone' // renderer -> main

// App
export const APP_GET_PATH = 'app:getPath'

// Menu actions (main -> renderer)
export const MENU_OPEN_SETTINGS = 'menu:openSettings'
/** Generic menu-action dispatch — main sends a MenuActionId and the focused
 *  renderer runs the matching handler (via useShortcuts). */
export const MENU_TRIGGER_ACTION = 'menu:triggerAction'

// Native context menu (renderer -> main)
export const MENU_SHOW_CONTEXT = 'menu:showContext'

// Dialog
export const DIALOG_OPEN_FOLDER = 'dialog:openFolder'
export const DIALOG_SAVE_FILE = 'dialog:saveFile'
export const DIALOG_CONFIRM_UNSAVED = 'dialog:confirmUnsaved'
export const DIALOG_CONFIRM_CLOSE_CANVAS = 'dialog:confirmCloseCanvas'

// Recent Projects
export const RECENT_PROJECTS_GET = 'recent-projects:get'
export const RECENT_PROJECTS_ADD = 'recent-projects:add'

// Layouts
export const LAYOUT_SAVE = 'layout:save'
export const LAYOUT_LIST = 'layout:list'
export const LAYOUT_LOAD = 'layout:load'
export const LAYOUT_DELETE = 'layout:delete'

// MCP Server Management
export const MCP_SPAWN = 'mcp:spawn'
export const MCP_STOP = 'mcp:stop'
export const MCP_TEST = 'mcp:test'
export const MCP_STATUS_UPDATE = 'mcp:statusUpdate'  // main -> renderer

// Notifications
export const NOTIFY_OS = 'notify:os'
export const NOTIFY_ACTION = 'notify:action' // main -> renderer (OS notification clicked)

// Window management
export const WINDOW_CREATE = 'window:create'
export const WINDOW_GET_ID = 'window:getId'
export const WINDOW_GET_TYPE = 'window:getType'
export const WINDOW_SET_TITLE = 'window:setTitle'

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

// Token usage tracking
export const USAGE_GET_SUMMARY = 'usage:getSummary'
export const USAGE_GET_PROJECT = 'usage:getProject'
export const USAGE_UPDATE = 'usage:update'

// Workspace management (main process is source of truth)
export const WORKSPACE_LIST = 'workspace:list'
export const WORKSPACE_CREATE = 'workspace:create'
export const WORKSPACE_UPDATE = 'workspace:update'
export const WORKSPACE_REMOVE = 'workspace:remove'
export const WORKSPACE_GET = 'workspace:get'
export const WORKSPACE_CHANGED = 'workspace:changed' // main -> renderer (broadcast)

