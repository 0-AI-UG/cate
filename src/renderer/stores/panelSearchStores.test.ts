// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { panelSearchStore, releasePanelSearchStore } from './panelSearchStores'

describe('panel search lifetime', () => {
  it('retains the same panel state while isolating other panels and root changes', () => {
    const first = panelSearchStore('first', '/repo')
    first.getState().setQuery('retained')
    expect(panelSearchStore('first', '/repo').getState().query).toBe('retained')
    expect(panelSearchStore('second', '/repo').getState().query).toBe('')
    expect(panelSearchStore('first', '/other').getState().query).toBe('')
    releasePanelSearchStore('first'); releasePanelSearchStore('second')
  })
  it('cancels only the removed panel request and forgets its state', () => {
    Object.assign(window.electronAPI, { searchCancel: vi.fn().mockResolvedValue(undefined) })
    const first = panelSearchStore('first', '/repo')
    const second = panelSearchStore('second', '/repo')
    first.getState().beginSearch('one', 'query')
    second.getState().beginSearch('two', 'other query')
    releasePanelSearchStore('first')
    expect(window.electronAPI.searchCancel).toHaveBeenCalledExactlyOnceWith('one')
    expect(second.getState().currentSearchId).toBe('two')
    expect(panelSearchStore('first', '/repo')).not.toBe(first)
    releasePanelSearchStore('first'); releasePanelSearchStore('second')
  })
})

it('schedules persistence for portable options but not result delivery', async () => {
  const { subscribeSessionMutations } = await import('../lib/workspace/sessionMutations')
  const changed = vi.fn(), off = subscribeSessionMutations(changed)
  const store = panelSearchStore('persist-search', '/repo')
  store.getState().setQuery('recover me')
  store.getState().setOptions({ matchCase: true })
  expect(changed).toHaveBeenCalledTimes(2)
  store.getState().beginSearch('id', 'key')
  store.getState().finishSearch('id', { matches: 0, files: 0, truncated: false })
  expect(changed).toHaveBeenCalledTimes(2)
  off(); releasePanelSearchStore('persist-search')
})
