import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_SHORTCUTS, storedShortcut } from '../../shared/types'

// shortcutStore hydrates from the settings store at module init and subscribes
// for later changes, so each case resets the module graph and re-imports.
async function loadStores() {
  vi.resetModules()
  const { useSettingsStore } = await import('./settingsStore')
  const { useShortcutStore } = await import('./shortcutStore')
  return { useSettingsStore, useShortcutStore }
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
    const { useShortcutStore } = await loadStores()
    const match = useShortcutStore.getState().matchEvent
    expect(match(keyEvent(' ', { shift: true }))).toBeNull()
    expect(match(keyEvent(' ', { ctrl: true }))).toBe('toggleTool')
  })

  it('clearShortcut disables a binding so it never matches (#372)', async () => {
    const { useShortcutStore } = await loadStores()
    useShortcutStore.getState().clearShortcut('toggleTool')
    expect(useShortcutStore.getState().shortcuts.toggleTool.key).toBe('')
    expect(useShortcutStore.getState().matchEvent(keyEvent(' ', { ctrl: true }))).toBeNull()
  })

  it('persists only diffs from the defaults into settings (#372)', async () => {
    const { useSettingsStore, useShortcutStore } = await loadStores()
    const store = useShortcutStore.getState()

    store.setShortcut('newTerminal', storedShortcut('t', { command: true, shift: true }))
    store.clearShortcut('toggleTool')
    expect(useSettingsStore.getState().customShortcuts).toEqual({
      newTerminal: storedShortcut('t', { command: true, shift: true }),
      toggleTool: storedShortcut(''),
    })

    store.resetShortcut('newTerminal')
    expect(useSettingsStore.getState().customShortcuts).toEqual({
      toggleTool: storedShortcut(''),
    })

    store.resetAll()
    expect(useSettingsStore.getState().customShortcuts).toEqual({})
    expect(useShortcutStore.getState().shortcuts).toEqual(DEFAULT_SHORTCUTS)
  })

  it('hydrates overrides from the settings store (settings.json reloads)', async () => {
    const { useSettingsStore, useShortcutStore } = await loadStores()
    useSettingsStore.setState({
      customShortcuts: {
        toggleTool: storedShortcut(''),
        zoomIn: storedShortcut('=', { command: true, shift: true }),
      },
    })
    const { shortcuts } = useShortcutStore.getState()
    expect(shortcuts.toggleTool.key).toBe('')
    expect(shortcuts.zoomIn).toEqual(storedShortcut('=', { command: true, shift: true }))
    // Untouched actions keep their defaults.
    expect(shortcuts.newTerminal).toEqual(DEFAULT_SHORTCUTS.newTerminal)
  })

  it('ignores malformed hand-edited override entries', async () => {
    const { useSettingsStore, useShortcutStore } = await loadStores()
    useSettingsStore.setState({
      customShortcuts: {
        toggleTool: { key: 42, command: 'yes' },
        notAnAction: storedShortcut('x', { command: true }),
      } as never,
    })
    const { shortcuts, matchEvent } = useShortcutStore.getState()
    expect(shortcuts.toggleTool).toEqual(DEFAULT_SHORTCUTS.toggleTool)
    expect(matchEvent(keyEvent('x', { meta: true }))).toBeNull()
  })
})
