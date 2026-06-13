// =============================================================================
// Shortcut Store — Zustand state for keyboard shortcut bindings and matching.
// Ported from KeyboardShortcuts.swift
// =============================================================================

import { create } from 'zustand'
import type { ShortcutAction, StoredShortcut } from '../../shared/types'
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, storedShortcut } from '../../shared/types'
import { useSettingsStore } from './settingsStore'

// -----------------------------------------------------------------------------
// Modifier state
// -----------------------------------------------------------------------------

interface ModifierState {
  command: boolean
  shift: boolean
  option: boolean
  control: boolean
}

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface ShortcutStoreState {
  shortcuts: Record<ShortcutAction, StoredShortcut>
}

interface ShortcutStoreActions {
  setShortcut: (action: ShortcutAction, shortcut: StoredShortcut) => void
  /** Disable a shortcut: an empty-key binding never matches any keystroke. */
  clearShortcut: (action: ShortcutAction) => void
  resetShortcut: (action: ShortcutAction) => void
  resetAll: () => void
  matchEvent: (e: KeyboardEvent) => ShortcutAction | null
}

export type ShortcutStore = ShortcutStoreState & ShortcutStoreActions

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Normalise a KeyboardEvent.key to the stored key format.
 * Special keys map to the same strings used in DEFAULT_SHORTCUTS.
 */
function normaliseKey(e: KeyboardEvent): string {
  switch (e.key) {
    case 'Tab':
      return '\t'
    case 'Enter':
      return '\r'
    case ' ':
      return ' '
    case 'Backspace':
      return 'Backspace'
    case 'Escape':
      return 'Escape'
    case 'ArrowLeft':
      return '\u2190' // ←
    case 'ArrowRight':
      return '\u2192' // →
    case 'ArrowDown':
      return '\u2193' // ↓
    case 'ArrowUp':
      return '\u2191' // ↑
    default:
      return e.key.toLowerCase()
  }
}

/** True when two bindings are the same chord. */
function sameShortcut(a: StoredShortcut, b: StoredShortcut): boolean {
  return (
    a.key === b.key &&
    a.command === b.command &&
    a.shift === b.shift &&
    a.option === b.option &&
    a.control === b.control
  )
}

/** Coerce a hand-edited settings.json value into a StoredShortcut, or null. */
function sanitizeShortcut(value: unknown): StoredShortcut | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.key !== 'string') return null
  return storedShortcut(v.key, {
    command: v.command === true,
    shift: v.shift === true,
    option: v.option === true,
    control: v.control === true,
  })
}

/** Persist the current bindings into settings.json as a diff vs the defaults,
 *  so customizations (including disabled shortcuts) survive a restart. */
function persistOverrides(shortcuts: Record<ShortcutAction, StoredShortcut>): void {
  const overrides: Partial<Record<ShortcutAction, StoredShortcut>> = {}
  for (const action of SHORTCUT_ACTIONS) {
    if (!sameShortcut(shortcuts[action], DEFAULT_SHORTCUTS[action])) {
      overrides[action] = shortcuts[action]
    }
  }
  useSettingsStore.getState().setSetting('customShortcuts', overrides)
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useShortcutStore = create<ShortcutStore>((set, get) => ({
  // --- State ---
  shortcuts: { ...DEFAULT_SHORTCUTS },

  // --- Actions ---

  setShortcut(action, shortcut) {
    const shortcuts = { ...get().shortcuts, [action]: shortcut }
    set({ shortcuts })
    persistOverrides(shortcuts)
  },

  clearShortcut(action) {
    const shortcuts = { ...get().shortcuts, [action]: storedShortcut('') }
    set({ shortcuts })
    persistOverrides(shortcuts)
  },

  resetShortcut(action) {
    const shortcuts = { ...get().shortcuts, [action]: DEFAULT_SHORTCUTS[action] }
    set({ shortcuts })
    persistOverrides(shortcuts)
  },

  resetAll() {
    set({ shortcuts: { ...DEFAULT_SHORTCUTS } })
    persistOverrides({ ...DEFAULT_SHORTCUTS })
  },

  matchEvent(e: KeyboardEvent): ShortcutAction | null {
    const { shortcuts } = get()
    const eventKey = normaliseKey(e)
    const eventMods: ModifierState = {
      command: e.metaKey,
      shift: e.shiftKey,
      option: e.altKey,
      control: e.ctrlKey,
    }

    for (const action of SHORTCUT_ACTIONS) {
      const stored = shortcuts[action]
      // An empty key means the user disabled this shortcut.
      if (!stored.key) continue
      if (
        stored.key === eventKey &&
        stored.command === eventMods.command &&
        stored.shift === eventMods.shift &&
        stored.option === eventMods.option &&
        stored.control === eventMods.control
      ) {
        return action
      }
    }

    return null
  },
}))

// -----------------------------------------------------------------------------
// Hydration from settings.json
//
// The settings store loads asynchronously (and reloads on external hand-edits
// of settings.json), so apply `customShortcuts` whenever it changes. Hydration
// writes the store state directly — never through the actions — so it can't
// echo back into persistOverrides.
// -----------------------------------------------------------------------------

let lastAppliedOverrides: string | null = null

function applyOverrides(raw: unknown): void {
  const json = JSON.stringify(raw ?? {})
  if (json === lastAppliedOverrides) return
  lastAppliedOverrides = json

  const shortcuts: Record<ShortcutAction, StoredShortcut> = { ...DEFAULT_SHORTCUTS }
  if (typeof raw === 'object' && raw !== null) {
    for (const action of SHORTCUT_ACTIONS) {
      if (!(action in raw)) continue
      const parsed = sanitizeShortcut((raw as Record<string, unknown>)[action])
      if (parsed) shortcuts[action] = parsed
    }
  }
  useShortcutStore.setState({ shortcuts })
}

applyOverrides(useSettingsStore.getState().customShortcuts)
useSettingsStore.subscribe((state) => applyOverrides(state.customShortcuts))
