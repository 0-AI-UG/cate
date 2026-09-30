import { describe, expect, it, vi } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { createClientSettingsStore } from '@kernel/settings/client'
import { DEFAULT_SHORTCUTS, normaliseShortcutKey, storedShortcut } from '../contract'
import { createMemoryShortcutRegistry, createShortcutRegistry } from './registry'

function keyEvent(key: string, mods: Partial<{ meta: boolean; shift: boolean; alt: boolean; ctrl: boolean }> = {}) {
  return {
    key,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    ctrlKey: mods.ctrl ?? false,
  }
}

function settingsRegistry() {
  const settings = createClientSettingsStore(createMemoryDeviceStore())
  return { settings, registry: createShortcutRegistry(settings) }
}

describe('shortcut registry', () => {
  it('toggleTool defaults to Ctrl+Space, not Shift+Space (#371)', () => {
    const registry = createMemoryShortcutRegistry()
    expect(registry.match(keyEvent(' ', { shift: true }))).toBeNull()
    expect(registry.match(keyEvent(' ', { ctrl: true }))).toBe('toggleTool')
  })

  it('nextWorkspace / previousWorkspace default to Cmd+Option+Arrow (#456)', () => {
    const registry = createMemoryShortcutRegistry()
    expect(registry.match(keyEvent('ArrowRight', { meta: true, alt: true }))).toBe('nextWorkspace')
    expect(registry.match(keyEvent('ArrowLeft', { meta: true, alt: true }))).toBe('previousWorkspace')
    expect(registry.match(keyEvent('ArrowRight', { meta: true }))).not.toBe('nextWorkspace')
  })

  it('normalizes recorded arrow keys before matching custom workspace shortcuts', () => {
    const { settings, registry } = settingsRegistry()
    settings.set('customShortcuts', {
      nextWorkspace: storedShortcut(normaliseShortcutKey('ArrowRight'), { command: true, shift: true }),
      previousWorkspace: storedShortcut(normaliseShortcutKey('ArrowLeft'), { command: true, shift: true }),
    })
    expect(registry.resolved().nextWorkspace.key).toBe('→')
    expect(registry.resolved().previousWorkspace.key).toBe('←')
    expect(registry.match(keyEvent('ArrowRight', { meta: true, shift: true }))).toBe('nextWorkspace')
    expect(registry.match(keyEvent('ArrowLeft', { meta: true, shift: true }))).toBe('previousWorkspace')
  })

  it('clear disables a binding so it never matches (#372)', () => {
    const { registry } = settingsRegistry()
    registry.clear('toggleTool')
    expect(registry.resolved().toggleTool.key).toBe('')
    expect(registry.match(keyEvent(' ', { ctrl: true }))).toBeNull()
  })

  it('persists only diffs from the defaults into settings (#372)', () => {
    const { settings, registry } = settingsRegistry()
    registry.set('newTerminal', storedShortcut('t', { command: true, shift: true }))
    registry.clear('toggleTool')
    expect(settings.get('customShortcuts')).toEqual({
      newTerminal: storedShortcut('t', { command: true, shift: true }),
      toggleTool: storedShortcut(''),
    })
    registry.reset('newTerminal')
    expect(settings.get('customShortcuts')).toEqual({ toggleTool: storedShortcut('') })
    registry.resetAll()
    expect(settings.get('customShortcuts')).toEqual({})
    expect(registry.resolved()).toEqual(DEFAULT_SHORTCUTS)
  })

  it('follows settings edits and notifies subscribers', () => {
    const { settings, registry } = settingsRegistry()
    const cb = vi.fn()
    registry.subscribe(cb)
    settings.set('zoomSpeed', 2)
    expect(cb).not.toHaveBeenCalled()
    settings.set('customShortcuts', { zoomIn: storedShortcut('=', { command: true, shift: true }) })
    expect(cb).toHaveBeenCalledTimes(1)
    const shortcuts = registry.resolved()
    expect(shortcuts.zoomIn).toEqual(storedShortcut('=', { command: true, shift: true }))
    expect(shortcuts.newTerminal).toEqual(DEFAULT_SHORTCUTS.newTerminal)
    expect(registry.resolved()).toBe(shortcuts)
  })

  it('ignores malformed hand-edited override entries', () => {
    const registry = createMemoryShortcutRegistry({
      toggleTool: { key: 42, command: 'yes' },
      notAnAction: storedShortcut('x', { command: true }),
    } as never)
    expect(registry.resolved().toggleTool).toEqual(DEFAULT_SHORTCUTS.toggleTool)
    expect(registry.match(keyEvent('x', { meta: true }))).toBeNull()
  })
})

it('has no duplicate assigned default shortcuts', () => {
  const assigned = Object.entries(DEFAULT_SHORTCUTS).filter(([, shortcut]) => shortcut.key)
  const bindings = assigned.map(([, s]) => JSON.stringify([s.key, s.command, s.shift, s.option, s.control]))
  expect(new Set(bindings).size).toBe(assigned.length)
})

it('assigns default keys to overlay and action-bar controls', () => {
  for (const action of [
    'openSettings', 'openRepository', 'openPullRequests', 'skills', 'openUsage',
    'toggleKeepAwake', 'openWorktreeMenu', 'openConversationMenu', 'toggleCanvasToolbar',
    'selectTool', 'handTool', 'toggleTool', 'newTerminal', 'newBrowser', 'newEditor', 'newAgent', 'toggleMinimap',
  ] as const) expect(DEFAULT_SHORTCUTS[action].key, action).not.toBe('')
})
