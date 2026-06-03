// =============================================================================
// SettingsSearchContext — drives live filtering of settings rows/blocks.
//
// SettingsWindow provides a lowercased+trimmed `query` per section, plus
// `sectionMatched` (true when the query matches the section's own title, so the
// whole section is shown). SettingRow and SearchableBlock consume this to hide
// themselves when they don't match. Default value makes those components behave
// normally when rendered outside the provider.
// =============================================================================

import { createContext, useContext } from 'react'

export interface SettingsSearchState {
  /** Lowercased, trimmed search query. Empty string = no active search. */
  query: string
  /** True when the active query matches the enclosing section's title. */
  sectionMatched: boolean
}

export const SettingsSearchContext = createContext<SettingsSearchState>({
  query: '',
  sectionMatched: false,
})

export function useSettingsSearch(): SettingsSearchState {
  return useContext(SettingsSearchContext)
}

/** True when `query` is empty or `text` contains it (case-insensitive). */
export function matchesQuery(text: string | undefined, query: string): boolean {
  if (query === '') return true
  return (text ?? '').toLowerCase().includes(query)
}
