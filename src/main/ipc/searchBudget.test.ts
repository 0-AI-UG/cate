import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FileSearchResult } from '../../shared/types'

// Capture ipcMain.handle registrations so we can call the search handler
// directly, mirroring fileExclusions.test.ts.
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))
vi.mock('../windowRegistry', () => ({ windowFromEvent: () => undefined, sendToWindow: vi.fn() }))
vi.mock('../store', () => ({ getSettingSync: (k: string) => (k === 'fileExclusions' ? [] : undefined) }))

const { registerHandlers } = await import('./filesystem')
const { addAllowedRoot, removeAllowedRoot } = await import('./pathValidation')
const { FS_SEARCH } = await import('../../shared/ipc-channels')

registerHandlers()
const searchHandler = handlers.get(FS_SEARCH)!
const fakeEvent = { sender: {} } as unknown
const search = (root: string, q: string, max: number) =>
  searchHandler(fakeEvent, root, q, { maxResults: max }) as Promise<FileSearchResult[]>

describe('search content-vs-name budgets', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-budget-')))
    addAllowedRoot(root)
  })

  afterEach(async () => {
    removeAllowedRoot(root)
    await fs.rm(root, { recursive: true, force: true })
  })

  // The regression: a flood of file-name matches used to fill the shared result
  // cap before the depth-first walk recursed into deep dirs, so in-file matches
  // there were never found ("Cmd+K stopped searching inside files").
  test('a flood of name matches does not starve deep content matches', async () => {
    const max = 50
    // More name-only matches than the entire cap, all at the shallow level.
    for (let i = 0; i < max + 30; i++) {
      await fs.writeFile(path.join(root, `widget-${i}.txt`), 'nothing relevant', 'utf8')
    }
    // A content-only match buried several directories deep.
    const deep = path.join(root, 'a', 'b', 'c', 'd')
    await fs.mkdir(deep, { recursive: true })
    await fs.writeFile(path.join(deep, 'real.txt'), 'the widget lives here', 'utf8')

    const res = await search(root, 'widget', max)
    const content = res.filter((r) => !r.nameMatch)

    expect(res.length).toBeLessThanOrEqual(max)
    expect(content.length).toBeGreaterThan(0)
    expect(content.some((r) => r.relativePath.endsWith('a/b/c/d/real.txt'))).toBe(true)
    // Name matches still dominate the result (they rank first and keep most slots).
    expect(res.filter((r) => r.nameMatch).length).toBeGreaterThan(content.length)
  })

  // No name matches at all → content matches may use the full cap (no regression
  // for pure in-file search).
  test('content matches can fill the cap when no names match', async () => {
    const max = 20
    for (let i = 0; i < max + 10; i++) {
      await fs.writeFile(path.join(root, `note-${i}.txt`), 'contains needle text', 'utf8')
    }
    const res = await search(root, 'needle', max)
    expect(res.length).toBe(max)
    expect(res.every((r) => !r.nameMatch)).toBe(true)
  })

  test('name matches still rank ahead of content matches', async () => {
    await fs.writeFile(path.join(root, 'needle.txt'), 'unrelated', 'utf8')
    await fs.writeFile(path.join(root, 'other.txt'), 'has a needle inside', 'utf8')
    const res = await search(root, 'needle', 50)
    expect(res[0].nameMatch).toBe(true)
    expect(res[0].name).toBe('needle.txt')
    expect(res.some((r) => !r.nameMatch && r.relativePath === 'other.txt')).toBe(true)
  })
})
