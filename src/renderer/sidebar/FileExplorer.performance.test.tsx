import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { FsWatchEvent } from '../lib/fs/fsWatchManager'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({ watch: vi.fn(), read: vi.fn(), open: vi.fn() }))
vi.mock('../lib/fs/fsWatchManager', () => ({ watchFsRoot: mocks.watch }))
vi.mock('../stores/gitStatusStore', () => ({ useGitTreeFor: () => undefined }))
vi.mock('../stores/appStore', () => ({ useAppStore: (selector: (state: unknown) => unknown) => selector({ selectedWorkspaceId: 'ws', createTerminal: vi.fn(), removeWorkspace: vi.fn() }) }))
vi.mock('../lib/fs/fileRouting', () => ({ openFileAsPanel: mocks.open }))
import { FileExplorer } from './FileExplorer'

afterEach(() => vi.useRealTimers())

it('expands through the shared queue, refreshes one directory, and navigates virtual rows', async () => {
  vi.useFakeTimers()
  let event!: (value: FsWatchEvent) => void
  mocks.watch.mockImplementation((_root, callback) => { event = callback; return vi.fn() })
  const file = (path: string, isDirectory = false) => ({ path, name: path.split('/').pop(), isDirectory, fileExtension: 'ts' })
  let extra = false
  mocks.read.mockImplementation(async (path: string) => path === '/repo'
    ? [file('/repo/a', true), file('/repo/b', true)]
    : Array.from({ length: 1000 + (extra ? 1 : 0) }, (_, index) => file(`${path}/${index}.ts`)))
  Object.assign(window, { electronAPI: { fsReadDir: mocks.read, onSettingsChanged: () => vi.fn() } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(<FileExplorer rootPath="/repo" />) })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    await act(async () => host.querySelector<HTMLElement>('[data-filepath="/repo/a"]')!.click())
    expect(host.querySelectorAll('[data-filepath]').length).toBeLessThan(40)
    expect(host.querySelector('[data-filepath="/repo/a/0.ts"]')).not.toBeNull()
    mocks.read.mockClear()
    await act(async () => {
      event({ type: 'update', path: '/repo/a/0.ts' })
      extra = true
      event({ type: 'create', path: '/repo/a/1000.ts' })
      await vi.advanceTimersByTimeAsync(150)
    })
    expect(mocks.read.mock.calls).toEqual([['/repo/a', 'ws']])
    const scroll = host.querySelector<HTMLElement>('[data-sidebar-keynav]')!
    for (let index = 0; index < 40; index++) {
      await act(async () => scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    }
    expect(host.querySelector('[data-filepath="/repo/a/39.ts"]')).not.toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})

it('paints a warm expanded tree while revalidation is still pending', async () => {
  const file = (path: string, isDirectory = false) => ({ path, name: path.split('/').pop(), isDirectory, fileExtension: 'ts' })
  mocks.watch.mockReturnValue(vi.fn())
  let hold = false
  const pending: Array<(value: unknown[]) => void> = []
  mocks.read.mockImplementation((path: string) => {
    if (hold) return new Promise((resolve) => pending.push(resolve))
    return Promise.resolve(path === '/warm-a' ? [file('/warm-a/sub', true)]
      : path === '/warm-a/sub' ? [file('/warm-a/sub/leaf.ts')] : [file('/warm-b/other.ts')])
  })
  Object.assign(window, { electronAPI: { fsReadDir: mocks.read, onSettingsChanged: () => vi.fn() } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<FileExplorer rootPath="/warm-a" />))
    await act(async () => host.querySelector<HTMLElement>('[data-filepath="/warm-a/sub"]')!.click())
    expect(host.querySelector('[data-filepath="/warm-a/sub/leaf.ts"]')).not.toBeNull()
    await act(async () => root.render(<FileExplorer rootPath="/warm-b" />))
    hold = true
    await act(async () => root.render(<FileExplorer rootPath="/warm-a" />))
    expect(pending.length).toBeGreaterThan(0)
    expect(host.querySelector('[data-filepath="/warm-a/sub/leaf.ts"]')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    pending.forEach((resolve) => resolve([]))
    host.remove()
  }
})
