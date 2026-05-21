// =============================================================================
// drag/runtime — pure state machine for a drag operation.
//
// The dispatcher (useDragOp) translates DOM/IPC events into DragEvents and
// feeds them through reduce(). The runtime produces an updated RuntimeState
// plus a list of DragEffects the dispatcher must perform (set DOM attributes,
// call IPC, push canvas history, commit the drop, etc.).
//
// The runtime never touches DOM, IPC, React, or stores — that's the whole point
// of the split. Unit-testable from a vitest file with no jsdom shim.
// =============================================================================

import {
  INITIAL_RUNTIME_STATE,
  type DragEffect,
  type DragEvent,
  type DragState,
  type RuntimeState,
} from './types'

export const initial: RuntimeState = INITIAL_RUNTIME_STATE

/** Pure reducer. Returns a new RuntimeState whose `effects` are the effects
 *  produced by this single step. Callers must drain `.effects` between calls
 *  (they aren't carried forward). */
export function reduce(prev: RuntimeState, event: DragEvent): RuntimeState {
  switch (event.type) {
    case 'START': {
      const state: DragState = {
        isDragging: true,
        source: event.source,
        panel: event.panel,
        grab: event.grab,
        ghostSize: event.ghostSize,
        ghostZoom: event.ghostZoom,
        cursor: {
          client: event.cursor,
          screen: event.cursor,
          insideWindow: true,
        },
        target: null,
        crossWindowSnapshot: null,
      }
      const effects: DragEffect[] = [
        { kind: 'set-body-class', cls: 'canvas-interacting', on: true },
      ]
      if (event.source.origin.kind === 'canvas-node') {
        effects.push({ kind: 'push-history' })
      }
      return {
        state,
        armed: true,
        crossWindowActive: false,
        effects,
      }
    }

    case 'MOVE': {
      if (!prev.armed || !prev.state.isDragging) return withNoEffects(prev)
      const effects: DragEffect[] = []
      const wasInside = prev.state.cursor?.insideWindow ?? true
      let crossWindowActive = prev.crossWindowActive
      let crossWindowSnapshot = prev.state.crossWindowSnapshot

      // Cross-window transitions.
      if (wasInside && !event.insideWindow && !crossWindowActive && event.snapshot) {
        effects.push({
          kind: 'cross-window-start',
          snapshot: event.snapshot,
          screen: event.screen,
        })
        crossWindowActive = true
        crossWindowSnapshot = event.snapshot
      } else if (!wasInside && event.insideWindow && crossWindowActive) {
        effects.push({ kind: 'cross-window-cancel' })
        crossWindowActive = false
        crossWindowSnapshot = null
      }

      const state: DragState = {
        ...prev.state,
        cursor: {
          client: event.client,
          screen: event.screen,
          insideWindow: event.insideWindow,
        },
        crossWindowSnapshot,
      }
      return { ...prev, state, crossWindowActive, effects }
    }

    case 'TARGET': {
      if (!prev.armed || !prev.state.isDragging) return withNoEffects(prev)
      return {
        ...prev,
        state: { ...prev.state, target: event.target },
        effects: [],
      }
    }

    case 'CROSS_WINDOW_OPEN': {
      return {
        ...prev,
        crossWindowActive: true,
        state: { ...prev.state, crossWindowSnapshot: event.snapshot },
        effects: [],
      }
    }

    case 'CROSS_WINDOW_CLOSE': {
      return {
        ...prev,
        crossWindowActive: false,
        state: { ...prev.state, crossWindowSnapshot: null },
        effects: [],
      }
    }

    case 'END': {
      if (!prev.armed || !prev.state.isDragging) {
        // Idempotent: ensure cleanup effects are still emitted exactly once
        // when the dispatcher tears down even an un-armed drag.
        return { ...initial, effects: cleanupEffects(prev) }
      }
      const effects: DragEffect[] = []
      const { source, target, panel } = prev.state
      if (target && source && panel) {
        effects.push({ kind: 'commit', source, target, panel })
      } else if (prev.crossWindowActive) {
        effects.push({ kind: 'cross-window-cancel' })
      }
      effects.push(...cleanupEffects(prev))
      return { ...initial, effects }
    }

    case 'CANCEL': {
      const effects: DragEffect[] = []
      if (prev.crossWindowActive) {
        effects.push({ kind: 'cross-window-cancel' })
      }
      effects.push(...cleanupEffects(prev))
      return { ...initial, effects }
    }
  }
}

function cleanupEffects(prev: RuntimeState): DragEffect[] {
  if (!prev.armed) return [{ kind: 'clear-state' }]
  return [
    { kind: 'set-body-class', cls: 'canvas-interacting', on: false },
    { kind: 'clear-state' },
  ]
}

function withNoEffects(prev: RuntimeState): RuntimeState {
  if (prev.effects.length === 0) return prev
  return { ...prev, effects: [] }
}
