// =============================================================================
// Settings store and session persistence — backed by electron-store
// electron-store v10 is ESM-only, so we use dynamic import()
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
import { DEFAULT_SETTINGS } from '../shared/types'
import type { AppSettings, SidebarSession, RemoteProjectEntry } from '../shared/types'
import { broadcastToAll } from './windowRegistry'

/** Push saved-layout names to the native Layouts menu. Imported lazily so the
 *  static module graph (and anything that pulls in ./store, e.g. terminal IPC)
 *  doesn't drag in ./menu → ./auto-updater at load time. */
async function pushLayoutNamesToMenu(names: string[]): Promise<void> {
  const { setLayoutNames } = await import('./menu')
  setLayoutNames(names)
}

// ---------------------------------------------------------------------------
// Settings schema: expected key → expected typeof value (or 'array')
// ---------------------------------------------------------------------------
const SETTINGS_SCHEMA: Record<keyof AppSettings, string> = {
  defaultShellPath: 'string',
  warnBeforeQuit: 'boolean',
  activeThemeId: 'string',
  systemLightThemeId: 'string',
  systemDarkThemeId: 'string',
  customThemes: 'array',
  editorFontSize: 'number',
  showMinimap: 'boolean',
  defaultPanelWidth: 'number',
  defaultPanelHeight: 'number',
  zoomSpeed: 'number',
  autoFocusLargestVisibleNode: 'boolean',
  canvasGridStyle: 'string',
  snapToGrid: 'boolean',
  placementPicker: 'boolean',
  terminalFontFamily: 'string',
  terminalFontSize: 'number',
  terminalScrollback: 'number',
  terminalScrollSpeed: 'number',
  terminalContrast: 'number',
  terminalCursorBlink: 'boolean',
  terminalOptionIsMeta: 'boolean',
  autoSuspendIdleTerminals: 'boolean',
  browserHomepage: 'string',
  browserSearchEngine: 'string',
  terminalLinkOpenTarget: 'string',
  sidebarTintOpacity: 'number',
  showFileExplorerOnLaunch: 'boolean',
  fileExclusions: 'array',
  notificationsEnabled: 'boolean',
  notifyOnlyWhenUnfocused: 'boolean',
  crashReportingEnabled: 'boolean',
  usageAnalyticsEnabled: 'boolean',
  telemetryConsentDecided: 'boolean',
  onboardingCompleted: 'boolean',
}

// Settings that open windows react to live (via onSettingsChanged). The
// SETTINGS_CHANGED broadcast is scoped to these so routine edits — font size,
// zoom speed, etc. — don't wake every window/explorer on each change.
const LIVE_REACTIVE_SETTINGS = new Set<keyof AppSettings>(['fileExclusions'])

/** Safely merge only known, type-correct keys from a parsed object into the settings cache. */
function mergeValidatedSettings(target: Partial<AppSettings>, source: Record<string, unknown>): void {
  for (const key of Object.keys(SETTINGS_SCHEMA) as Array<keyof AppSettings>) {
    if (!(key in source)) continue
    const val = source[key]
    const expected = SETTINGS_SCHEMA[key]
    if (expected === 'array') {
      if (!Array.isArray(val)) { log.warn('Settings schema mismatch: %s expected array, got %s', key, typeof val); continue }
    } else {
      if (typeof val !== expected) { log.warn('Settings schema mismatch: %s expected %s, got %s', key, expected, typeof val); continue }
    }
    ;(target as Record<string, unknown>)[key as string] = val
  }
}

// Lazy-loaded store instance (ESM dynamic import)
let storeInstance: any = null

/** If `config.json` is present but not valid JSON, copy it aside before
 *  electron-store (with `clearInvalidConfig`) silently overwrites it with
 *  defaults — so a user's corrupt settings are preserved for support/recovery
 *  rather than lost. Best-effort; never throws. */
function backupConfigIfCorrupt(): void {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'config.json')
    if (!fsSync.existsSync(cfgPath)) return
    const raw = fsSync.readFileSync(cfgPath, 'utf-8')
    try {
      JSON.parse(raw)
    } catch {
      const backupPath = `${cfgPath}.corrupt-${Date.now()}`
      fsSync.copyFileSync(cfgPath, backupPath)
      log.error('config.json is corrupt; backed up to %s and resetting to defaults', backupPath)
    }
  } catch (err) {
    log.warn('Corrupt-config check failed: %O', err)
  }
}

