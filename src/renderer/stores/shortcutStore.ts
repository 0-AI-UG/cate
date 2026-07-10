import { useMemo } from 'react'
import type { ShortcutAction, StoredShortcut } from '../../shared/types'
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, resolveShortcuts, storedShortcut } from '../../shared/types'
import { useSettingsStore } from './settingsStore'

interface ModifierState {
  command: boolean
  shift: boolean
  option: boolean
  control: boolean
}

function normaliseKey(event: KeyboardEvent): string {
  switch (event.key) {
    case 'Tab': return '\t'
    case 'Enter': return '\r'
    case ' ': return ' '
    case 'Backspace': return 'Backspace'
    case 'Escape': return 'Escape'
    case 'ArrowLeft': return '\u2190'
    case 'ArrowRight': return '\u2192'
    case 'ArrowDown': return '\u2193'
    case 'ArrowUp': return '\u2191'
    default: return event.key.toLowerCase()
  }
}

function sameShortcut(a: StoredShortcut, b: StoredShortcut): boolean {
  return a.key === b.key &&
    a.command === b.command &&
    a.shift === b.shift &&
    a.option === b.option &&
    a.control === b.control
}

export function getResolvedShortcuts(): Record<ShortcutAction, StoredShortcut> {
  return resolveShortcuts(useSettingsStore.getState().customShortcuts)
}

export function useResolvedShortcuts(): Record<ShortcutAction, StoredShortcut> {
  const overrides = useSettingsStore((state) => state.customShortcuts)
  return useMemo(() => resolveShortcuts(overrides), [overrides])
}

function persist(shortcuts: Record<ShortcutAction, StoredShortcut>): void {
  const overrides: Partial<Record<ShortcutAction, StoredShortcut>> = {}
  for (const action of SHORTCUT_ACTIONS) {
    if (!sameShortcut(shortcuts[action], DEFAULT_SHORTCUTS[action])) overrides[action] = shortcuts[action]
  }
  useSettingsStore.getState().setSetting('customShortcuts', overrides)
}

export function setShortcut(action: ShortcutAction, shortcut: StoredShortcut): void {
  persist({ ...getResolvedShortcuts(), [action]: shortcut })
}

export function clearShortcut(action: ShortcutAction): void {
  persist({ ...getResolvedShortcuts(), [action]: storedShortcut('') })
}

export function resetShortcut(action: ShortcutAction): void {
  persist({ ...getResolvedShortcuts(), [action]: DEFAULT_SHORTCUTS[action] })
}

export function resetAllShortcuts(): void {
  useSettingsStore.getState().setSetting('customShortcuts', {})
}

export function matchShortcutEvent(event: KeyboardEvent): ShortcutAction | null {
  const eventKey = normaliseKey(event)
  const eventMods: ModifierState = {
    command: event.metaKey,
    shift: event.shiftKey,
    option: event.altKey,
    control: event.ctrlKey,
  }
  const shortcuts = getResolvedShortcuts()
  for (const action of SHORTCUT_ACTIONS) {
    const stored = shortcuts[action]
    if (!stored.key) continue
    if (stored.key === eventKey &&
        stored.command === eventMods.command &&
        stored.shift === eventMods.shift &&
        stored.option === eventMods.option &&
        stored.control === eventMods.control) return action
  }
  return null
}
