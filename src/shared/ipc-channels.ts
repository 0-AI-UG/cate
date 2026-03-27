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

// Git
export const GIT_IS_REPO = 'git:isRepo'
export const GIT_LS_FILES = 'git:lsFiles'
export const GIT_BRANCH_UPDATE = 'git:branch-update'         // main -> renderer
export const GIT_MONITOR_START = 'git:monitor-start'
export const GIT_MONITOR_STOP = 'git:monitor-stop'

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

// App
export const APP_PLAY_SOUND = 'app:playSound'
export const APP_GET_PATH = 'app:getPath'

// Dialog
export const DIALOG_OPEN_FOLDER = 'dialog:openFolder'
