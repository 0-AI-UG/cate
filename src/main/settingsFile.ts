// =============================================================================
// settingsFile — owns the user-editable settings.json file.
//
// VS Code model: a dedicated `<userData>/settings.json` is the source of truth
// for AppSettings. It holds ONLY user settings (the other electron-store keys —
// recentProjects, layouts, remoteProjects, sidebarSession — stay in config.json).
//
//   - Loaded synchronously at startup so the main process can read settings
//     before any window is constructed.
//   - On first run it is seeded from the legacy electron-store config.json so
//     existing users keep their settings.
//   - Writes are debounced + atomic (tmp + rename), pretty-printed so the file
//     stays comfortably hand-editable.
//   - A chokidar watcher detects EXTERNAL edits (the user editing the file in an
//     editor) and reports the changed keys. Our own programmatic writes are
//     suppressed by content comparison so we never react to our own changes.
// =============================================================================

import { app } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { watch, type FSWatcher } from 'chokidar'
import log from './logger'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { AppSettings } from '../shared/types'

const SETTINGS_FILENAME = 'settings.json'

// ---------------------------------------------------------------------------
// Settings schema: expected key → expected typeof value (or 'array'). The
// single authority for which keys are valid settings and what shape they take;
// shared with the on-disk merge so a malformed hand-edit can't poison state.
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
  betaUpdatesEnabled: 'boolean',
}

const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMA) as Array<keyof AppSettings>

/** Merge only known, type-correct keys from a parsed object into `target`. */
function mergeValidatedSettings(target: Partial<AppSettings>, source: Record<string, unknown>): void {
  for (const key of SETTINGS_KEYS) {
    if (!(key in source)) continue
    const val = source[key]
    const expected = SETTINGS_SCHEMA[key]
    if (expected === 'array') {
      if (!Array.isArray(val)) { log.warn('Settings schema mismatch: %s expected array, got %s', key, typeof val); continue }
    } else if (typeof val !== expected) {
      log.warn('Settings schema mismatch: %s expected %s, got %s', key, expected, typeof val); continue
    }
    ;(target as Record<string, unknown>)[key as string] = val
  }
}

