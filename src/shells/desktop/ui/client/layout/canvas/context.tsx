// The canvas view store of the canvas being rendered, and the screen-level
// overlay layers its chrome portals into.

import React, { createContext, useContext } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import type { CanvasView, CanvasViewStore } from './store'

const CanvasViewContext = createContext<CanvasViewStore | null>(null)

export function CanvasViewProvider({ store, children }: { store: CanvasViewStore; children?: React.ReactNode }): React.ReactElement {
  return <CanvasViewContext.Provider value={store}>{children}</CanvasViewContext.Provider>
}

export function useCanvasViewStore(): CanvasViewStore {
  const store = useContext(CanvasViewContext)
  if (!store) throw new Error('useCanvasViewStore outside a canvas')
  return store
}

export function useCanvasView<T>(selector: (s: CanvasView) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useStoreWithEqualityFn(useCanvasViewStore(), selector, isEqual)
}

export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

// Browser guests live in a fixed host outside the transformed canvas. Chrome
// that must paint above every panel portals into this screen-level layer.
export const CanvasTopOverlayContext = createContext<HTMLElement | null>(null)

export function useCanvasTopOverlayTarget(): HTMLElement | null {
  return useContext(CanvasTopOverlayContext)
}

// Relation controls get their own stacking context above browser surfaces.
// `undefined`: no canvas (tests); `null`: the host has not mounted yet.
export const CanvasRelationOverlayContext = createContext<HTMLElement | null | undefined>(undefined)

export function useCanvasRelationOverlayTarget(): HTMLElement | null | undefined {
  return useContext(CanvasRelationOverlayContext)
}
