// =============================================================================
// Settings store and session persistence — backed by electron-store
// electron-store v10 is ESM-only, so we use dynamic import()
// =============================================================================

import { ipcMain, app } from 'electron'
import log from './logger'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import {
  SETTINGS_GET,
  SETTINGS_SET,
  SETTINGS_GET_ALL,
  SETTINGS_RESET,
  SESSION_SAVE,
  SESSION_LOAD,
  BOOT_SNAPSHOT_WRITE,
  RECENT_PROJECTS_GET,
  RECENT_PROJECTS_ADD,
  LAYOUT_SAVE,
  LAYOUT_LIST,
  LAYOUT_LOAD,
  LAYOUT_DELETE,
} from '../shared/ipc-channels'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { AppSettings, SessionSnapshot, MultiWorkspaceSession } from '../shared/types'
import { addAllowedRoot } from './ipc/pathValidation'
import { hydrateSessionTrust } from './sessionTrust'
import { resolveTrustedWorkspaceRoot } from './workspaceRoots'

// ---------------------------------------------------------------------------
// Settings schema: expected key → expected typeof value (or 'array')
// ---------------------------------------------------------------------------
const SETTINGS_SCHEMA: Record<keyof AppSettings, string> = {
  defaultShellPath: 'string',
  warnBeforeQuit: 'boolean',
  nativeTabs: 'boolean',
  appearanceMode: 'string',
  editorFontSize: 'number',
  showMinimap: 'boolean',
  defaultPanelWidth: 'number',
  defaultPanelHeight: 'number',
  zoomSpeed: 'number',
  autoFocusLargestVisibleNode: 'boolean',
  terminalFontFamily: 'string',
  terminalFontSize: 'number',
  terminalScrollback: 'number',
  terminalCustomThemes: 'array',
  defaultTerminalTheme: 'string',
  browserHomepage: 'string',
  browserSearchEngine: 'string',
  autoOpenUrlsFromTerminal: 'string',
  sidebarTintOpacity: 'number',
  showFileExplorerOnLaunch: 'boolean',
  notificationsEnabled: 'boolean',
  notifyOnlyWhenUnfocused: 'boolean',
  crashReportingEnabled: 'boolean',
}

