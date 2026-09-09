import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { expect, it, vi } from 'vitest'
import { SearchView } from './SearchView'

vi.mock('./useGitTree', () => ({ useGitTree: () => ({}) }))
vi.mock('./SearchResultsTree', () => ({ SearchResultsTree: ({ files }: any) => <div>{files.map((f: any) => f.path).join(',')}</div> }))
vi.mock('../ui/Tooltip', () => ({ Tooltip: ({ children }: any) => children }))
it('keeps queries and streamed results independent in two worktrees', async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const listeners = new Set<(value: any) => void>()
  Object.assign(window.electronAPI, {
    searchStart: vi.fn().mockResolvedValue(''), searchCancel: vi.fn().mockResolvedValue(undefined),
    onSearchResult: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn) },
    onSearchDone: () => () => {},
  })
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<><section data-a><SearchView rootPath="/a" workspaceId="w" /></section><section data-b><SearchView rootPath="/b" workspaceId="w" /></section></>))
    const input = host.querySelector<HTMLInputElement>('[data-a] input')!
    await act(async () => { input.value = 'needle'; Simulate.change(input) })
    expect(host.querySelector<HTMLInputElement>('[data-b] input')!.value).toBe('')
    const otherInput = host.querySelector<HTMLInputElement>('[data-b] input')!
    await act(async () => { otherInput.value = 'other'; Simulate.change(otherInput) })
    expect(input.value).toBe('needle')
    await act(async () => { await new Promise(r => setTimeout(r, 280)) })
    const searchId = vi.mocked(window.electronAPI.searchStart).mock.calls.find(call => call[0] === '/a')![1]
    await act(async () => listeners.forEach(fn => fn({ searchId, files: [{ path: '/a/result.ts', lines: [{ line: 1, text: 'needle', ranges: [{ start: 0, end: 6 }] }] }] })))
    expect(host.querySelector('[data-a]')!.textContent).toContain('/a/result.ts')
    expect(host.querySelector('[data-b]')!.textContent).not.toContain('/a/result.ts')
    const otherId = vi.mocked(window.electronAPI.searchStart).mock.calls.find(call => call[0] === '/b')![1]
    expect(otherId).not.toBe(searchId)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-a] [aria-label="Clear search"]')!.click())
    expect(window.electronAPI.searchCancel).toHaveBeenCalledWith(searchId)
    expect(window.electronAPI.searchCancel).not.toHaveBeenCalledWith(otherId)
    expect(otherInput.value).toBe('other')
  } finally {
    await act(async () => root.unmount()); host.remove()
  }
})
