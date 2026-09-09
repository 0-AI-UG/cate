import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SearchStoreContext } from '../stores/SearchStoreContext'
import { createSearchStore } from '../stores/searchStore'
import { SearchResultsTree } from './SearchResultsTree'
import { openFileAsPanel } from '../lib/fs/fileRouting'

vi.mock('../lib/fs/fileRouting', () => ({ openFileAsPanel: vi.fn() }))
vi.mock('./FileTreeNode', () => ({ getFileIcon: () => ({ icon: null, color: 'inherit' }) }))

it('opens a search match in the containing Files panel at its line and column', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const onOpenMatch = vi.fn()
  try {
    act(() => root.render(<SearchStoreContext.Provider value={createSearchStore()}><SearchResultsTree onOpenMatch={onOpenMatch} files={[{
      path: '/project/index.ts', relativePath: 'index.ts', matchCount: 1,
      lines: [{ line: 42, text: 'const value = 1', ranges: [{ start: 6, end: 11 }] }],
    }]} /></SearchStoreContext.Provider>))
    const result = host.querySelector<HTMLElement>('[data-testid="search-line"]')!
    expect(result).not.toBeNull()
    act(() => result.click())
    expect(onOpenMatch).toHaveBeenCalledWith('/project/index.ts', 42, 7)
    expect(openFileAsPanel).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