export function isSettingsKey(key: string): key is keyof AppSettings {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Authoritative in-memory settings: DEFAULT_SETTINGS overlaid with whatever the
// file holds. Always complete (every key present), so reads never miss a key.
let current: AppSettings = { ...DEFAULT_SETTINGS }
let loaded = false

// The exact string we last wrote to disk. The watcher compares the file's
// content against this to ignore the change event our own write produces.
let lastWrittenContent = ''

let watcher: FSWatcher | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null
const WRITE_DEBOUNCE_MS = 150

export function getSettingsFilePath(): string {
  return path.join(app.getPath('userData'), SETTINGS_FILENAME)
}

function legacyConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

/** Serialize the current settings as the canonical, hand-editable JSON text. */
function serialize(settings: AppSettings): string {
  return JSON.stringify(settings, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// Load (synchronous — runs at startup before any window is created)
// ---------------------------------------------------------------------------

/**
 * Load settings synchronously from settings.json. On first run (file absent)
 * the legacy electron-store config.json is migrated in and settings.json is
 * written so it exists for the watcher and for hand-editing. Idempotent.
 */
export function loadSettingsSync(): void {
  if (loaded) return
  const filePath = getSettingsFilePath()
  try {
    if (fsSync.existsSync(filePath)) {
      const raw = fsSync.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        mergeValidatedSettings(current, parsed as Record<string, unknown>)
      }
      lastWrittenContent = raw
      loaded = true
      return
    }
  } catch (err) {
    log.warn('[settingsFile] Sync load failed, falling back to migration/defaults: %O', err)
  }

  // First run (or unreadable file): migrate settings out of the legacy
  // electron-store config.json, then seed settings.json from the result.
  try {
    const cfg = legacyConfigPath()
    if (fsSync.existsSync(cfg)) {
      const parsed = JSON.parse(fsSync.readFileSync(cfg, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        mergeValidatedSettings(current, parsed as Record<string, unknown>)
        log.info('[settingsFile] Migrated settings from legacy config.json')
      }
    }
  } catch (err) {
    log.warn('[settingsFile] Legacy config migration failed: %O', err)
  }

  loaded = true
  writeSync()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return (current[key] ?? DEFAULT_SETTINGS[key]) as AppSettings[K]
}

export function getAllSettings(): AppSettings {
  return { ...current }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Write settings.json synchronously (used during first-run seeding). */
function writeSync(): void {
  const content = serialize(current)
  try {
    const p = getSettingsFilePath()
    fsSync.mkdirSync(path.dirname(p), { recursive: true })
    fsSync.writeFileSync(p, content, 'utf-8')
    lastWrittenContent = content
  } catch (err) {
    log.warn('[settingsFile] Sync write failed: %O', err)
  }
}

async function flushWrite(): Promise<void> {
  writeTimer = null
  const content = serialize(current)
  // Record before the write so a watcher event racing the rename still matches.
  lastWrittenContent = content
  try {
    const p = getSettingsFilePath()
    await fs.mkdir(path.dirname(p), { recursive: true })
    const tmp = p + '.tmp'
    await fs.writeFile(tmp, content, 'utf-8')
    await fs.rename(tmp, p)
  } catch (err) {
    log.warn('[settingsFile] Write failed: %O', err)
  }
}

function scheduleWrite(): void {
  if (writeTimer) return
  writeTimer = setTimeout(() => { void flushWrite() }, WRITE_DEBOUNCE_MS)
}

/** Update one setting, validating its type. No-op (returns false) on a type
 *  mismatch or unknown key. Persists via a debounced atomic write. */
export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): boolean {
  if (!isSettingsKey(key)) return false
  const expected = SETTINGS_SCHEMA[key]
  if (expected === 'array' ? !Array.isArray(value) : typeof value !== expected) {
    log.warn('[settingsFile] Rejected set for %s: expected %s', String(key), expected)
    return false
  }
  current[key] = value
  scheduleWrite()
  return true
}

/** Reset one key to its default and persist. */
export function resetSetting(key: keyof AppSettings): void {
  // Indexing with a union key widens the assignment target to `never`; the
  // value is the matching default, so a structured cast is safe.
  ;(current as unknown as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key]
  scheduleWrite()
}

/** Reset every setting to defaults and persist. */
export function resetAllSettings(): void {
  current = { ...DEFAULT_SETTINGS }
  scheduleWrite()
}

/** Ensure settings.json exists on disk (writing current settings if not), and
 *  return its absolute path. Used before opening the file in an editor. */
export async function ensureSettingsFile(): Promise<string> {
  const p = getSettingsFilePath()
  try {
    await fs.access(p)
  } catch {
    await flushWrite()
  }
  return p
}

// ---------------------------------------------------------------------------
// External-edit watching
// ---------------------------------------------------------------------------

/**
 * Start watching settings.json for EXTERNAL edits. When the user edits the file
 * (e.g. in a Cate editor panel) and saves, `onExternal` fires with the new
 * settings and the list of keys that changed. Our own programmatic writes are
 * filtered out by comparing the on-disk content with what we last wrote.
 */
export function startWatching(
  onExternal: (next: AppSettings, changedKeys: Array<keyof AppSettings>) => void,
): void {
  if (watcher) return
  const filePath = getSettingsFilePath()
  watcher = watch(filePath, { ignoreInitial: true })

  const handle = async (): Promise<void> => {
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch {
      return // transient (mid-rename) — the trailing event will settle it
    }
    if (raw === lastWrittenContent) return // our own write — ignore the echo

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      log.warn('[settingsFile] External edit is not valid JSON — keeping current settings')
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return

    // Build a fresh, fully-defaulted settings object from the file and diff it
    // against the live state so we report exactly which keys the user changed.
    const next: AppSettings = { ...DEFAULT_SETTINGS }
    mergeValidatedSettings(next, parsed as Record<string, unknown>)
    const changed = SETTINGS_KEYS.filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]),
    )
    lastWrittenContent = raw
    if (changed.length === 0) return

    current = next
    onExternal(getAllSettings(), changed)
  }

  watcher.on('change', () => { void handle() })
  watcher.on('add', () => { void handle() })
  watcher.on('error', (err) => log.warn('[settingsFile] Watcher error: %O', err))
}

export function stopWatching(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; void flushWrite() }
  if (watcher) { void watcher.close(); watcher = null }
}

/** Synchronously flush a pending debounced write. Called on app quit so a
 *  setting changed in the last 150 ms isn't lost when the process exits before
 *  the async writer fires. */
export function flushPendingWritesSync(): void {
  if (!writeTimer) return
  clearTimeout(writeTimer)
  writeTimer = null
  writeSync()
}
