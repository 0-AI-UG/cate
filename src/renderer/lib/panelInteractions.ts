// =============================================================================
// panelInteractions — ephemeral observation state for cross-panel agent work.
//
// The CLI/host action remains authoritative. This store only mirrors the
// lifecycle of an already-resolved panel interaction so the canvas can explain
// what is happening. It is deliberately not persisted and never stores request
// arguments (prompts, typed text, URLs, selectors, etc.).
// =============================================================================

import { create } from 'zustand'

export type PanelInteractionKind = 'read' | 'control' | 'create' | 'agent'
export type PanelInteractionPhase = 'active' | 'succeeded' | 'failed'
export type PanelTargetObserver = (targetPanelId: string) => void

export interface PanelInteraction {
  key: string
  workspaceId: string
  sourcePanelId: string
  targetPanelId: string
  kind: PanelInteractionKind
  phase: PanelInteractionPhase
  activeCount: number
  pulse: number
  updatedAt: number
}

interface PanelInteractionState {
  interactions: Record<string, PanelInteraction>
}

// Fast browser-control calls often complete in a few hundred milliseconds.
// Hold the active treatment long enough to read, then keep the result fully
// visible before the renderer begins its slow fade.
const MIN_ACTIVE_MS = 5_000
const SETTLED_HOLD_MS = 30_000
const FADE_MS = 10_000
const lifecycleTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const usePanelInteractionStore = create<PanelInteractionState>(() => ({ interactions: {} }))

function interactionKey(workspaceId: string, sourcePanelId: string, targetPanelId: string): string {
  return `${workspaceId}\0${sourcePanelId}\0${targetPanelId}`
}

/** Begin one resolved cross-panel operation. The returned callback completes
 * exactly that operation; repeated completion calls are ignored. */
export function beginPanelInteraction(input: {
  workspaceId: string
  sourcePanelId: string
  targetPanelId: string
  kind: PanelInteractionKind
}): (succeeded: boolean) => void {
  const { workspaceId, sourcePanelId, targetPanelId, kind } = input
  if (!workspaceId || !sourcePanelId || !targetPanelId || sourcePanelId === targetPanelId) {
    return () => {}
  }

  const key = interactionKey(workspaceId, sourcePanelId, targetPanelId)
  const pendingLifecycle = lifecycleTimers.get(key)
  if (pendingLifecycle) {
    clearTimeout(pendingLifecycle)
    lifecycleTimers.delete(key)
  }

  usePanelInteractionStore.setState((state) => {
    const previous = state.interactions[key]
    return {
      interactions: {
        ...state.interactions,
        [key]: {
          key,
          workspaceId,
          sourcePanelId,
          targetPanelId,
          kind,
          phase: 'active',
          activeCount: (previous?.activeCount ?? 0) + 1,
          pulse: (previous?.pulse ?? 0) + 1,
          updatedAt: Date.now(),
        },
      },
    }
  })

  let finished = false
  return (succeeded: boolean) => {
    if (finished) return
    finished = true

    let completedPulse = 0
    let shouldSettle = false
    let settleDelay = 0
    usePanelInteractionStore.setState((state) => {
      const current = state.interactions[key]
      if (!current) return state
      const activeCount = Math.max(0, current.activeCount - 1)
      completedPulse = current.pulse
      shouldSettle = activeCount === 0
      settleDelay = Math.max(0, MIN_ACTIVE_MS - (Date.now() - current.updatedAt))
      return {
        interactions: {
          ...state.interactions,
          [key]: {
            ...current,
            // Keep completed short calls visually active until the minimum
            // active window elapses. A new call for this pair cancels the
            // pending transition and extends the continuous active state.
            phase: 'active',
            activeCount,
          },
        },
      }
    })

    if (!shouldSettle) return
    const settle = () => {
      lifecycleTimers.delete(key)
      let didSettle = false
      usePanelInteractionStore.setState((state) => {
        const current = state.interactions[key]
        if (!current || current.activeCount > 0 || current.pulse !== completedPulse) return state
        didSettle = true
        return {
          interactions: {
            ...state.interactions,
            [key]: {
              ...current,
              phase: succeeded ? 'succeeded' : 'failed',
              updatedAt: Date.now(),
            },
          },
        }
      })
      if (!didSettle) return

      const expiry = setTimeout(() => {
        lifecycleTimers.delete(key)
        usePanelInteractionStore.setState((state) => {
          const current = state.interactions[key]
          if (!current || current.activeCount > 0 || current.pulse !== completedPulse) return state
          const { [key]: _removed, ...interactions } = state.interactions
          return { interactions }
        })
      }, SETTLED_HOLD_MS + FADE_MS)
      lifecycleTimers.set(key, expiry)
    }

    if (settleDelay === 0) {
      settle()
    } else {
      const timer = setTimeout(settle, settleDelay)
      lifecycleTimers.set(key, timer)
    }
  }
}

/** Test/session cleanup. Normal app use relies on expiry and renderer teardown. */
export function clearPanelInteractions(): void {
  for (const timer of lifecycleTimers.values()) clearTimeout(timer)
  lifecycleTimers.clear()
  usePanelInteractionStore.setState({ interactions: {} })
}