async function getStore(): Promise<any> {
  if (storeInstance) return storeInstance
  const { default: Store } = await import('electron-store')
  // Preserve a corrupt config before clearInvalidConfig wipes it.
  backupConfigIfCorrupt()
  // clearInvalidConfig: a corrupt config.json resets to defaults instead of
  // throwing on construction — which would otherwise reject every settings
  // IPC call (settings, recent projects, layouts) for the whole session.
  // projectName is set explicitly so the store never depends on Electron
  // app-name detection (electron-store still keys the file off the userData
  // cwd, so this doesn't change the config path — it only removes a failure
  // mode in non-standard runtimes/tests).
  const opts = { defaults: DEFAULT_SETTINGS, clearInvalidConfig: true, projectName: 'cate' }
  try {
    storeInstance = new Store<AppSettings>(opts)
  } catch (err) {
    // clearInvalidConfig only covers JSON SyntaxErrors. For anything else
    // (e.g. an unreadable/locked file), move the bad file aside and retry so
    // settings keep working rather than failing for the entire session.
    log.error('electron-store construction failed; quarantining config and retrying: %O', err)
    try {
      const cfgPath = path.join(app.getPath('userData'), 'config.json')
      if (fsSync.existsSync(cfgPath)) fsSync.renameSync(cfgPath, `${cfgPath}.broken-${Date.now()}`)
    } catch (mvErr) {
      log.warn('Failed to quarantine config.json: %O', mvErr)
    }
    storeInstance = new Store<AppSettings>(opts)
  }
  // Hydrate sync cache from the freshly loaded store
  try {
    Object.assign(settingsCache, storeInstance.store as Partial<AppSettings>)
  } catch { /* noop */ }
  return storeInstance
}

// ---------------------------------------------------------------------------
// Synchronous settings cache
// Loaded at startup directly from the electron-store JSON file so that the
// main process can read settings before the async ESM store is initialized
// (e.g. inside BrowserWindow constructors). Kept in sync on every SETTINGS_SET.
// ---------------------------------------------------------------------------
const settingsCache: Partial<AppSettings> = {}

/** Read settings from the on-disk electron-store JSON file (sync). */
export function loadSettingsSyncFromDisk(): void {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'config.json')
    if (!fsSync.existsSync(cfgPath)) return
    const raw = fsSync.readFileSync(cfgPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      mergeValidatedSettings(settingsCache, parsed as Record<string, unknown>)
    }
  } catch (err) {
    log.warn('Sync settings load failed: %O', err)
  }
}

export function getSettingSync<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return (settingsCache[key] ?? DEFAULT_SETTINGS[key]) as AppSettings[K]
}

/** Persist a settings patch from the main process — updates the sync cache
 *  immediately and writes through to the on-disk store. Used by main-driven
 *  flows like first-run telemetry consent. */
