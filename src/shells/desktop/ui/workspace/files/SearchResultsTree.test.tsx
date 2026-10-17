import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SearchStoreContext } from './SearchStoreContext'
import { createSearchStore } from './searchStore'
import { SearchResultsTree } from './SearchResultsTree'
import { FileViewsContext, type FileViewsHost } from './FileViewsContext'

vi.mock('./FileTreeNode', () => ({ getFileIcon: () => ({ icon: null, color: 'inherit' }) }))

it('opens a search match in the containing Files panel at its line and column', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const onOpenMatch = vi.fn()
  const host$ = { openFiles: vi.fn(), openMatch: vi.fn(), openTerminal: vi.fn() } satisfies FileViewsHost
  try {
    act(() => root.render(<FileViewsContext.Provider value={host$}><SearchStoreContext.Provider value={createSearchStore()}><SearchResultsTree workspaceId="ws" onOpenMatch={onOpenMatch} files={[{
      path: '/project/index.ts', relativePath: 'index.ts', matchCount: 1,
      lines: [{ line: 42, text: 'const value = 1', ranges: [{ start: 6, end: 11 }] }],
    }]} /></SearchStoreContext.Provider></FileViewsContext.Provider>))
    const result = host.querySelector<HTMLElement>('[data-testid="search-line"]')!
    expect(result).not.toBeNull()
    act(() => result.click())
    expect(onOpenMatch).toHaveBeenCalledWith('/project/index.ts', 42, 7)
    expect(host$.openMatch).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('opens a match through the host when no handler is given', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const views = { openFiles: vi.fn(), openMatch: vi.fn(), openTerminal: vi.fn() } satisfies FileViewsHost
  try {
    act(() => root.render(<FileViewsContext.Provider value={views}><SearchStoreContext.Provider value={createSearchStore()}><SearchResultsTree workspaceId="ws" files={[{
      path: '/project/index.ts', relativePath: 'index.ts', matchCount: 1,
      lines: [{ line: 3, text: 'x', ranges: [{ start: 0, end: 1 }] }],
    }]} /></SearchStoreContext.Provider></FileViewsContext.Provider>))
    act(() => host.querySelector<HTMLElement>('[data-testid="search-line"]')!.click())
    expect(views.openMatch).toHaveBeenCalledWith('ws', '/project/index.ts', 3, 1)
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
