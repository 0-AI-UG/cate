import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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

// The watch handlers bail without a window; give them one and capture what
// gets pushed to it.
const sendToWindow = vi.fn()
vi.mock('../windowRegistry', () => ({
  windowFromEvent: () => ({ id: 1 }),
  sendToWindow: (...args: unknown[]) => sendToWindow(...args),
}))

vi.mock('../store', () => ({
  getSettingSync: (key: string) => (key === 'fileExclusions' ? ['node_modules'] : undefined),
}))

const { registerHandlers } = await import('./filesystem')
const { addAllowedRoot, removeAllowedRoot } = await import('./pathValidation')
const { FS_WATCH_START, FS_WATCH_STOP, FS_WATCH_EVENT } = await import('../../shared/ipc-channels')
const { registerTestLocalRuntime } = await import('../runtime/testLocalRuntime')

registerHandlers()
registerTestLocalRuntime()
const watchStart = handlers.get(FS_WATCH_START)!
const watchStop = handlers.get(FS_WATCH_STOP)!
const fakeEvent = { sender: {} } as unknown

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Wait until a FS_WATCH_EVENT matching `predicate` reaches the window. Calls
 * `poke` between checks — chokidar drops events that fire before its initial
 * scan finishes, so the change under test is re-applied until it's observed.
 */
async function waitForWatchEvent(
  predicate: (event: { type: string; path: string }) => boolean,
  poke: () => Promise<void>,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await poke()
    await sleep(100)
    const hit = sendToWindow.mock.calls.some(
      ([, channel, event]) =>
        channel === FS_WATCH_EVENT && predicate(event as { type: string; path: string }),
    )
    if (hit) return true
  }
  return false
}

describe('fs watch events for nested paths', () => {
  let root: string

  beforeEach(async () => {
    // realpath so the registered allowed root matches validatePathStrict's
    // symlink-resolved comparison (e.g. /tmp → /private/tmp on macOS).
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-watch-')))
    addAllowedRoot(root)
    sendToWindow.mockClear()
  })

  afterEach(async () => {
    await watchStop(fakeEvent, root)
    removeAllowedRoot(root)
    await fs.rm(root, { recursive: true, force: true })
  })

  // Regression: the watcher used to be created with `depth: 1`, so a watch on
  // the workspace root never reported changes to files nested deeper than one
  // level — the editor's external-reload (and git status / explorer refresh)
  // silently missed edits to virtually every real source file.
  //
  // Accept either `update` or `create`: macOS's native recursive watcher
  // (issue #398) reports a content modify of an existing file as a `rename`,
  // which the adapter maps to `create`. Downstream that's identical to `update`
  // (classifyExternalEvent treats create/update the same; the file tree just
  // re-reads on-disk state), so the meaningful assertion is "a change event for
  // this deep path is delivered at all".
  test('reports updates to a file nested several levels below the watch root', async () => {
    const nestedDir = path.join(root, 'src', 'renderer', 'panels')
    const nestedFile = path.join(nestedDir, 'deep.txt')
    await fs.mkdir(nestedDir, { recursive: true })
    await fs.writeFile(nestedFile, 'v0', 'utf8')

    await watchStart(fakeEvent, root)

    let rev = 0
    const seen = await waitForWatchEvent(
      (event) =>
        (event.type === 'update' || event.type === 'create') && event.path === nestedFile,
      () => fs.writeFile(nestedFile, `v${++rev}`, 'utf8'),
    )
    expect(seen).toBe(true)
  })

  test('does not report changes under an excluded folder', async () => {
    const excludedDir = path.join(root, 'node_modules', 'pkg')
    const excludedFile = path.join(excludedDir, 'index.js')
    const markerFile = path.join(root, 'marker.txt')
    await fs.mkdir(excludedDir, { recursive: true })
    await fs.writeFile(excludedFile, 'v0', 'utf8')
    await fs.writeFile(markerFile, 'v0', 'utf8')

    await watchStart(fakeEvent, root)

    // Poke both files; once the marker's event arrives the watcher is provably
    // live, so the absence of the excluded file's event is meaningful.
    let rev = 0
    const markerSeen = await waitForWatchEvent(
      (event) => event.path === markerFile,
      async () => {
        rev++
        await fs.writeFile(excludedFile, `v${rev}`, 'utf8')
        await fs.writeFile(markerFile, `v${rev}`, 'utf8')
      },
    )
    expect(markerSeen).toBe(true)

    const excludedSeen = sendToWindow.mock.calls.some(
      ([, channel, event]) =>
        channel === FS_WATCH_EVENT && (event as { path: string }).path === excludedFile,
    )
    expect(excludedSeen).toBe(false)
  })
})
