// =============================================================================
// Shortcut Store — Zustand state for keyboard shortcut bindings and matching.
// Ported from KeyboardShortcuts.swift
// =============================================================================

import { create } from 'zustand'
import type { ShortcutAction, StoredShortcut } from '../../shared/types'
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS } from '../../shared/types'

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface ShortcutStoreState {
  shortcuts: Record<ShortcutAction, StoredShortcut>
}

interface ShortcutStoreActions {
  setShortcut: (action: ShortcutAction, shortcut: StoredShortcut) => void
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

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useShortcutStore = create<ShortcutStore>((set, get) => ({
  // --- State ---
  shortcuts: { ...DEFAULT_SHORTCUTS },

  // --- Actions ---

  setShortcut(action, shortcut) {
    set((state) => ({
      shortcuts: { ...state.shortcuts, [action]: shortcut },
    }))
  },

  resetShortcut(action) {
    set((state) => ({
      shortcuts: { ...state.shortcuts, [action]: DEFAULT_SHORTCUTS[action] },
    }))
  },

  resetAll() {
    set({ shortcuts: { ...DEFAULT_SHORTCUTS } })
  },

  matchEvent(e: KeyboardEvent): ShortcutAction | null {
    const { shortcuts } = get()
    const eventKey = normaliseKey(e)
    // On macOS the primary modifier is Cmd (metaKey); on Windows/Linux
    // it's Ctrl (ctrlKey). Match permissively: on non-Mac, Ctrl satisfies
    // both `command` and `control` so a stored `command:true` (macOS ⌘)
    // works with Ctrl and a stored `control:true` (macOS ⌃) also works
    // with Ctrl, with no ambiguity since they use different letters.
    const isMac =
      typeof navigator !== 'undefined' &&
      typeof navigator.platform === 'string' &&
      navigator.platform.toLowerCase().includes('mac')
    const cmdPressed = isMac ? e.metaKey : e.ctrlKey
    const ctrlPressed = e.ctrlKey

    for (const action of SHORTCUT_ACTIONS) {
      const stored = shortcuts[action]
      if (
        stored.key !== eventKey ||
        stored.shift !== e.shiftKey ||
        stored.option !== e.altKey
      ) continue
      if (stored.command && !cmdPressed) continue
      if (stored.control && !ctrlPressed) continue
      return action
    }

    return null
  },
}))
