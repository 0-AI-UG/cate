import { afterAll, describe, expect, it, vi } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { createClientSettingsStore } from '@kernel/settings/client'
import { normaliseShortcutKey, storedShortcut } from '../contract'
import { declareActions } from '../actions/catalog'
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

const TOGGLE = storedShortcut(' ', { control: true })
const NEXT = storedShortcut('→', { command: true, option: true })
const TERMINAL = storedShortcut('t', { command: true })

const undeclare = declareActions({
  toggleTool: { title: 'Toggle Tool', key: TOGGLE },
  nextWorkspace: { title: 'Next Workspace', key: NEXT },
  'panel.new.terminal': { title: 'New Terminal', key: TERMINAL },
  unbound: { title: 'Unbound' },
})
afterAll(undeclare)

function settingsRegistry() {
  const settings = createClientSettingsStore(createMemoryDeviceStore())
  return { settings, registry: createShortcutRegistry(settings) }
}

describe('shortcut registry', () => {
  it('resolves every declared action to its default key, unbound without one', () => {
    const registry = createMemoryShortcutRegistry()
    expect(registry.resolved()).toEqual({ toggleTool: TOGGLE, nextWorkspace: NEXT, 'panel.new.terminal': TERMINAL, unbound: storedShortcut('') })
    expect(registry.match(keyEvent(' ', { ctrl: true }))).toBe('toggleTool')
    expect(registry.match(keyEvent(' ', { shift: true }))).toBeNull()
  })

  it('follows actions declared later', () => {
    const registry = createMemoryShortcutRegistry()
    const undo = declareActions({ later: { title: 'Later', key: storedShortcut('y', { command: true }) } })
    expect(registry.match(keyEvent('y', { meta: true }))).toBe('later')
    undo()
    expect(registry.match(keyEvent('y', { meta: true }))).toBeNull()
  })

  it('normalizes recorded arrow keys before matching custom shortcuts', () => {
    const { settings, registry } = settingsRegistry()
    settings.set('customShortcuts', { nextWorkspace: storedShortcut(normaliseShortcutKey('ArrowRight'), { command: true, shift: true }) })
    expect(registry.resolved().nextWorkspace.key).toBe('→')
    expect(registry.match(keyEvent('ArrowRight', { meta: true, shift: true }))).toBe('nextWorkspace')
  })

  it('clear disables a binding so it never matches (#372)', () => {
    const { registry } = settingsRegistry()
    registry.clear('toggleTool')
    expect(registry.resolved().toggleTool.key).toBe('')
    expect(registry.match(keyEvent(' ', { ctrl: true }))).toBeNull()
  })

  it('persists only diffs from the defaults, keeping overrides of undeclared actions', () => {
    const { settings, registry } = settingsRegistry()
    settings.set('customShortcuts', { gone: storedShortcut('q', { command: true }) })
    registry.set('panel.new.terminal', storedShortcut('t', { command: true, shift: true }))
    registry.clear('toggleTool')
    expect(settings.get('customShortcuts')).toEqual({
      gone: storedShortcut('q', { command: true }),
      'panel.new.terminal': storedShortcut('t', { command: true, shift: true }),
      toggleTool: storedShortcut(''),
    })
    registry.reset('panel.new.terminal')
    registry.set('toggleTool', TOGGLE)
    expect(settings.get('customShortcuts')).toEqual({ gone: storedShortcut('q', { command: true }) })
    registry.resetAll()
    expect(settings.get('customShortcuts')).toEqual({})
  })

  it('follows settings edits and notifies subscribers', () => {
    const { settings, registry } = settingsRegistry()
    const cb = vi.fn()
    registry.subscribe(cb)
    settings.set('zoomSpeed', 2)
    expect(cb).not.toHaveBeenCalled()
    settings.set('customShortcuts', { toggleTool: storedShortcut('h', { command: true }) })
    expect(cb).toHaveBeenCalledTimes(1)
    const shortcuts = registry.resolved()
    expect(shortcuts.toggleTool).toEqual(storedShortcut('h', { command: true }))
    expect(registry.resolved()).toBe(shortcuts)
  })

  it('ignores malformed hand-edited override entries', () => {
    const registry = createMemoryShortcutRegistry({ toggleTool: { key: 42, command: 'yes' } } as never)
    expect(registry.resolved().toggleTool).toEqual(TOGGLE)
  })
})
