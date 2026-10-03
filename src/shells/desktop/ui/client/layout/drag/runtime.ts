// The pure state machine of a drag. The dispatcher turns DOM and shell
// events into DragEvents and runs the DragEffects each step returns; the
// runtime itself never touches the DOM, the shell or the document.

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
        crossWindow: null,
      }
      const effects: DragEffect[] = [
        { kind: 'set-body-class', cls: 'canvas-interacting', on: true },
      ]
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
      let crossWindow = prev.state.crossWindow

      if (wasInside && !event.insideWindow && !crossWindowActive && event.crossWindow) {
        effects.push({ kind: 'cross-window-start', drag: event.crossWindow, screen: event.screen })
        crossWindowActive = true
        crossWindow = event.crossWindow
      } else if (!wasInside && event.insideWindow && crossWindowActive && crossWindow) {
        effects.push({ kind: 'cross-window-cancel', drag: crossWindow })
        crossWindowActive = false
        crossWindow = null
      }

      const state: DragState = {
        ...prev.state,
        cursor: {
          client: event.client,
          screen: event.screen,
          insideWindow: event.insideWindow,
        },
        crossWindow,
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
      } else if (prev.crossWindowActive && prev.state.crossWindow) {
        effects.push({ kind: 'cross-window-cancel', drag: prev.state.crossWindow })
      }
      effects.push(...cleanupEffects(prev))
      return { ...initial, effects }
    }

    case 'CANCEL': {
      const effects: DragEffect[] = []
      if (prev.crossWindowActive && prev.state.crossWindow) {
        effects.push({ kind: 'cross-window-cancel', drag: prev.state.crossWindow })
      }
      effects.push(...cleanupEffects(prev))
      return { ...initial, effects }
    }
  }
}

function cleanupEffects(prev: RuntimeState): DragEffect[] {
  if (!prev.armed) return []
  return [{ kind: 'set-body-class', cls: 'canvas-interacting', on: false }]
}

function withNoEffects(prev: RuntimeState): RuntimeState {
  if (prev.effects.length === 0) return prev
  return { ...prev, effects: [] }
}
