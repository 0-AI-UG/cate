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

// Filesystem
export const FS_READ_FILE = 'fs:readFile'
export const FS_WRITE_FILE = 'fs:writeFile'
export const FS_READ_DIR = 'fs:readDir'
export const FS_WATCH_START = 'fs:watchStart'
export const FS_WATCH_STOP = 'fs:watchStop'
export const FS_WATCH_EVENT = 'fs:watchEvent' // main -> renderer
export const FS_STAT = 'fs:stat'

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

// Shell / Process Monitor
export const SHELL_REGISTER_TERMINAL = 'shell:registerTerminal'
export const SHELL_UNREGISTER_TERMINAL = 'shell:unregisterTerminal'
export const SHELL_ACTIVITY_UPDATE = 'shell:activityUpdate' // main -> renderer
export const SHELL_PORTS_UPDATE = 'shell:ports-update'       // main -> renderer
export const SHELL_CWD_UPDATE = 'shell:cwd-update'           // main -> renderer

// Settings
export const SETTINGS_GET = 'settings:get'
export const SETTINGS_SET = 'settings:set'
export const SETTINGS_GET_ALL = 'settings:getAll'
export const SETTINGS_RESET = 'settings:reset'

// Session
export const SESSION_SAVE = 'session:save'
export const SESSION_LOAD = 'session:load'
export const SESSION_CLEAR = 'session:clear'

// App
export const APP_PLAY_SOUND = 'app:playSound'
export const APP_GET_PATH = 'app:getPath'

// Menu actions (main -> renderer)
export const MENU_OPEN_SETTINGS = 'menu:openSettings'

// Dialog
export const DIALOG_OPEN_FOLDER = 'dialog:openFolder'
export const DIALOG_SAVE_FILE = 'dialog:saveFile'

// Recent Projects
export const RECENT_PROJECTS_GET = 'recent-projects:get'
export const RECENT_PROJECTS_ADD = 'recent-projects:add'

// Layouts
export const LAYOUT_SAVE = 'layout:save'
export const LAYOUT_LIST = 'layout:list'
export const LAYOUT_LOAD = 'layout:load'
export const LAYOUT_DELETE = 'layout:delete'

// Window (Task 23: Multi-Window Support)
export const WINDOW_DETACH_PANEL = 'window:detachPanel'

// Plugin / Extension System (Task 25)
export const PLUGIN_LIST = 'plugin:list'
