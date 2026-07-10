import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_SHORTCUTS, storedShortcut } from '../../shared/types'

async function loadStores() {
  vi.resetModules()
  const { useSettingsStore } = await import('./settingsStore')
  const shortcuts = await import('./shortcutStore')
  return { useSettingsStore, ...shortcuts }
}

function keyEvent(key: string, mods: Partial<{ meta: boolean; shift: boolean; alt: boolean; ctrl: boolean }> = {}) {
  return {
    key,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    ctrlKey: mods.ctrl ?? false,
  } as KeyboardEvent
}

describe('shortcutStore', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('toggleTool defaults to Ctrl+Space, not Shift+Space (#371)', async () => {
    const { matchShortcutEvent } = await loadStores()
    expect(matchShortcutEvent(keyEvent(' ', { shift: true }))).toBeNull()
    expect(matchShortcutEvent(keyEvent(' ', { ctrl: true }))).toBe('toggleTool')
  })

  it('clearShortcut disables a binding so it never matches (#372)', async () => {
    const { clearShortcut, getResolvedShortcuts, matchShortcutEvent } = await loadStores()
    clearShortcut('toggleTool')
    expect(getResolvedShortcuts().toggleTool.key).toBe('')
    expect(matchShortcutEvent(keyEvent(' ', { ctrl: true }))).toBeNull()
  })

  it('persists only diffs from the defaults into settings (#372)', async () => {
    const { useSettingsStore, setShortcut, clearShortcut, resetShortcut, resetAllShortcuts, getResolvedShortcuts } = await loadStores()

    setShortcut('newTerminal', storedShortcut('t', { command: true, shift: true }))
    clearShortcut('toggleTool')
    expect(useSettingsStore.getState().customShortcuts).toEqual({
      newTerminal: storedShortcut('t', { command: true, shift: true }),
      toggleTool: storedShortcut(''),
    })

    resetShortcut('newTerminal')
    expect(useSettingsStore.getState().customShortcuts).toEqual({
      toggleTool: storedShortcut(''),
    })

    resetAllShortcuts()
    expect(useSettingsStore.getState().customShortcuts).toEqual({})
    expect(getResolvedShortcuts()).toEqual(DEFAULT_SHORTCUTS)
  })

  it('hydrates overrides from the settings store (settings.json reloads)', async () => {
    const { useSettingsStore, getResolvedShortcuts } = await loadStores()
    useSettingsStore.setState({
      customShortcuts: {
        toggleTool: storedShortcut(''),
        zoomIn: storedShortcut('=', { command: true, shift: true }),
      },
    })
    const shortcuts = getResolvedShortcuts()
    expect(shortcuts.toggleTool.key).toBe('')
    expect(shortcuts.zoomIn).toEqual(storedShortcut('=', { command: true, shift: true }))
    // Untouched actions keep their defaults.
    expect(shortcuts.newTerminal).toEqual(DEFAULT_SHORTCUTS.newTerminal)
  })

  it('ignores malformed hand-edited override entries', async () => {
    const { useSettingsStore, getResolvedShortcuts, matchShortcutEvent } = await loadStores()
    useSettingsStore.setState({
      customShortcuts: {
        toggleTool: { key: 42, command: 'yes' },
        notAnAction: storedShortcut('x', { command: true }),
      } as never,
    })
    const shortcuts = getResolvedShortcuts()
    expect(shortcuts.toggleTool).toEqual(DEFAULT_SHORTCUTS.toggleTool)
    expect(matchShortcutEvent(keyEvent('x', { meta: true }))).toBeNull()
  })
})
