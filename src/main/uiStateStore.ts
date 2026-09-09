// =============================================================================
// uiStateStore — transient, cosmetic UI placement (minimap button corner),
// persisted to `<userData>/ui-state.json` via ./jsonStateFile. Kept separate
// from settings.json so the user-facing settings file stays focused on
// preferences. Renderer reads it once on launch and writes single keys back.
// =============================================================================

import { ipcMain } from 'electron'
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
    }
  },
})

export function registerUIStateHandlers(): void {
  ipcMain.handle(UI_STATE_GET_ALL, async () => store.get())
  ipcMain.handle(UI_STATE_SET, async (_event, key: keyof UIState, value: unknown) => {
    if (key !== 'minimapButtonCorner' || typeof value !== 'string' || !CORNERS.has(value)) return
    store.update((cur) => ({ ...cur, [key]: value as UIState['minimapButtonCorner'] }))
  })
  // Keep the in-memory copy fresh if the file is hand-edited (no broadcast — the
  // values are read per-window on launch; a live reload isn't worth the wiring).
  store.startWatching(() => { /* read on demand */ })
}

/** Flush a pending debounced write synchronously (call on app quit). */
export function flushUIStateSync(): void {
  store.flushPendingWritesSync()
}
