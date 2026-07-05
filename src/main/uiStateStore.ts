// =============================================================================
// uiStateStore — transient, cosmetic UI placement (minimap position/size),
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
    const size = o.minimapSize as { w?: unknown; h?: unknown } | undefined
    return {
      minimapCorner: CORNERS.has(o.minimapCorner as string) ? (o.minimapCorner as UIState['minimapCorner']) : defaults.minimapCorner,
      minimapButtonCorner: CORNERS.has(o.minimapButtonCorner as string) ? (o.minimapButtonCorner as UIState['minimapButtonCorner']) : defaults.minimapButtonCorner,
      minimapSize: size && typeof size.w === 'number' && typeof size.h === 'number'
        ? { w: size.w, h: size.h }
        : defaults.minimapSize,
    }
  },
})

export function registerUIStateHandlers(): void {
  ipcMain.handle(UI_STATE_GET_ALL, async () => store.get())
  ipcMain.handle(UI_STATE_SET, async (_event, key: keyof UIState, value: unknown) => {
    if (!(key in DEFAULT_UI_STATE)) return
    store.update((cur) => ({ ...cur, [key]: value }))
  })
  // Keep the in-memory copy fresh if the file is hand-edited (no broadcast — the
  // values are read per-window on launch; a live reload isn't worth the wiring).
  store.startWatching(() => { /* read on demand */ })
}

/** Flush a pending debounced write synchronously (call on app quit). */
export function flushUIStateSync(): void {
  store.flushPendingWritesSync()
}
