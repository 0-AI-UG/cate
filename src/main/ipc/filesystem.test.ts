import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest'

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
const { FS_IMPORT_ENTRIES } = await import('../../shared/ipc-channels')

registerHandlers()
const importEntries = handlers.get(FS_IMPORT_ENTRIES)!
const fakeEvent = { sender: {} } as unknown

// A throwaway event arg + helper to call the handler ergonomically.
function callImport(sources: string[], destDir: string, mode: 'copy' | 'move') {
  return importEntries(fakeEvent, sources, destDir, mode) as Promise<{ created: string[]; failed: number }>
}

describe('FS_IMPORT_ENTRIES', () => {
  let root: string // workspace destination (an allowed root: lives under tmpdir)
  let extern: string // "external" source location

  beforeEach(async () => {
    // realpath so the registered allowed root matches validatePathStrict's
    // symlink-resolved comparison (e.g. /tmp → /private/tmp on macOS).
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-import-dest-')))
    extern = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-import-src-')))
    addAllowedRoot(root) // destination must be inside a workspace root; source need not be
  })

  afterEach(async () => {
    removeAllowedRoot(root)
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(extern, { recursive: true, force: true })
  })

  test('copy leaves the original in place and creates a copy in the destination', async () => {
    const src = path.join(extern, 'note.txt')
    await fs.writeFile(src, 'hello', 'utf8')

    const result = await callImport([src], root, 'copy')

    expect(result.failed).toBe(0)
    expect(result.created).toEqual([path.join(root, 'note.txt')])
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('hello')
    // Original untouched.
    expect(await fs.readFile(src, 'utf8')).toBe('hello')
  })

  test('move relocates the entry and removes the original', async () => {
    const src = path.join(extern, 'data.bin')
    await fs.writeFile(src, 'x', 'utf8')

    const result = await callImport([src], root, 'move')

    expect(result.failed).toBe(0)
    expect(await fs.readFile(path.join(root, 'data.bin'), 'utf8')).toBe('x')
    await expect(fs.lstat(src)).rejects.toThrow() // gone
  })

  test('copies a directory recursively', async () => {
    const dir = path.join(extern, 'folder')
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(dir, 'sub', 'a.txt'), 'a', 'utf8')

    const result = await callImport([dir], root, 'copy')

    expect(result.failed).toBe(0)
    expect(await fs.readFile(path.join(root, 'folder', 'sub', 'a.txt'), 'utf8')).toBe('a')
  })

  test('renames on name collision instead of overwriting', async () => {
    await fs.writeFile(path.join(root, 'dup.txt'), 'existing', 'utf8')
    const src = path.join(extern, 'dup.txt')
    await fs.writeFile(src, 'incoming', 'utf8')

    const result = await callImport([src], root, 'copy')

    expect(result.failed).toBe(0)
    // Existing file preserved; the import landed under a non-colliding name.
    expect(await fs.readFile(path.join(root, 'dup.txt'), 'utf8')).toBe('existing')
    expect(result.created).toHaveLength(1)
    expect(result.created[0]).not.toBe(path.join(root, 'dup.txt'))
    expect(await fs.readFile(result.created[0], 'utf8')).toBe('incoming')
  })

  test('refuses to import a folder into itself', async () => {
    // destDir is inside the source folder → must be rejected.
    const inner = path.join(root, 'child')
    await fs.mkdir(inner)

    const result = await callImport([root], inner, 'copy')

    expect(result.created).toHaveLength(0)
    expect(result.failed).toBe(1)
  })
})
