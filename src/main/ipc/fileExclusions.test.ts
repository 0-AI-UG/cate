import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest'
import type { FileSearchResult, FileTreeNode } from '../../shared/types'
import { FILE_EXCLUSIONS } from '../../shared/types'

// Capture the handlers registered via ipcMain.handle so we can invoke them
// directly without a live Electron main process.
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

vi.mock('../windowRegistry', () => ({
  windowFromEvent: () => undefined,
  sendToWindow: vi.fn(),
}))

const { registerHandlers } = await import('./filesystem')
const { addAllowedRoot, removeAllowedRoot } = await import('./pathValidation')
const { FS_READ_DIR, FS_SEARCH } = await import('../../shared/ipc-channels')
const { registerTestDaemonRuntime } = await import('../runtime/testHarness')

registerHandlers()
registerTestDaemonRuntime(FILE_EXCLUSIONS)
const readDirHandler = handlers.get(FS_READ_DIR)!
const searchHandler = handlers.get(FS_SEARCH)!
const fakeEvent = { sender: {} } as unknown

const readDir = async (p: string): Promise<FileTreeNode[]> => {
  return readDirHandler(fakeEvent, p, 'local') as Promise<FileTreeNode[]>
}
const search = async (root: string, q: string): Promise<FileSearchResult[]> => {
  return searchHandler(fakeEvent, root, q, undefined, 'local') as Promise<FileSearchResult[]>
}
const names = (nodes: FileTreeNode[]) => nodes.map((n) => n.name).sort()
const relPaths = (results: FileSearchResult[]) => results.map((r) => r.relativePath).sort()

describe('file exclusions across explorer + search', () => {
  let root: string

  beforeEach(async () => {
    // realpath so the registered allowed root matches validatePathStrict's
    // symlink-resolved comparison (e.g. /tmp → /private/tmp on macOS).
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-excl-')))
    addAllowedRoot(root, 'local')

    await fs.writeFile(path.join(root, 'keep.txt'), 'alpha', 'utf8')

    // An excluded-by-name folder, with content inside it.
    await fs.mkdir(path.join(root, 'node_modules'))
    await fs.writeFile(path.join(root, 'node_modules', 'pkg.txt'), 'alpha', 'utf8')

    // A real subtree containing a *file* whose basename collides with an
    // exclusion name — the case the PR's watcher fix is meant to align with.
    await fs.mkdir(path.join(root, 'src'))
    await fs.writeFile(path.join(root, 'src', 'app.txt'), 'alpha', 'utf8')
    await fs.writeFile(path.join(root, 'src', 'node_modules'), 'alpha', 'utf8')
  })

  afterEach(async () => {
    removeAllowedRoot(root, 'local')
    await fs.rm(root, { recursive: true, force: true })
  })

  test('readDir hides an internally excluded folder by exact name', async () => {
    expect(names(await readDir(root))).toEqual(['keep.txt', 'src'])
  })

  test('readDir hides a same-named file at a nested level (exact-name, any depth)', async () => {
    // The folder-vs-file distinction does not matter: a file named like an
    // exclusion is dropped too, matching how the watcher now ignores both
    // `**/<name>` and `**/<name>/**`.
    expect(names(await readDir(path.join(root, 'src')))).toEqual(['app.txt'])
  })

  test('search skips excluded folders and same-named files', async () => {
    // Name-only search: 'txt' matches keep.txt and src/app.txt by name.
    const found = relPaths(await search(root, 'txt'))
    expect(found).toEqual(['keep.txt', 'src/app.txt'])
    // Nothing under node_modules/, and not the src/node_modules file either.
    expect(found.some((p) => p.includes('node_modules'))).toBe(false)
  })
})
