// =============================================================================
// Dock Store Context — provides a dock store instance via React context.
// Allows multiple dock stores to coexist (main window + detached dock windows).
// =============================================================================

import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand'
import type { DockStore } from './dockStore'

const DockStoreContext = createContext<StoreApi<DockStore> | null>(null)

export function DockStoreProvider({ store, children }: {
  store: StoreApi<DockStore>
  children: React.ReactNode
}) {
  return (
    <DockStoreContext.Provider value={store}>
      {children}
    </DockStoreContext.Provider>
  )
}

/** Returns the StoreApi for use in event handlers / callbacks (.getState()) */
export function useDockStoreApi(): StoreApi<DockStore> {
  const store = useContext(DockStoreContext)
  if (!store) throw new Error('DockStoreProvider is required')
  return store
}

/** Reactive selector hook — reads from the context-provided dock store */
export function useDockStoreContext<T>(selector: (s: DockStore) => T): T {
  const store = useContext(DockStoreContext)
  if (!store) throw new Error('DockStoreProvider is required')
  return useStore(store, selector)
}
