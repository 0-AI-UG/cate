// =============================================================================
// Unit tests for the extension storage cache lifecycle: runtime rebinding on a
// disconnect/reconnect (a new Runtime with the same id) and watcher teardown
// when the last subscriber unsubscribes. These drive ./storage against a fake
// in-memory FileHost registered under LOCAL, so no real fs/daemon is involved.
// =============================================================================

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/cate-userData' } }))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// Fake workspace lookup: one known workspace pointing at a local project root.
const getWorkspaceInfo = vi.hoisted(() => vi.fn())
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo }))

import { runtimes } from '../runtime/runtimeManager'
import { LOCAL_RUNTIME_ID } from '../runtime/locator'
import type { Runtime } from '../runtime/types'
import { getExtensionStorage, disposeStoresForRuntime, flushAllPendingWritesSync } from './storage'

const EXT = 'cate.test'
const ROOT = '/proj'
// The store builds its paths with hostJoin (= path.join for the local runtime),
// so on Windows they come out backslashed — the fake must key its files and emit
// its watch events the same way or every lookup misses.
const STORAGE_DIR = path.join(ROOT, '.cate', 'extensions', EXT)
const STORAGE_FILE = path.join(STORAGE_DIR, 'storage.json')

/** A minimal fake Runtime whose FileHost records which instance handled each
 *  write and which watchers are currently live. */
function makeFakeRuntime(label: string): {
  runtime: Runtime
  writes: Array<{ by: string; content: string }>
  liveWatchers: () => number
  watchedPrefixes: string[]
  setFile: (content: string) => void
  emitChange: (changedPath?: string) => void
} {
  const files = new Map<string, string>()
  const writes: Array<{ by: string; content: string }> = []
  const watchers = new Set<(changedPath: string) => void>()
  const watchedPrefixes: string[] = []

  const file = {
    async readFile(p: string): Promise<string> {
      const v = files.get(p)
      if (v == null) throw new Error('ENOENT')
      return v
    },
    async writeFile(p: string, content: string): Promise<void> {
      files.set(p, content)
      writes.push({ by: label, content })
    },
    async mkdir(_p: string): Promise<void> {},
    watch(prefix: string, onChange: (changedPath: string) => void): () => void {
      watchedPrefixes.push(prefix)
      watchers.add(onChange)
      return () => { watchers.delete(onChange) }
    },
  } as unknown as Runtime['file']

  const runtime = { id: LOCAL_RUNTIME_ID, file } as unknown as Runtime
  return {
    runtime,
    writes,
    liveWatchers: () => watchers.size,
    watchedPrefixes,
    setFile: (content: string) => files.set(STORAGE_FILE, content),
    // The pool watches the storage file's parent DIR and delivers events for
    // paths inside it; default to the storage file's own path.
    emitChange: (changedPath = STORAGE_FILE) => {
      for (const cb of watchers) cb(changedPath)
    },
  }
}

beforeEach(() => {
  getWorkspaceInfo.mockImplementation((id: string) => (id === 'ws' ? { rootPath: ROOT } : undefined))
  disposeStoresForRuntime(LOCAL_RUNTIME_ID)
})

describe('storage — runtime rebinding across disconnect/reconnect', () => {
  it('writes through the CURRENT runtime after a reconnect swaps in a new Runtime with the same id', async () => {
    const a = makeFakeRuntime('A')
    runtimes.registerLocalForTest(a.runtime)

    const s1 = await getExtensionStorage(EXT, 'ws')
    expect(s1).not.toBeNull()

    // Disconnect A, reconnect B (same id, brand-new Runtime object).
    const b = makeFakeRuntime('B')
    runtimes.registerLocalForTest(b.runtime)

    // A cached handle for the same (runtime id, file) is reused...
    const s2 = await getExtensionStorage(EXT, 'ws')
    s2!.set('k', 'v')

    // ...but the write must land on B, not the dead A.
    await vi.waitFor(() => expect(b.writes.length).toBeGreaterThan(0))
    expect(a.writes).toHaveLength(0)
    expect(b.writes.at(-1)!.content).toContain('"k"')
  })
})

