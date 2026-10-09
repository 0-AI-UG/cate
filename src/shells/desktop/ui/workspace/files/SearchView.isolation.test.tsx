import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { expect, it, vi } from 'vitest'
import type { SearchFileResult, SearchOptions } from '@workspace/files/contract'
import { createSearchRunner } from '@workspace/files/client'
import { createSearchStore } from './searchStore'
import { SearchView } from './SearchView'

vi.mock('./gitTree', () => ({ useGitTree: () => ({}) }))
vi.mock('./SearchResultsTree', () => ({ SearchResultsTree: ({ files }: { files: SearchFileResult[] }) => <div>{files.map((f) => f.path).join(',')}</div> }))

interface Run { root: string; options: SearchOptions; onBatch: (files: SearchFileResult[]) => void; cancel: ReturnType<typeof vi.fn> }

it('keeps queries and streamed results independent in two worktrees', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const runs: Run[] = []
  const fs = () => ({
    searchContent: (options: SearchOptions, onBatch: Run['onBatch'], root?: string) => {
      const run = { root: root!, options, onBatch, cancel: vi.fn() }
      runs.push(run)
      return { done: new Promise<never>(() => {}), cancel: run.cancel }
    },
  })
  const first = createSearchRunner(createSearchStore(), '/a', 'w', { fs })
  const second = createSearchRunner(createSearchStore(), '/b', 'w', { fs })
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<><section data-a><SearchView workspaceId="w" store={first.store} rootPath="/a" /></section><section data-b><SearchView workspaceId="w" store={second.store} rootPath="/b" /></section></>))
    const input = host.querySelector<HTMLInputElement>('[data-a] input')!
    await act(async () => { input.value = 'needle'; Simulate.change(input) })
    expect(host.querySelector<HTMLInputElement>('[data-b] input')!.value).toBe('')
    const otherInput = host.querySelector<HTMLInputElement>('[data-b] input')!
    await act(async () => { otherInput.value = 'other'; Simulate.change(otherInput) })
    expect(input.value).toBe('needle')
    await act(async () => { await new Promise((r) => setTimeout(r, 280)) })
    const runA = runs.find((run) => run.root === '/a')!
    const runB = runs.find((run) => run.root === '/b')!
    expect(runA.options.query).toBe('needle')
    await act(async () => runA.onBatch([{ path: '/a/result.ts', relativePath: 'result.ts', matchCount: 1, lines: [{ line: 1, text: 'needle', ranges: [{ start: 0, end: 6 }] }] }]))
    expect(host.querySelector('[data-a]')!.textContent).toContain('/a/result.ts')
    expect(host.querySelector('[data-b]')!.textContent).not.toContain('/a/result.ts')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-a] [aria-label="Clear search"]')!.click())
    expect(runA.cancel).toHaveBeenCalled()
    expect(runB.cancel).not.toHaveBeenCalled()
    expect(otherInput.value).toBe('other')
  } finally {
    await act(async () => root.unmount()); first.dispose(); second.dispose(); host.remove()
  }
})
