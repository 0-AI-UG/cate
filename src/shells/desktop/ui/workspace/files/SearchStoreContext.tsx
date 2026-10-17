import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import type { SearchState, SearchStore } from './searchStore'

export const SearchStoreContext = createContext<SearchStore | null>(null)

export function useSearchStoreContext<T>(selector: (state: SearchState) => T): T {
  const store = useContext(SearchStoreContext)
  if (!store) throw new Error('SearchStoreContext is required')
  return useStore(store, selector)
}
