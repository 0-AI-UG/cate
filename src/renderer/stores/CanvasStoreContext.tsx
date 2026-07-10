// =============================================================================
// Canvas Store Context — provides a canvas store instance via React context.
// Allows multiple canvas stores to coexist (e.g., dock zones, panel windows).
// =============================================================================

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import type { StoreApi } from 'zustand'
import type { CanvasStore } from './canvasStore'
export { shallow } from 'zustand/shallow'

const CanvasStoreContext = createContext<StoreApi<CanvasStore> | null>(null)

export function CanvasStoreProvider({ store, children }: {
  store: StoreApi<CanvasStore>
  children: React.ReactNode
}) {
  return (
    <CanvasStoreContext.Provider value={store}>
      {children}
    </CanvasStoreContext.Provider>
  )
}

/** Returns the StoreApi for use in event handlers / callbacks (.getState()) */
export function useCanvasStoreApi(): StoreApi<CanvasStore> {
  const store = useContext(CanvasStoreContext)
  if (!store) throw new Error('CanvasStoreProvider is required')
  return store
}

export function useOptionalCanvasStoreApi(): StoreApi<CanvasStore> | null {
  return useContext(CanvasStoreContext)
}

export function useOptionalCanvasStoreContext<T>(
  selector: (state: CanvasStore) => T,
  fallback: T,
): T {
  const store = useContext(CanvasStoreContext)
  const subscribe = useCallback(
    (onStoreChange: () => void) => store?.subscribe(onStoreChange) ?? (() => {}),
    [store],
  )
  const getSnapshot = useCallback(
    () => store ? selector(store.getState()) : fallback,
    [store, selector, fallback],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Reactive selector hook — reads from the context-provided canvas store */
export function useCanvasStoreContext<T>(
  selector: (s: CanvasStore) => T,
  equalityFn?: (a: T, b: T) => boolean,
): T {
  const store = useContext(CanvasStoreContext)
  if (!store) throw new Error('CanvasStoreProvider is required')
  return useStoreWithEqualityFn(store, selector, equalityFn)
}
