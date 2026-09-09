import { notifySessionMutation } from '../lib/workspace/sessionMutations'
import type { PanelState, PanelSearchSnapshot } from '../../shared/types'
import { useAppStore } from './appStore'
import { createSearchStore, type SearchStore } from './searchStore'

// Search state belongs to the panel, not its temporarily mounted Monaco view.
const stores = new Map<string, { rootPath: string; store: SearchStore; unsubscribe: () => void }>()
export function panelSearchStore(panelId: string, rootPath: string): SearchStore {
  let entry = stores.get(panelId)
  if (!entry || entry.rootPath !== rootPath) {
    releasePanelSearchStore(panelId)
    entry = { rootPath, store: createSearchStore(), unsubscribe: () => {} }
    const saved = useAppStore.getState().workspaces.find(ws => ws.panels[panelId])?.panels[panelId]?.searchState
    if (saved?.rootPath === rootPath) entry.store.setState(searchOptions(saved))
    entry.unsubscribe = entry.store.subscribe((state, previous) => {
      if (Object.keys(searchOptions({ ...state, rootPath })).some(key => state[key as keyof typeof state] !== previous[key as keyof typeof previous])) notifySessionMutation()
    })
    stores.set(panelId, entry)
  }
  return entry.store
}
export function releasePanelSearchStore(panelId: string): void {
  const state = stores.get(panelId)?.store.getState()
  if (state?.currentSearchId && state.status === 'searching') void window.electronAPI.searchCancel(state.currentSearchId).catch(() => {})
  stores.get(panelId)?.unsubscribe()
  stores.delete(panelId)
}

function searchOptions(state: PanelSearchSnapshot) {
  const { query, isRegex, matchCase, wholeWord, includes, excludes, respectIgnore, optionsExpanded } = state
  return { query, isRegex, matchCase, wholeWord, includes, excludes, respectIgnore, optionsExpanded }
}
export function capturePanelSearch(panel: PanelState): PanelState {
  const entry = stores.get(panel.id)
  if (!entry) return panel
  const state = entry.store.getState()
  return { ...panel, searchState: { rootPath: entry.rootPath, ...searchOptions({ ...state, rootPath: entry.rootPath }) } }
}
export function hydratePanelSearch(panel: PanelState): void {
  if (!panel.searchState) return
  releasePanelSearchStore(panel.id)
  panelSearchStore(panel.id, panel.searchState.rootPath).setState(searchOptions(panel.searchState))
}
