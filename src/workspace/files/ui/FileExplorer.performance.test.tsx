import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { FsChange } from '../contract'
import { FileTreeModel, type FileTreeFs, type FileTreeModelOptions } from './fileTreeModel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({ watch: vi.fn(), read: vi.fn() }))
vi.mock('./gitTree', () => ({ useGitTree: () => undefined }))
import { FileExplorer } from './FileExplorer'

const fs = () => ({ readDir: mocks.read }) as unknown as FileTreeFs
const options = (extra: Partial<FileTreeModelOptions> = {}): FileTreeModelOptions => ({ fs, watch: mocks.watch, ...extra })
const resources = new Map<string, FileTreeModel>()
function resource(path: string): FileTreeModel {
  let owner = resources.get(path)
  // The owner activates the model; the view only renders it.
  if (!owner) { owner = new FileTreeModel(path, 'ws', options()); owner.activate(); resources.set(path, owner) }
  return owner
}
afterEach(() => { for (const owner of resources.values()) owner.dispose(); resources.clear(); vi.useRealTimers() })
const file = (path: string, isDirectory = false) => ({ path, name: path.split('/').pop(), isDirectory, extension: isDirectory ? '' : 'ts' })

it('expands through the shared queue, refreshes one directory, and navigates virtual rows', async () => {
  vi.useFakeTimers()
  let event!: (value: FsChange) => void
  mocks.watch.mockImplementation((_ws, _root, callback) => { event = callback; return vi.fn() })
  let extra = false
  mocks.read.mockImplementation(async (path: string) => path === '/repo'
    ? [file('/repo/a', true), file('/repo/b', true)]
    : Array.from({ length: 1000 + (extra ? 1 : 0) }, (_, index) => file(`${path}/${index}.ts`)))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(<FileExplorer resource={resource('/repo')} workspaceId="ws" rootPath="/repo" />) })
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
    expect(mocks.read.mock.calls).toEqual([['/repo/a']])
    const scroll = host.querySelector<HTMLElement>('[data-sidebar-keynav]')!
    for (let index = 0; index < 40; index++) {
      await act(async () => scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    }
    expect(host.querySelector('[data-filepath="/repo/a/39.ts"]')).not.toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})

it('paints a warm expanded tree while revalidation is still pending', async () => {
  mocks.watch.mockReturnValue(vi.fn())
  let hold = false
  const pending: Array<(value: unknown[]) => void> = []
  mocks.read.mockImplementation((path: string) => {
    if (hold) return new Promise((resolve) => pending.push(resolve))
    return Promise.resolve(path === '/warm-a' ? [file('/warm-a/sub', true)]
      : path === '/warm-a/sub' ? [file('/warm-a/sub/leaf.ts')] : [file('/warm-b/other.ts')])
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<FileExplorer resource={resource('/warm-a')} workspaceId="ws" rootPath="/warm-a" />))
    await act(async () => host.querySelector<HTMLElement>('[data-filepath="/warm-a/sub"]')!.click())
    expect(host.querySelector('[data-filepath="/warm-a/sub/leaf.ts"]')).not.toBeNull()
    await act(async () => root.render(<FileExplorer resource={resource('/warm-b')} workspaceId="ws" rootPath="/warm-b" />))
    hold = true
    const warm = resource('/warm-a')
    const seed = warm.getSnapshot()
    warm.dispose()
    const revalidating = new FileTreeModel('/warm-a', 'ws', options({ seed }))
    revalidating.activate()
    resources.set('/warm-a', revalidating)
    await act(async () => root.render(<FileExplorer resource={resource('/warm-a')} workspaceId="ws" rootPath="/warm-a" />))
    expect(pending.length).toBeGreaterThan(0)
    expect(host.querySelector('[data-filepath="/warm-a/sub/leaf.ts"]')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    pending.forEach((resolve) => resolve([]))
    host.remove()
  }
})

it('shows read failures instead of an empty folder and recovers on retry', async () => {
  vi.useFakeTimers()
  mocks.watch.mockReturnValue(vi.fn())
  mocks.read.mockRejectedValue(new Error('connection lost'))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<FileExplorer resource={resource('/read-failure')} workspaceId="ws" rootPath="/read-failure" />))
    await act(async () => { await vi.runAllTimersAsync() })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load files')
    expect(host.textContent).not.toContain('No files found')
    mocks.read.mockResolvedValue([file('/read-failure/file.ts')])
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click())
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[data-filepath="/read-failure/file.ts"]')).not.toBeNull()
  } finally { await act(async () => root.unmount()); host.remove() }
})
