// Transient observation of cross-panel agent work, drawn as connections. The
// `cate` call stays authoritative; this only mirrors the lifecycle of an
// already resolved interaction. Never persisted, never holds request
// arguments (prompts, typed text, URLs).

import { create } from 'zustand'

export type PanelInteractionKind = 'read' | 'control' | 'create' | 'agent'
export type PanelInteractionPhase = 'active' | 'succeeded' | 'failed'

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

// Browser-control calls often finish in a few hundred ms: hold the active
// look long enough to read, then keep the result visible before it fades.
const MIN_ACTIVE_MS = 5_000
const SETTLED_HOLD_MS = 30_000
const FADE_MS = 10_000
const lifecycleTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const usePanelInteractionStore = create<PanelInteractionState>(() => ({ interactions: {} }))

function interactionKey(workspaceId: string, sourcePanelId: string, targetPanelId: string): string {
  return `${workspaceId}\0${sourcePanelId}\0${targetPanelId}`
}

/** Begins one resolved cross-panel operation. The returned callback completes
 *  exactly that operation; repeated calls are ignored. */
export function beginPanelInteraction(input: {
  workspaceId: string
  sourcePanelId: string
  targetPanelId: string
  kind: PanelInteractionKind
}): (succeeded: boolean) => void {
  const { workspaceId, sourcePanelId, targetPanelId, kind } = input
  if (!workspaceId || !sourcePanelId || !targetPanelId || sourcePanelId === targetPanelId) return () => {}

  const key = interactionKey(workspaceId, sourcePanelId, targetPanelId)
  const pending = lifecycleTimers.get(key)
  if (pending) {
    clearTimeout(pending)
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
      // A short call stays active until the minimum window passes; a new call
      // for the pair cancels the pending settle.
      return { interactions: { ...state.interactions, [key]: { ...current, phase: 'active', activeCount } } }
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
            [key]: { ...current, phase: succeeded ? 'succeeded' : 'failed', updatedAt: Date.now() },
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

    if (settleDelay === 0) settle()
    else lifecycleTimers.set(key, setTimeout(settle, settleDelay))
  }
}

export function clearPanelInteractions(): void {
  for (const timer of lifecycleTimers.values()) clearTimeout(timer)
  lifecycleTimers.clear()
  usePanelInteractionStore.setState({ interactions: {} })
}
