// =============================================================================
// settingsFile — owns the user-editable settings.json file.
//
// VS Code model: a dedicated `<userData>/settings.json` is the source of truth
// for AppSettings. It holds ONLY user settings; the workspace/session state
// (recentProjects, layouts, remoteProjects, sidebarSession) lives in its own
// files (see ./workspaceStateStore).
//
// This is a thin wrapper over ./jsonStateFile (the reusable "JSON file is the
// source of truth" store that was itself lifted from this module): jsonStateFile
// provides the synchronous load, debounced atomic writes, external-edit watcher,
// echo-suppression AND corrupt-file quarantine. settingsFile adds only a
// changed-keys diff on external edits (the factory reports the whole value;
// callers want exactly which keys the user changed so per-key side effects only
// fire for what moved).
// =============================================================================

import fsSync from 'fs'
import log from './logger'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { AppSettings } from '../shared/types'
import { createJsonStateFile } from './jsonStateFile'

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
  uiScale: 'number',
  showMinimap: 'boolean',
  defaultPanelWidth: 'number',
  defaultPanelHeight: 'number',
  zoomSpeed: 'number',
  autoFocusLargestVisibleNode: 'boolean',
  canvasGridStyle: 'string',
  canvasBackgroundImagePath: 'string',
  canvasBackgroundImageOpacity: 'number',
  snapToGrid: 'boolean',
  placementPicker: 'boolean',
  showWorktreeTerritory: 'boolean',
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
  // Agent / layout — structured values. 'object' accepts a plain object or null;
  // deeper validation (shape of the model ref / sidebar layout) lives in the
  // renderer consumers, which already tolerate partial/legacy shapes.
  agentDefaultModel: 'object',
  sidebarLayout: 'object',
}

const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMA) as Array<keyof AppSettings>

/** True if `value` matches the schema type expected for `key`. */
function valueMatchesSchema(key: keyof AppSettings, value: unknown): boolean {
  const expected = SETTINGS_SCHEMA[key]
  if (expected === 'array') return Array.isArray(value)
  // 'object' accepts a plain object or null; arrays are rejected so an array
  // can't masquerade as an object.
  if (expected === 'object') return typeof value === 'object' && !Array.isArray(value)
  return typeof value === expected
}

/** Merge only known, type-correct keys from a parsed object into `target`. */
function mergeValidatedSettings(target: AppSettings, source: Record<string, unknown>): void {
  for (const key of SETTINGS_KEYS) {
    if (!(key in source)) continue
    const val = source[key]
    if (!valueMatchesSchema(key, val)) {
      log.warn('Settings schema mismatch: %s expected %s, got %s', key, SETTINGS_SCHEMA[key], typeof val)
      continue
    }
    ;(target as unknown as Record<string, unknown>)[key as string] = val
  }
}

/** The factory's single shape authority: raw parsed JSON → a complete, validated
 *  AppSettings. Never throws (a malformed hand-edit degrades to defaults). */
function normalizeSettings(parsed: unknown, defaults: AppSettings): AppSettings {
  const next: AppSettings = { ...defaults }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    mergeValidatedSettings(next, parsed as Record<string, unknown>)
  }
  return next
}

export function isSettingsKey(key: string): key is keyof AppSettings {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)
}

// ---------------------------------------------------------------------------
// Backing store
// ---------------------------------------------------------------------------

const store = createJsonStateFile<AppSettings>({
  filename: SETTINGS_FILENAME,
  defaults: { ...DEFAULT_SETTINGS },
  normalize: normalizeSettings,
})

let seeded = false

export function getSettingsFilePath(): string {
  return store.getPath()
}

// ---------------------------------------------------------------------------
// Load (synchronous — runs at startup before any window is created)
// ---------------------------------------------------------------------------

/**
 * Load settings synchronously from settings.json. On first run (file absent)
 * settings.json is seeded with defaults so it exists for the watcher and for
 * hand-editing. Idempotent.
 */
export function loadSettingsSync(): void {
  if (seeded) return
  seeded = true

  const filePath = store.getPath()
  // If the file already exists, the factory's load() is authoritative (it also
  // handles corrupt-file quarantine). First-run seeding only runs when absent.
  if (fsSync.existsSync(filePath)) {
    store.load()
    return
  }

  // First run: prime the factory's in-memory copy with defaults and seed
  // settings.json synchronously so the file exists for the watcher and for
  // hand-editing. `set` always schedules a write; flush it synchronously here.
  store.load()
  store.set(store.get())
  store.flushPendingWritesSync()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return (store.get()[key] ?? DEFAULT_SETTINGS[key]) as AppSettings[K]
}

export function getAllSettings(): AppSettings {
  return { ...store.get() }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Update one setting, validating its type. No-op (returns false) on a type
 *  mismatch or unknown key. Persists via a debounced atomic write. */
export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): boolean {
  if (!isSettingsKey(key)) return false
  if (!valueMatchesSchema(key, value)) {
    log.warn('[settingsFile] Rejected set for %s: expected %s', String(key), SETTINGS_SCHEMA[key])
    return false
  }
  store.update((current) => ({ ...current, [key]: value }))
  return true
}

/** Reset one key to its default and persist. */
export function resetSetting(key: keyof AppSettings): void {
  store.update((current) => ({ ...current, [key]: DEFAULT_SETTINGS[key] }))
}

/** Reset every setting to defaults and persist. */
export function resetAllSettings(): void {
  store.set({ ...DEFAULT_SETTINGS })
}

/** Ensure settings.json exists on disk, and return its absolute path. */
export async function ensureSettingsFile(): Promise<string> {
  return store.ensureFile()
}

// ---------------------------------------------------------------------------
// External-edit watching
// ---------------------------------------------------------------------------

/**
 * Start watching settings.json for EXTERNAL edits. When the user edits the file
 * (e.g. in a Cate editor panel) and saves, `onExternal` fires with the new
 * settings and the list of keys that changed. The factory reports the whole new
 * value; we diff it against the value we last reported to derive changed keys.
 */
export function startWatching(
  onExternal: (next: AppSettings, changedKeys: Array<keyof AppSettings>) => void,
): void {
  let lastReported = store.get()
  store.startWatching((next) => {
    const changed = SETTINGS_KEYS.filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(lastReported[k]),
    )
    lastReported = next
    if (changed.length === 0) return
    onExternal(getAllSettings(), changed)
  })
}

export function stopWatching(): void {
  store.stopWatching()
}

/** Synchronously flush a pending debounced write. Called on app quit so a
 *  setting changed in the last 150 ms isn't lost when the process exits before
 *  the async writer fires. */
export function flushPendingWritesSync(): void {
  store.flushPendingWritesSync()
}
