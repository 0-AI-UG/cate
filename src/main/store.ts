// =============================================================================
// Settings store and session persistence.
//
// AppSettings live in settings.json (see ./settingsFile). The workspace/session
// state that used to sit in the opaque electron-store config.json — recent
// projects, sidebar session, remote workspaces, saved layouts — now lives in
// dedicated hand-editable JSON files (see ./workspaceStateStore). electron-store
// is no longer used; config.json is migrated once on startup and removed.
// =============================================================================

import { ipcMain, app, BrowserWindow, nativeTheme } from 'electron'
import log from './logger'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import {
  SETTINGS_GET,
  SETTINGS_SET,
  SETTINGS_GET_ALL,
  SETTINGS_RESET,
  SETTINGS_CHANGED,
  SETTINGS_OPEN_IN_EDITOR,
  SETTINGS_RELOADED,
  BOOT_SNAPSHOT_WRITE,
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
} from '../shared/ipc-channels'
import type { AppSettings, SidebarSession, RemoteProjectEntry } from '../shared/types'
import { broadcastToAll } from './windowRegistry'
import {
  loadSettingsSync,
  getSetting as getSettingFromFile,
  getAllSettings,
  setSetting as setSettingInFile,
  resetSetting as resetSettingInFile,
  resetAllSettings,
  ensureSettingsFile,
  startWatching as startSettingsWatch,
} from './settingsFile'
import {
  getRecentProjects,
  addRecentProject,
  removeRecentProject,
  getSidebarSession,
  setSidebarSession,
  getRemoteProjects,
  setRemoteProjects,
  saveLayout,
  listLayoutNames,
  loadLayout,
  deleteLayout,
  startWatchingWorkspaceState,
  migrateLegacyConfig,
} from './workspaceStateStore'
import { grantFileAccess } from './ipc/pathValidation'
import { recordPersistentGrant } from './grantedPathStore'

/** Push saved-layout names to the native Layouts menu. Imported lazily so the
 *  static module graph (and anything that pulls in ./store, e.g. terminal IPC)
 *  doesn't drag in ./menu → ./auto-updater at load time. */
async function pushLayoutNamesToMenu(names: string[]): Promise<void> {
  try {
    const { setLayoutNames } = await import('./menu')
    setLayoutNames(names)
  } catch (err) {
    log.warn('Layout menu update failed: %O', err)
  }
}

// Settings that open windows react to live (via onSettingsChanged). The
// SETTINGS_CHANGED broadcast is scoped to these so routine edits — font size,
// zoom speed, etc. — don't wake every window/explorer on each change.
const LIVE_REACTIVE_SETTINGS = new Set<keyof AppSettings>(['fileExclusions'])

/**
 * Apply the main-process side effects of a single settings change. Shared by
 * the renderer-driven SETTINGS_SET path and the external-file-edit watcher so a
 * value changed by hand-editing settings.json behaves exactly like one changed
 * through the UI (live file-exclusion refresh, Sentry toggle, live broadcast).
 */
