// =============================================================================
// migrateLegacyLocalStorage — the single localStorage → JSON-store migration.
// =============================================================================

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// In-memory localStorage shim.
const store = new Map<string, string>()
const ls = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}
vi.stubGlobal('localStorage', ls)

const settingsSet = vi.fn()
const uiSet = vi.fn()
vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ setSetting: settingsSet }) },
}))
vi.mock('../stores/uiStateStore', () => ({
  useUIStateStore: { getState: () => ({ setUIState: uiSet }) },
}))

const { migrateLegacyLocalStorage } = await import('./migrateLegacyLocalStorage')

beforeEach(() => { store.clear(); settingsSet.mockClear(); uiSet.mockClear() })
afterEach(() => { store.clear() })

describe('migrateLegacyLocalStorage', () => {
  test('routes each legacy key to its store and clears it', () => {
    store.set('cate.agent.defaultModel.v1', JSON.stringify({ provider: 'openai', model: 'gpt-x' }))
    store.set('cate.sidebarLayout.v3', JSON.stringify({ left: ['workspaces'], right: ['git'] }))
    store.set('cate.minimap.corner', 'top-left')
    store.set('cate.minimapButton.corner', 'bottom-left')
    store.set('cate.minimap.size', JSON.stringify({ w: 321, h: 222 }))

    migrateLegacyLocalStorage()

    expect(settingsSet).toHaveBeenCalledWith('agentDefaultModel', { provider: 'openai', model: 'gpt-x' })
    // sidebarLayout is normalized — missing views appended to the right.
    expect(settingsSet).toHaveBeenCalledWith('sidebarLayout', {
      left: ['workspaces'],
      right: ['git', 'explorer', 'search'],
    })
    expect(uiSet).toHaveBeenCalledWith('minimapCorner', 'top-left')
    expect(uiSet).toHaveBeenCalledWith('minimapButtonCorner', 'bottom-left')
    expect(uiSet).toHaveBeenCalledWith('minimapSize', { w: 321, h: 222 })

    // Every legacy key is removed so the migration never runs again.
    for (const k of store.keys()) expect(k).not.toMatch(/^cate\./)
    expect(store.size).toBe(0)
  })

  test('is a no-op when nothing is stored', () => {
    migrateLegacyLocalStorage()
    expect(settingsSet).not.toHaveBeenCalled()
    expect(uiSet).not.toHaveBeenCalled()
  })

  test('drops invalid values but still clears the key', () => {
    store.set('cate.agent.defaultModel.v1', 'not json{{')
    store.set('cate.minimap.corner', 'nonsense-corner')
    migrateLegacyLocalStorage()
    expect(settingsSet).not.toHaveBeenCalled()
    expect(uiSet).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
  })
})