export async function setSettingsFromMain(patch: Partial<AppSettings>): Promise<void> {
  // Update the sync cache first so any immediate getSettingSync() reflects it.
  for (const [k, v] of Object.entries(patch)) {
    ;(settingsCache as Record<string, unknown>)[k] = v
  }
  try {
    const store = await getStore()
    for (const [k, v] of Object.entries(patch)) store.set(k, v as never)
  } catch (err) {
    log.warn('[settings] setSettingsFromMain write failed: %O', err)
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
  // Settings
  ipcMain.handle(SETTINGS_GET, async (_event, key: keyof AppSettings) => {
    const store = await getStore()
    return store.get(key)
  })

  ipcMain.handle(
    SETTINGS_SET,
    async (_event, key: keyof AppSettings, value: unknown) => {
      const store = await getStore()
      store.set(key, value as never)
      ;(settingsCache as Record<string, unknown>)[key as string] = value
      // Notify all windows so live-reactive settings (e.g. file exclusions)
      // can update without a relaunch. Scoped to keys that actually have live
      // listeners so routine setting changes don't churn every window.
      if (LIVE_REACTIVE_SETTINGS.has(key)) {
        broadcastToAll(SETTINGS_CHANGED, key, value)
      }
      // Rebuild active fs watchers so their ignore globs match the new
      // exclusions (dynamic import avoids a static store<->filesystem cycle).
      if (key === 'fileExclusions') {
        try {
          const { refreshWatcherIgnores } = await import('./ipc/filesystem')
          refreshWatcherIgnores()
        } catch (err) {
          log.warn('Watcher ignore refresh failed: %O', err)
        }
      }
      // Live-toggle Sentry when the user flips the crash-reporting setting,
      // so they don't need to relaunch for the change to take effect.
      if (key === 'crashReportingEnabled') {
        try {
          const { setCrashReportingEnabled } = await import('./sentry')
          setCrashReportingEnabled(value !== false)
        } catch (err) {
          log.warn('Sentry live-toggle failed: %O', err)
        }
      }
    },
  )

  ipcMain.handle(SETTINGS_GET_ALL, async () => {
    const store = await getStore()
    return store.store
  })

  ipcMain.handle(SETTINGS_RESET, async (_event, key?: keyof AppSettings) => {
    const store = await getStore()
    if (key) {
      store.reset(key)
    } else {
      store.clear()
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

  // Recent Projects
  ipcMain.handle(RECENT_PROJECTS_GET, async () => {
    const store = await getStore()
    return store.get('recentProjects', []) as string[]
  })

  ipcMain.handle(RECENT_PROJECTS_ADD, async (_event, projectPath: string) => {
    const store = await getStore()
    const existing: string[] = store.get('recentProjects', []) as string[]
    const filtered = existing.filter((p) => p !== projectPath)
    const updated = [projectPath, ...filtered].slice(0, 10)
    store.set('recentProjects', updated)
  })

  // Drop a project from the recent list (issue #220): closing a workspace should
  // forget the project so it doesn't reappear on next launch and re-enter the
  // deferred-restore path. Without this the only way to forget a project was to
  // hand-edit config.json.
  ipcMain.handle(RECENT_PROJECTS_REMOVE, async (_event, projectPath: string) => {
    const store = await getStore()
    const existing: string[] = store.get('recentProjects', []) as string[]
    store.set('recentProjects', existing.filter((p) => p !== projectPath))
  })

  // Sidebar session (workspace order + active workspace, keyed by root path)
  ipcMain.handle(SIDEBAR_SESSION_GET, async () => {
    const store = await getStore()
    return store.get('sidebarSession', null) as SidebarSession | null
  })

  ipcMain.handle(SIDEBAR_SESSION_SET, async (_event, session: SidebarSession) => {
    const store = await getStore()
    store.set('sidebarSession', session)
  })

  // Remote projects (cate-companion:// workspaces): full restore snapshot +
  // reconnect info, since their tree lives on a companion and can't use the
  // local .cate/ project-state files.
  ipcMain.handle(REMOTE_PROJECTS_GET, async () => {
    const store = await getStore()
    return store.get('remoteProjects', []) as RemoteProjectEntry[]
  })

  ipcMain.handle(REMOTE_PROJECTS_SET, async (_event, entries: RemoteProjectEntry[]) => {
    const store = await getStore()
    store.set('remoteProjects', Array.isArray(entries) ? entries : [])
  })

  // Layouts
  ipcMain.handle(LAYOUT_SAVE, async (_event, name: string, layout: unknown) => {
    const store = await getStore()
    const layouts = (store.get('layouts') as Record<string, unknown>) || {}
    layouts[name] = layout
    store.set('layouts', layouts)
    void pushLayoutNamesToMenu(Object.keys(layouts))
  })

  ipcMain.handle(LAYOUT_LIST, async () => {
    const store = await getStore()
    const layouts = (store.get('layouts') as Record<string, unknown>) || {}
    return Object.keys(layouts)
  })

  ipcMain.handle(LAYOUT_LOAD, async (_event, name: string) => {
    const store = await getStore()
    const layouts = (store.get('layouts') as Record<string, unknown>) || {}
    return layouts[name] || null
  })

  ipcMain.handle(LAYOUT_DELETE, async (_event, name: string) => {
    const store = await getStore()
    const layouts = (store.get('layouts') as Record<string, unknown>) || {}
    delete layouts[name]
    store.set('layouts', layouts)
    void pushLayoutNamesToMenu(Object.keys(layouts))
  })

  // Seed the native Layouts menu with whatever is already saved.
  void getStore().then((store) => {
    const layouts = (store.get('layouts') as Record<string, unknown>) || {}
    return pushLayoutNamesToMenu(Object.keys(layouts))
  }).catch(() => { /* menu just stays empty until first save */ })
}
