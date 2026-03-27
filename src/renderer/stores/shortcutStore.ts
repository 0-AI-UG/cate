// =============================================================================
// Shortcut Store — Zustand state for keyboard shortcuts and hint overlay.
// Ported from KeyboardShortcuts.swift + ShortcutHintState.swift
// =============================================================================

import { create } from 'zustand'
import type { ShortcutAction, StoredShortcut } from '../../shared/types'
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS } from '../../shared/types'

// -----------------------------------------------------------------------------
// Modifier state
// -----------------------------------------------------------------------------

interface ModifierState {
  command: boolean
  shift: boolean
  option: boolean
  control: boolean
}

const NO_MODIFIERS: ModifierState = {
  command: false,
  shift: false,
  option: false,
  control: false,
}

// -----------------------------------------------------------------------------
// Store interface
// -----------------------------------------------------------------------------

interface ShortcutStoreState {
  shortcuts: Record<ShortcutAction, StoredShortcut>
  isShowingHints: boolean
  activeModifiers: ModifierState
  hintHoldTimer: ReturnType<typeof setTimeout> | null
  /** Tracks whether the hold was cancelled by a keydown during the timer. */
  _holdCancelled: boolean
}

interface ShortcutStoreActions {
  setShortcut: (action: ShortcutAction, shortcut: StoredShortcut) => void
  resetShortcut: (action: ShortcutAction) => void
  resetAll: () => void
  matchEvent: (e: KeyboardEvent) => ShortcutAction | null
  startHintHold: () => void
  cancelHintHold: () => void
  setShowingHints: (show: boolean) => void
  updateModifiers: (modifiers: ModifierState) => void
}

export type ShortcutStore = ShortcutStoreState & ShortcutStoreActions

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** How long CMD must be held (ms) before hint badges appear. */
const HINT_HOLD_THRESHOLD_MS = 750

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
  isShowingHints: false,
  activeModifiers: { ...NO_MODIFIERS },
  hintHoldTimer: null,
  _holdCancelled: false,

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
    const eventMods: ModifierState = {
      command: e.metaKey,
      shift: e.shiftKey,
      option: e.altKey,
      control: e.ctrlKey,
    }

    for (const action of SHORTCUT_ACTIONS) {
      const stored = shortcuts[action]
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

  startHintHold() {
    const state = get()

    // Clear any existing timer
    if (state.hintHoldTimer) {
      clearTimeout(state.hintHoldTimer)
    }

    const timer = setTimeout(() => {
      const current = get()
      // Only show hints if hold wasn't cancelled and CMD is still reflected
      if (!current._holdCancelled && current.activeModifiers.command) {
        set({ isShowingHints: true, hintHoldTimer: null })
      }
    }, HINT_HOLD_THRESHOLD_MS)

    set({ hintHoldTimer: timer, _holdCancelled: false })
  },

  cancelHintHold() {
    const state = get()
    if (state.hintHoldTimer) {
      clearTimeout(state.hintHoldTimer)
    }
    set({
      hintHoldTimer: null,
      isShowingHints: false,
      _holdCancelled: true,
    })
  },

  setShowingHints(show) {
    set({ isShowingHints: show })
  },

  updateModifiers(modifiers) {
    const prev = get().activeModifiers

    // CMD just pressed
    if (modifiers.command && !prev.command) {
      set({ activeModifiers: modifiers, _holdCancelled: false })
      get().startHintHold()
      return
    }

    // CMD released
    if (!modifiers.command && prev.command) {
      const state = get()
      if (state.hintHoldTimer) {
        clearTimeout(state.hintHoldTimer)
      }
      set({
        activeModifiers: { ...NO_MODIFIERS },
        hintHoldTimer: null,
        isShowingHints: false,
      })
      return
    }

    // CMD still held, other modifiers changed
    if (modifiers.command) {
      set({ activeModifiers: modifiers })
    }
  },
}))
