// =============================================================================
// migrateLegacyLocalStorage — THE one place that migrates preferences out of the
// renderer's legacy localStorage into the JSON-file model (settings.json /
// ui-state.json). Runs once at startup after the settings + ui-state stores have
// loaded; each entry reads its legacy key, routes the value to the right store
// (which persists it), then clears the key so this never runs again.
//
// Fully guarded — a migration failure must never block startup. When every key
// is gone (steady state) this is a handful of cheap localStorage misses.
// =============================================================================

import { useSettingsStore } from '../stores/settingsStore'
import { useUIStateStore } from '../stores/uiStateStore'
import { normalizeSidebarLayout } from '../stores/uiStore'

const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const
type Corner = (typeof CORNERS)[number]
const isCorner = (v: unknown): v is Corner => CORNERS.includes(v as Corner)

export function migrateLegacyLocalStorage(): void {
  if (typeof localStorage === 'undefined') return
  const settings = useSettingsStore.getState()
  const ui = useUIStateStore.getState()

  // Pull-and-clear a legacy key. `parse` decodes the raw string; the result is
  // routed by `apply`. The key is always removed once seen, value or not.
  const take = (key: string, apply: (raw: string) => void): void => {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return
      try { apply(raw) } catch { /* bad value — drop it, keep defaults */ }
      localStorage.removeItem(key)
    } catch { /* localStorage unavailable — ignore */ }
  }

  // → settings.json
  take('cate.agent.defaultModel.v1', (raw) => {
    const m = JSON.parse(raw)
    if (m && typeof m.provider === 'string' && typeof m.model === 'string') {
      settings.setSetting('agentDefaultModel', { provider: m.provider, model: m.model })
    }
  })
  take('cate.sidebarLayout.v3', (raw) => {
    settings.setSetting('sidebarLayout', normalizeSidebarLayout(JSON.parse(raw)))
  })

  // → ui-state.json
  take('cate.minimap.corner', (raw) => { if (isCorner(raw)) ui.setUIState('minimapCorner', raw) })
  take('cate.minimapButton.corner', (raw) => { if (isCorner(raw)) ui.setUIState('minimapButtonCorner', raw) })
  take('cate.minimap.size', (raw) => {
    const s = JSON.parse(raw)
    if (s && typeof s.w === 'number' && typeof s.h === 'number') ui.setUIState('minimapSize', { w: s.w, h: s.h })
  })
}
