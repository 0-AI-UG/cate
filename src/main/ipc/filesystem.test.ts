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
  // Tests that need a window attach it as `__win` on the event; the import
  // tests pass a bare event and keep the original "no window" behavior.
  windowFromEvent: (event: { __win?: unknown }) => event?.__win,
  sendToWindow: vi.fn(),
}))

const fsModule = await import('./filesystem')
const { registerHandlers, subscribeFsChanges } = fsModule
const { addAllowedRoot, removeAllowedRoot } = await import('./pathValidation')
const { FS_IMPORT_ENTRIES, FS_WATCH_START, FS_WATCH_STOP } = await import('../../shared/ipc-channels')
const { registerTestLocalRuntime } = await import('../runtime/testLocalRuntime')

registerHandlers()
registerTestLocalRuntime()
const importEntries = handlers.get(FS_IMPORT_ENTRIES)!
const watchStartHandler = handlers.get(FS_WATCH_START)!
const watchStopHandler = handlers.get(FS_WATCH_STOP)!
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

describe('in-process fs subscriptions', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-fswatch-')))
    addAllowedRoot(root)
  })

  afterEach(async () => {
    await watchStopHandler({ __win: { id: 1 } }, root)
    removeAllowedRoot(root)
    await fs.rm(root, { recursive: true, force: true })
  })

  const startWatch = () => watchStartHandler({ __win: { id: 1 } }, root)

  // Wait until `got()` reaches `count` (or time out). chokidar drops events that
  // fire before its initial scan finishes, so `poke` re-applies the change each
  // iteration until it's observed (same pattern as fsWatch.test.ts).
  const waitFor = async (
    got: () => number,
    count: number,
    poke: () => Promise<void>,
    ms = 5000,
  ): Promise<void> => {
    const deadline = Date.now() + ms
    while (got() < count && Date.now() < deadline) {
      await poke()
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  // Two independent in-proc subscribers under the same root share ONE pooled OS
  // watcher (covering-root reuse) yet each receives every event — no key
  // collision drops one. Registering both before the renderer watch also
  // exercises the active in-proc path: the first subscribe opens the watcher
  // itself, the renderer watchStart then reuses it.
  test('two subscribers under one watch root both receive events', async () => {
    const aEvents: string[] = []
    const bEvents: string[] = []

    const unsubA = subscribeFsChanges(root, (fp) => aEvents.push(fp))
    const unsubB = subscribeFsChanges(root, (fp) => bEvents.push(fp))

    startWatch()

    const file = path.join(root, 'touched.txt')
    let rev = 0
    await waitFor(
      () => Math.min(aEvents.length, bEvents.length),
      1,
      () => fs.writeFile(file, `hi${++rev}`, 'utf8'),
    )

    expect(aEvents).toContain(file)
    expect(bEvents).toContain(file)

    unsubA()
    unsubB()
  }, 20_000)

  // In-proc subscriptions are ACTIVE: each opens its own watcher when no
  // covering one exists (matching the daemon's runtime.file.watch), so a fresh
  // subscriber receives events even with no renderer watch and after a prior one
  // was torn down. Unsubscribed listeners receive nothing — clean teardown.
  test('a fresh in-proc subscriber watches actively after a prior teardown', async () => {
    const earlyEvents: string[] = []
    const unsubA = subscribeFsChanges(root, (fp) => earlyEvents.push(fp))
    startWatch()
    unsubA()
    await watchStopHandler({ __win: { id: 1 } }, root)
    const earlyCountAtTeardown = earlyEvents.length

    // A brand-new subscriber opens its own watcher and DOES receive events.
    const lateEvents: string[] = []
    const unsubLate = subscribeFsChanges(root, (fp) => lateEvents.push(fp))

    const file = path.join(root, 'after.txt')
    let rev = 0
    // A fresh watcher armed right after the prior one was torn down can be slow
    // to start delivering on Windows CI, so give the poke loop extra headroom.
    await waitFor(() => lateEvents.length, 1, () => fs.writeFile(file, `x${++rev}`, 'utf8'), 15_000)

    expect(lateEvents).toContain(file)
    // The unsubscribed listener got nothing more after it left.
    expect(earlyEvents).toHaveLength(earlyCountAtTeardown)
    unsubLate()
  }, 20_000)
})
