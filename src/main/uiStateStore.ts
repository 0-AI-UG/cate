// =============================================================================
// uiStateStore — renderer presentation and lifecycle state, persisted to
// `<userData>/ui-state.json` via ./jsonStateFile. Kept separate from
// settings.json so the user-facing settings file stays focused on preferences.
// Renderer reads it once on launch and writes single keys back.
// =============================================================================

import { ipcMain } from 'electron'
import fsSync from 'fs'
import { createJsonStateFile } from './jsonStateFile'
import { isPlainObject } from './jsonUtils'
import { DEFAULT_UI_STATE } from '../shared/types'
import type { UIState } from '../shared/types'
import { UI_STATE_GET_ALL, UI_STATE_SET } from '../shared/ipc-channels'

const CORNERS = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left'])

const store = createJsonStateFile<UIState>({
  filename: 'ui-state.json',
  defaults: DEFAULT_UI_STATE,
  normalize: (parsed, defaults) => {
    const o = isPlainObject(parsed) ? parsed : {}
    return {
      minimapButtonCorner: CORNERS.has(o.minimapButtonCorner as string) ? (o.minimapButtonCorner as UIState['minimapButtonCorner']) : defaults.minimapButtonCorner,
      telemetryNoticeAcknowledgedVersion: typeof o.telemetryNoticeAcknowledgedVersion === 'number' && Number.isInteger(o.telemetryNoticeAcknowledgedVersion) && o.telemetryNoticeAcknowledgedVersion >= 0
        ? o.telemetryNoticeAcknowledgedVersion
        : defaults.telemetryNoticeAcknowledgedVersion,
      onboardingCompleted: typeof o.onboardingCompleted === 'boolean' ? o.onboardingCompleted : defaults.onboardingCompleted,
    }
  },
})

export function loadUIStateSync(): void {
  store.load()
}

export function getUIStateSync<K extends keyof UIState>(key: K): UIState[K] {
  return store.get()[key]
}

export function setUIStateFromMain<K extends keyof UIState>(key: K, value: UIState[K]): void {
  store.update((current) => ({ ...current, [key]: value }))
}

/** Copy the two lifecycle flags from legacy settings.json once, before those
 * obsolete keys disappear on the next settings write. */
export function migrateLegacyLifecycleState(settingsPath: string): void {
  const uiPath = store.getPath()
  let rawUI: Record<string, unknown> = {}
  let legacy: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(fsSync.readFileSync(uiPath, 'utf8'))
    rawUI = isPlainObject(parsed) ? parsed : {}
  } catch { /* first run */ }
  try {
    const parsed: unknown = JSON.parse(fsSync.readFileSync(settingsPath, 'utf8'))
    legacy = isPlainObject(parsed) ? parsed : {}
  } catch { return }
  const patch: Partial<UIState> = {}
  if (!('telemetryNoticeAcknowledgedVersion' in rawUI) && typeof legacy.telemetryNoticeAcknowledgedVersion === 'number') {
    patch.telemetryNoticeAcknowledgedVersion = legacy.telemetryNoticeAcknowledgedVersion
  }
  if (!('onboardingCompleted' in rawUI) && typeof legacy.onboardingCompleted === 'boolean') {
    patch.onboardingCompleted = legacy.onboardingCompleted
  }
  if (Object.keys(patch).length > 0) store.update((current) => ({ ...current, ...patch }))
}

export function registerUIStateHandlers(): void {
  store.load()
  ipcMain.handle(UI_STATE_GET_ALL, async () => store.get())
  ipcMain.handle(UI_STATE_SET, async (_event, key: keyof UIState, value: unknown) => {
    if (key === 'minimapButtonCorner' && typeof value === 'string' && CORNERS.has(value)) {
      store.update((cur) => ({ ...cur, minimapButtonCorner: value as UIState['minimapButtonCorner'] }))
    } else if (key === 'telemetryNoticeAcknowledgedVersion' && typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      store.update((cur) => ({ ...cur, telemetryNoticeAcknowledgedVersion: value }))
    } else if (key === 'onboardingCompleted' && typeof value === 'boolean') {
      store.update((cur) => ({ ...cur, onboardingCompleted: value }))
    }
  })
  // Keep the in-memory copy fresh if the file is hand-edited (no broadcast — the
  // values are read per-window on launch; a live reload isn't worth the wiring).
  store.startWatching(() => { /* read on demand */ })
}

/** Flush a pending debounced write synchronously (call on app quit). */
export function flushUIStateSync(): void {
  store.flushPendingWritesSync()
}
