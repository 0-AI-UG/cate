import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchOptions } from '../contract'
import { capturePanelSearch, panelSearchStore, releasePanelSearchStore } from './panelSearchStores'

afterEach(() => { vi.useRealTimers() })

function fakeFs() {
  const cancels: Array<ReturnType<typeof vi.fn>> = []
  const searchContent = vi.fn((_options: SearchOptions) => {
    const cancel = vi.fn()
    cancels.push(cancel)
    return { done: new Promise<never>(() => {}), cancel }
  })
  return { cancels, searchContent, fs: () => ({ searchContent }) }
}

describe('panel search lifetime', () => {
  it('retains the same panel state while isolating other panels and root changes', () => {
    const first = panelSearchStore('first', 'ws', '/repo')
    first.getState().setQuery('retained')
    expect(panelSearchStore('first', 'ws', '/repo').getState().query).toBe('retained')
    expect(panelSearchStore('second', 'ws', '/repo').getState().query).toBe('')
    expect(panelSearchStore('first', 'ws', '/other').getState().query).toBe('')
    releasePanelSearchStore('first'); releasePanelSearchStore('second')
  })

  it('cancels only the removed panel request and forgets its state', async () => {
    vi.useFakeTimers()
    const a = fakeFs()
    const b = fakeFs()
    const first = panelSearchStore('first', 'ws', '/repo', { fs: a.fs })
    const second = panelSearchStore('second', 'ws', '/repo', { fs: b.fs })
    first.getState().setQuery('one')
    second.getState().setQuery('two')
    await vi.advanceTimersByTimeAsync(250)
    const secondId = second.getState().currentSearchId
    releasePanelSearchStore('first')
    expect(a.cancels[0]).toHaveBeenCalledOnce()
    expect(b.cancels[0]).not.toHaveBeenCalled()
    expect(second.getState().currentSearchId).toBe(secondId)
    expect(panelSearchStore('first', 'ws', '/repo')).not.toBe(first)
    releasePanelSearchStore('first'); releasePanelSearchStore('second')
  })

  it('restores saved options for the same root and captures them', () => {
    const saved = { rootPath: '/repo', query: 'q', isRegex: true, matchCase: false, wholeWord: false, includes: '', excludes: '', respectIgnore: true, optionsExpanded: true }
    const store = panelSearchStore('saved', 'ws', '/repo', { saved, fs: fakeFs().fs })
    expect(store.getState().isRegex).toBe(true)
    expect(capturePanelSearch('saved')).toEqual(saved)
    expect(panelSearchStore('saved-other', 'ws', '/elsewhere', { saved }).getState().query).toBe('')
    releasePanelSearchStore('saved'); releasePanelSearchStore('saved-other')
  })
})

it('reports persisted option changes but not result delivery', async () => {
  vi.useFakeTimers()
  const onOptionsChange = vi.fn()
  const store = panelSearchStore('persist-search', 'ws', '/repo', { onOptionsChange, fs: fakeFs().fs })
  store.getState().setQuery('recover me')
  store.getState().setOptions({ matchCase: true })
  expect(onOptionsChange).toHaveBeenCalledTimes(2)
  store.getState().beginSearch('id', 'key')
  store.getState().finishSearch('id', { matches: 0, files: 0, truncated: false })
  expect(onOptionsChange).toHaveBeenCalledTimes(2)
  releasePanelSearchStore('persist-search')
})