describe('storage — watcher teardown on last unsubscribe', () => {
  it('stops the runtime watcher when the last subscriber unsubscribes', async () => {
    const a = makeFakeRuntime('A')
    runtimes.registerLocalForTest(a.runtime)

    const s = await getExtensionStorage(EXT, 'ws')
    const off1 = s!.onChange(() => {})
    const off2 = s!.onChange(() => {})
    // Arming is async (mkdir the watched dir first), so wait for it.
    await vi.waitFor(() => expect(a.liveWatchers()).toBe(1))

    off1()
    expect(a.liveWatchers()).toBe(1) // still one subscriber
    off2()
    expect(a.liveWatchers()).toBe(0) // watcher disposed, not left live
  })
})

describe('storage — external-edit reload', () => {
  it('reloads the file and notifies subscribers when the watcher reports an external change', async () => {
    const a = makeFakeRuntime('A')
    runtimes.registerLocalForTest(a.runtime)

    const s = await getExtensionStorage(EXT, 'ws')
    let fired = 0
    s!.onChange(() => { fired++ })
    await vi.waitFor(() => expect(a.liveWatchers()).toBe(1))

    a.setFile('{"k":"external"}')
    a.emitChange()

    await vi.waitFor(() => expect(fired).toBe(1))
    expect(s!.get('k')).toBe('external')
  })

  it('watches the storage DIR, not the file (the watch pool is directory-based)', async () => {
    const a = makeFakeRuntime('A')
    runtimes.registerLocalForTest(a.runtime)

    const s = await getExtensionStorage(EXT, 'ws')
    s!.onChange(() => {})
    await vi.waitFor(() => expect(a.liveWatchers()).toBe(1))

    expect(a.watchedPrefixes).toEqual([STORAGE_DIR])
  })

  it('ignores events for sibling files (editor tmp/backup) and same-content events', async () => {
    const a = makeFakeRuntime('A')
    runtimes.registerLocalForTest(a.runtime)

    const s = await getExtensionStorage(EXT, 'ws')
    let fired = 0
    s!.onChange(() => { fired++ })
    await vi.waitFor(() => expect(a.liveWatchers()).toBe(1))

    // A sibling event (vim swap file) must not trigger a reload/notify.
    a.setFile('{"k":"external"}')
    a.emitChange(path.join(STORAGE_DIR, '.storage.json.swp'))
    await new Promise((r) => setTimeout(r, 20))
    expect(fired).toBe(0)
    expect(s!.get('k')).toBeUndefined() // not reloaded either

    // A storage.json event with the content we already hold must not notify.
    a.emitChange()
    await vi.waitFor(() => expect(s!.get('k')).toBe('external'))
    expect(fired).toBe(1)
    a.emitChange() // content unchanged this time
    await new Promise((r) => setTimeout(r, 20))
    expect(fired).toBe(1)
  })
})

describe('storage — same-process onChange (BUG 1)', () => {
  it('fires an onChange subscriber when a set() changes a key in the same store', async () => {
    const a = makeFakeRuntime('A')
    runtimes.registerLocalForTest(a.runtime)

    const s = await getExtensionStorage(EXT, 'ws')
    let fired = 0
    s!.onChange(() => { fired++ })

    s!.set('k', 'v')
    expect(fired).toBe(1) // direct notification, not via the (echo-suppressed) watcher

    s!.set('k', 'v') // no-op write — value unchanged, must NOT fire again
    expect(fired).toBe(1)

    s!.delete('k')
    expect(fired).toBe(2)
  })
})

describe('storage — synchronous flush on quit (BUG 2)', () => {
  // A real temp project root so flushAllPendingWritesSync's writeFileSync has a
  // native path to land on (the local runtime uses path.join / bare fs paths).
  const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cate-storage-flush-')))
  const file = path.join(realRoot, '.cate', 'extensions', EXT, 'storage.json')

  afterAll(() => { fs.rmSync(realRoot, { recursive: true, force: true }) })

  it('flushAllPendingWritesSync persists pending debounced data synchronously', async () => {
    // Point the workspace at the REAL root so the store writes to disk; register a
    // fake runtime whose async writeFile is a no-op (so only the sync flush lands).
    getWorkspaceInfo.mockImplementation((id: string) => (id === 'ws2' ? { rootPath: realRoot } : undefined))
    const a = makeFakeRuntime('A')
    runtimes.registerLocalForTest(a.runtime)

    const s = await getExtensionStorage(EXT, 'ws2')
    s!.set('pending', 42) // schedules a debounced write (150ms) — not on disk yet
    expect(fs.existsSync(file)).toBe(false)

    flushAllPendingWritesSync() // simulates the quit path

    expect(fs.existsSync(file)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pending).toBe(42)

    disposeStoresForRuntime(LOCAL_RUNTIME_ID)
  })
})