async function applySettingSideEffect(key: keyof AppSettings, value: unknown): Promise<void> {
  // Notify all windows so live-reactive settings (e.g. file exclusions) can
  // update without a relaunch. Scoped to keys that actually have live listeners
  // so routine setting changes don't churn every window.
  if (LIVE_REACTIVE_SETTINGS.has(key)) {
    broadcastToAll(SETTINGS_CHANGED, key, value)
  }
  // Rebuild active fs watchers so their ignore globs match the new exclusions
  // (dynamic import avoids a static store<->filesystem cycle). Also push the new
  // set to the LOCAL companion daemon, which captured its exclusions once at
  // launch — without this the daemon's file tree / file-name search wouldn't
  // honor the change until a restart. Only LOCAL: remote daemons get their
  // config at connect time (out of scope here). Imports are dynamic to avoid
  // store<->filesystem and store<->companion cycles.
  if (key === 'fileExclusions') {
    try {
      const { refreshWatcherIgnores } = await import('./ipc/filesystem')
      refreshWatcherIgnores()
    } catch (err) {
      log.warn('Watcher ignore refresh failed: %O', err)
    }
    try {
      const { companions } = await import('./companion/companionManager')
      const { LOCAL_COMPANION_ID } = await import('./companion/locator')
      if (companions.has(LOCAL_COMPANION_ID)) {
        companions.resolve(LOCAL_COMPANION_ID).setExclusions(value as string[]).catch(() => {})
      }
    } catch (err) {
      log.warn('Companion exclusions forward failed: %O', err)
    }
  }
  // Push the idle-suspend toggle to the LOCAL companion daemon, which gated its
  // idle scanner once at launch — toggling otherwise needs a restart.
  if (key === 'autoSuspendIdleTerminals') {
    try {
      const { companions } = await import('./companion/companionManager')
      const { LOCAL_COMPANION_ID } = await import('./companion/locator')
      if (companions.has(LOCAL_COMPANION_ID)) {
        companions.resolve(LOCAL_COMPANION_ID).setIdleSuspend(value !== false).catch(() => {})
      }
    } catch (err) {
      log.warn('Companion idle-suspend forward failed: %O', err)
    }
  }
  // The wallpaper image is copied into managed app data (see DIALOG_OPEN_IMAGE).
  // Whenever the path changes — a replacement, a clear (''), a reset, or a
  // hand-edit pointing elsewhere — drop any managed copy that is no longer the
  // current one so the directory doesn't accumulate orphaned images.
  if (key === 'canvasBackgroundImagePath') {
    try {
      const { pruneCanvasBackgrounds } = await import('./canvasBackgroundStore')
      pruneCanvasBackgrounds(typeof value === 'string' ? value : '')
    } catch (err) {
      log.warn('Canvas background prune failed: %O', err)
    }
  }
  // Live-toggle Sentry when the crash-reporting setting flips, so the change
  // takes effect without a relaunch.
  if (key === 'crashReportingEnabled') {
    try {
      const { setCrashReportingEnabled } = await import('./sentry')
      setCrashReportingEnabled(value !== false)
    } catch (err) {
      log.warn('Sentry live-toggle failed: %O', err)
    }
  }
  // Re-point the auto-updater channel when the beta opt-in flips, and re-check
  // immediately. Dynamic import keeps ./auto-updater (and electron-updater) out
  // of ./store's static graph — auto-updater imports ./store, so a static import
  // here would form a cycle.
  if (key === 'betaUpdatesEnabled') {
    try {
      const { setBetaUpdatesEnabled } = await import('./auto-updater')
      setBetaUpdatesEnabled(value !== false)
    } catch (err) {
      log.warn('Beta-updates live-toggle failed: %O', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Synchronous settings access — settings live in settings.json, loaded
// synchronously at startup (see ./settingsFile) so the main process can read
// them before any window is constructed. These thin re-exports keep the
// historical `./store` import surface for existing callers.
// ---------------------------------------------------------------------------

/** Load settings.json synchronously (migrating from the legacy config.json on
 *  first run). Safe to call once at startup. */
export function loadSettingsSyncFromDisk(): void {
  loadSettingsSync()
}

export function getSettingSync<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return getSettingFromFile(key)
}

/** Persist a settings patch from the main process — updates settings.json
 *  (the source of truth) and runs each key's side effects. Used by main-driven
 *  flows like first-run telemetry consent. getSettingSync() reflects the change
 *  immediately since settingsFile holds the authoritative in-memory copy. */
export async function setSettingsFromMain(patch: Partial<AppSettings>): Promise<void> {
  for (const [k, v] of Object.entries(patch)) {
    const key = k as keyof AppSettings
    if (setSettingInFile(key, v as never)) {
      await applySettingSideEffect(key, v)
    }
  }
}

// ---------------------------------------------------------------------------
// Boot snapshot — minimal JSON read synchronously at launch so the main
// process can construct the BrowserWindow with saved bounds + theme color
// before the much larger settings / session JSON is parsed. Lives at
// `<userData>/boot.json`.
// ---------------------------------------------------------------------------

export interface BootSnapshot {
  geometry?: { x: number; y: number; width: number; height: number }
  theme?: string
  backgroundColor?: string
  // Desired native window appearance for the active theme. Drives
  // nativeTheme.themeSource so native chrome (menus, scrollbars, the window
  // backdrop) matches the theme's dark/light instead of the OS. 'system' tracks
  // the OS.
  appearance?: 'dark' | 'light' | 'system'
  lastWorkspaceId?: string
}

function getBootSnapshotPath(): string {
  return path.join(app.getPath('userData'), 'boot.json')
}

/** Read the boot snapshot synchronously. Returns null on any failure. */
export function readBootSnapshot(): BootSnapshot | null {
  try {
    const p = getBootSnapshotPath()
    if (!fsSync.existsSync(p)) return null
    const raw = fsSync.readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as BootSnapshot
    }
    return null
  } catch (err) {
    log.warn('Boot snapshot read failed: %O', err)
    return null
  }
}

// Debounced trailing-edge writer — coalesces bursts of setting changes into
// a single 250 ms flush so we never thrash the disk on rapid setting updates.
let bootSnapshotPending: BootSnapshot | null = null
let bootSnapshotTimer: ReturnType<typeof setTimeout> | null = null
const BOOT_SNAPSHOT_DEBOUNCE_MS = 250

async function flushBootSnapshot(): Promise<void> {
  bootSnapshotTimer = null
  if (!bootSnapshotPending) return
  const next = { ...(readBootSnapshot() ?? {}), ...bootSnapshotPending }
  bootSnapshotPending = null
  try {
    const p = getBootSnapshotPath()
    await fs.mkdir(path.dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(next), 'utf-8')
    await fs.rename(tmp, p)
  } catch (err) {
    log.warn('Boot snapshot write failed: %O', err)
  }
}

/** Merge `partial` into the current boot snapshot and flush after a short debounce. */
export function writeBootSnapshot(partial: Partial<BootSnapshot>): void {
  bootSnapshotPending = { ...(bootSnapshotPending ?? {}), ...partial }
  if (bootSnapshotTimer) return
  bootSnapshotTimer = setTimeout(() => { void flushBootSnapshot() }, BOOT_SNAPSHOT_DEBOUNCE_MS)
}


export function registerHandlers(): void {
  // Settings — backed by settings.json (see ./settingsFile). The file is the
  // source of truth; these handlers read/write it and fan out side effects.
  ipcMain.handle(SETTINGS_GET, async (_event, key: keyof AppSettings) => {
    return getSettingFromFile(key)
  })

  ipcMain.handle(
    SETTINGS_SET,
    async (_event, key: keyof AppSettings, value: unknown) => {
      if (!setSettingInFile(key, value as never)) return
      await applySettingSideEffect(key, value)
    },
  )

  ipcMain.handle(SETTINGS_GET_ALL, async () => {
    return getAllSettings()
  })

  ipcMain.handle(SETTINGS_RESET, async (_event, key?: keyof AppSettings) => {
    if (key) {
      resetSettingInFile(key)
      await applySettingSideEffect(key, getSettingFromFile(key))
    } else {
      resetAllSettings()
    }
  })

  // Grant the calling window read+write access to settings.json and return its
  // path so the renderer can open it in an editor panel (VS Code's "Open
  // Settings (JSON)"). The path is computed here in main — never supplied by the
  // renderer — so this does not widen the renderer's filesystem reach beyond
  // this one app-owned file. The grant is persisted so a restored editor panel
  // pointing at settings.json keeps working across launches.
  ipcMain.handle(SETTINGS_OPEN_IN_EDITOR, async (event) => {
    const filePath = await ensureSettingsFile()
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return filePath
    try {
      const safePath = await grantFileAccess(win.id, filePath)
      await recordPersistentGrant(safePath)
      // Grant every currently-open window too, so a panel dragged to another
      // window keeps access (mirrors the Save-As grant fan-out).
      for (const other of BrowserWindow.getAllWindows()) {
        if (other.id === win.id || other.isDestroyed()) continue
        try { await grantFileAccess(other.id, safePath) } catch { /* best effort */ }
      }
      return safePath
    } catch (err) {
      log.warn('[SETTINGS_OPEN_IN_EDITOR] grant failed: %O', err)
      return filePath
    }
  })

  // React to external edits of settings.json (user editing the file directly):
  // broadcast the full settings so renderers merge live, and run the same
  // per-key side effects as a UI change.
  startSettingsWatch((next, changedKeys) => {
    broadcastToAll(SETTINGS_RELOADED, next)
    for (const key of changedKeys) {
      void applySettingSideEffect(key, next[key])
    }
  })

  // Boot snapshot — renderer pushes geometry/theme/etc. updates here. The
  // write is debounced internally; this handler returns immediately.
  ipcMain.handle(BOOT_SNAPSHOT_WRITE, async (event, partial: Partial<BootSnapshot>) => {
    if (!partial || typeof partial !== 'object') return
    writeBootSnapshot(partial)
    // The boot snapshot only colors the *next* cold launch. Apply the same
    // background to the live window now so the OS-drawn chrome (native title
    // bar / traffic-light region, and the backdrop shown mid-resize) tracks
    // theme changes immediately — for built-in, new, and user-generated themes
    // alike — instead of lagging until the next relaunch. Scoped to the sender
    // so each window (main + detached panel/dock) updates its own chrome.
    if (typeof partial.backgroundColor === 'string') {
      try {
        BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(partial.backgroundColor)
      } catch (err) {
        log.warn('Live window background update failed: %O', err)
      }
    }
    // Drive the app-wide native appearance from the active theme so the macOS
    // native title bar (native-tabs mode) follows the theme's dark/light. It's
    // global (NSApplication.appearance), so one assignment covers every window.
    if (partial.appearance === 'dark' || partial.appearance === 'light' || partial.appearance === 'system') {
      try {
        nativeTheme.themeSource = partial.appearance
      } catch (err) {
        log.warn('Native appearance update failed: %O', err)
      }
    }
  })

  // Workspace/session state files (recent projects, sidebar, remote workspaces,
  // layouts) — migrate the legacy config.json once, then watch the new files for
  // external edits (re-pushing the native Layouts menu when layouts.json is
  // hand-edited). Migration runs after settings.json was seeded at startup, so
  // removing config.json here is safe.
  migrateLegacyConfig()
  startWatchingWorkspaceState((names) => { void pushLayoutNamesToMenu(names) })

  // Drop any orphaned managed wallpaper copies (e.g. from a crash mid-replace),
  // keeping only the one the current setting points at.
  void import('./canvasBackgroundStore')
    .then(({ pruneCanvasBackgrounds }) => pruneCanvasBackgrounds(getSettingFromFile('canvasBackgroundImagePath')))
    .catch((err) => log.warn('Canvas background startup prune failed: %O', err))

  // Recent Projects
  ipcMain.handle(RECENT_PROJECTS_GET, async () => {
    return getRecentProjects()
  })

  ipcMain.handle(RECENT_PROJECTS_ADD, async (_event, projectPath: string) => {
    addRecentProject(projectPath)
  })

  // Drop a project from the recent list (issue #220): closing a workspace should
  // forget the project so it doesn't reappear on next launch and re-enter the
  // deferred-restore path. Without this the only way to forget a project was to
  // hand-edit the recent-projects file.
  ipcMain.handle(RECENT_PROJECTS_REMOVE, async (_event, projectPath: string) => {
    removeRecentProject(projectPath)
  })

  // Sidebar session (workspace order + active workspace, keyed by root path)
  ipcMain.handle(SIDEBAR_SESSION_GET, async () => {
    return getSidebarSession()
  })

  ipcMain.handle(SIDEBAR_SESSION_SET, async (_event, session: SidebarSession) => {
    setSidebarSession(session)
  })

  // Remote projects (cate-companion:// workspaces): full restore snapshot +
  // reconnect info, since their tree lives on a companion and can't use the
  // local .cate/ project-state files.
  ipcMain.handle(REMOTE_PROJECTS_GET, async () => {
    return getRemoteProjects()
  })

  ipcMain.handle(REMOTE_PROJECTS_SET, async (_event, entries: RemoteProjectEntry[]) => {
    setRemoteProjects(entries)
  })

  // Layouts
  ipcMain.handle(LAYOUT_SAVE, async (_event, name: string, layout: unknown) => {
    const names = saveLayout(name, layout)
    void pushLayoutNamesToMenu(names)
  })

  ipcMain.handle(LAYOUT_LIST, async () => {
    return listLayoutNames()
  })

  ipcMain.handle(LAYOUT_LOAD, async (_event, name: string) => {
    return loadLayout(name)
  })

  ipcMain.handle(LAYOUT_DELETE, async (_event, name: string) => {
    const names = deleteLayout(name)
    void pushLayoutNamesToMenu(names)
  })

  // Seed the native Layouts menu with whatever is already saved.
  void pushLayoutNamesToMenu(listLayoutNames())
}