/** Safely merge only known, type-correct keys from a parsed object into the settings cache. */
function mergeValidatedSettings(target: Partial<AppSettings>, source: Record<string, unknown>): void {
  for (const key of Object.keys(SETTINGS_SCHEMA) as Array<keyof AppSettings>) {
    if (!(key in source)) continue
    let val = source[key]
    const expected = SETTINGS_SCHEMA[key]
    // Migration: autoOpenUrlsFromTerminal was a boolean prior to v0.4.5.
    // Translate legacy values so users keep their previous behavior.
    if (key === 'autoOpenUrlsFromTerminal' && typeof val === 'boolean') {
      val = val ? 'auto' : 'off'
    }
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

async function getStore(): Promise<any> {
  if (storeInstance) return storeInstance
  const { default: Store } = await import('electron-store')
  storeInstance = new Store<AppSettings>({ defaults: DEFAULT_SETTINGS })
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
  nativeTabs?: boolean
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

function getSessionPath(): string {
  return path.join(app.getPath('userData'), 'Sessions', 'session.json')
}

// ---------------------------------------------------------------------------
// Write serialization — ensures only one session write runs at a time
// ---------------------------------------------------------------------------
let writeQueue: Promise<void> = Promise.resolve()
function serialized(fn: () => Promise<void>): Promise<void> {
  writeQueue = writeQueue.then(fn, fn)
  return writeQueue
}

// ---------------------------------------------------------------------------
// Last-saved session cache (for sync fallback on quit)
// ---------------------------------------------------------------------------
let lastSavedSessionJson: string | null = null

export function getLastSavedSession(): string | null {
  return lastSavedSessionJson
}

// ---------------------------------------------------------------------------
// Atomic write: write to .tmp, rotate .bak, rename .tmp → target
// ---------------------------------------------------------------------------
async function atomicWriteSession(sessionPath: string, json: string): Promise<void> {
  const dir = path.dirname(sessionPath)
  const tmpPath = sessionPath + '.tmp'
  const bakPath = sessionPath + '.bak'

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(tmpPath, json, 'utf-8')
  // Guard against silent write failures clobbering a good session.
  const tmpStat = await fs.stat(tmpPath)
  if (tmpStat.size === 0) {
    await fs.unlink(tmpPath).catch(() => {})
    throw new Error('tmp session file is empty after write')
  }
  await fs.rename(sessionPath, bakPath).catch(() => {}) // OK if no previous file
  await fs.rename(tmpPath, sessionPath)
}

/** Synchronous variant — only used as last-resort in will-quit */
export function saveSessionSync(json: string | null): void {
  if (!json) return
  const sessionPath = getSessionPath()
  const dir = path.dirname(sessionPath)
  const tmpPath = sessionPath + '.tmp'
  const bakPath = sessionPath + '.bak'

  try {
    fsSync.mkdirSync(dir, { recursive: true })
    fsSync.writeFileSync(tmpPath, json, 'utf-8')
    // Verify the tmp file was actually written before clobbering the previous
    // session — a zero-byte tmp from a silent write failure must not destroy
    // the existing good session.
    const tmpStat = fsSync.statSync(tmpPath)
    if (tmpStat.size === 0) {
      throw new Error('tmp session file is empty after write')
    }
    try { fsSync.renameSync(sessionPath, bakPath) } catch { /* OK */ }
    fsSync.renameSync(tmpPath, sessionPath)
  } catch (err) {
    log.warn('Sync session save failed: %O', err)
    try { fsSync.unlinkSync(tmpPath) } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// Session validation
// ---------------------------------------------------------------------------
function isValidSession(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  if (obj.version === 2 && Array.isArray(obj.workspaces)) return true
  return false
}

// ---------------------------------------------------------------------------
// Session pruning — removes stale dockPanels entries to bound session size
// ---------------------------------------------------------------------------
function pruneSession(session: MultiWorkspaceSession): MultiWorkspaceSession {
  return {
    ...session,
    workspaces: session.workspaces.map((ws) => {
      if (!ws.dockPanels || !ws.dockState?.locations) return ws
      const knownKeys = new Set(Object.keys(ws.dockState.locations))
      const prunedPanels: typeof ws.dockPanels = {}
      for (const [k, v] of Object.entries(ws.dockPanels)) {
        if (knownKeys.has(k)) prunedPanels[k] = v
      }
      return { ...ws, dockPanels: prunedPanels }
    }),
  }
}

/** Try to read and parse a session file, returning null on any failure */
async function tryLoadSession(filePath: string): Promise<unknown | null> {
  try {
    const data = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(data)
    if (isValidSession(parsed)) return parsed
    log.warn('Session file failed validation: %s', filePath)
    return null
  } catch {
    return null
  }
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

  // Session persistence (atomic writes with backup rotation)
  ipcMain.handle(SESSION_SAVE, async (_event, snapshot: MultiWorkspaceSession) => {
    // Prune stale dockPanels entries before serialising to bound session size
    const pruned = isValidSession(snapshot) ? pruneSession(snapshot) : snapshot
    const json = JSON.stringify(pruned, null, 2)
    lastSavedSessionJson = json
    await serialized(async () => {
      const sessionPath = getSessionPath()
      await atomicWriteSession(sessionPath, json)
      log.debug('Session saved to %s', sessionPath)
    })
  })

  // Boot snapshot — renderer pushes geometry/theme/etc. updates here. The
  // write is debounced internally; this handler returns immediately.
  ipcMain.handle(BOOT_SNAPSHOT_WRITE, async (_event, partial: Partial<BootSnapshot>) => {
    if (partial && typeof partial === 'object') {
      writeBootSnapshot(partial)
    }
  })

  ipcMain.handle(SESSION_LOAD, async (): Promise<SessionSnapshot | null> => {
    const sessionPath = getSessionPath()
    const tmpPath = sessionPath + '.tmp'
    const bakPath = sessionPath + '.bak'

    // Fallback chain: session.json → .tmp (crash mid-rename) → .bak (last known good)
    const candidates = [
      { path: sessionPath, label: 'session.json' },
      { path: tmpPath, label: 'session.json.tmp' },
      { path: bakPath, label: 'session.json.bak' },
    ]

    for (const candidate of candidates) {
      const result = await tryLoadSession(candidate.path)
      if (result) {
        const { sanitizedSession, acceptedRoots } = await hydrateSessionTrust(
          result as SessionSnapshot | MultiWorkspaceSession,
          resolveTrustedWorkspaceRoot,
        )
        for (const root of acceptedRoots) addAllowedRoot(root)
        if (candidate.path !== sessionPath) {
          log.warn('Recovered session from %s', candidate.label)
        } else {
          log.debug('Session loaded from %s', sessionPath)
        }
        return sanitizedSession as SessionSnapshot
      }
    }

    log.debug('No valid session file found')
    return null
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

  // Layouts
  ipcMain.handle(LAYOUT_SAVE, async (_event, name: string, layout: unknown) => {
    const store = await getStore()
    const layouts = (store.get('layouts') as Record<string, unknown>) || {}
    layouts[name] = layout
    store.set('layouts', layouts)
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
  })

}
