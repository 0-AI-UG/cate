// Real-filesystem integration test for createWatchPool. Drives the ACTUAL
// @parcel/watcher backend (FSEvents / ReadDirectoryChangesW / inotify), so —
// unlike the old native-only test — it runs on every platform parcel supports
// (i.e. all three CI OSes). Verifies that a nested create/update/delete
// round-trips with correct absolute paths and real event types, and that the
// exclusion + hidden-directory ignore policy holds end-to-end (the behavior the
// deleted createFsIgnoreMatcher live-chokidar test used to guard).

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'fs/promises'
import os from 'os'
import path from 'path'
import { createWatchPool, type WatchPool } from './fileWatcher'

const EXCLUSIONS = ['node_modules', '.git', '.DS_Store']

let pool: WatchPool | null = null
let root = ''
/** Extra temp dirs (e.g. symlink targets) to clean up alongside `root`. */
const extraDirs: string[] = []

afterEach(async () => {
  await pool?.closeAll()
  pool = null
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
  await Promise.all(extraDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Collect events; resolve once `predicate` is satisfied or reject on timeout. */
function waitFor(
  events: Array<{ type: string; path: string }>,
  predicate: () => boolean,
  ms = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (predicate()) {
        clearInterval(t)
        resolve()
      }
    }, 50)
    setTimeout(() => {
      clearInterval(t)
      reject(new Error(`timed out; saw: ${JSON.stringify(events)}`))
    }, ms)
  })
}

describe('createWatchPool — real @parcel/watcher', () => {
  it('round-trips a nested create / update / delete with absolute paths', async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cate-pw-')))
    const nestedDir = path.join(root, 'src', 'panels')
    await mkdir(nestedDir, { recursive: true })
    const file = path.join(nestedDir, 'deep.txt')

    const events: Array<{ type: string; path: string }> = []
    pool = createWatchPool(() => EXCLUSIONS)
    pool.subscribe(root, (p, type) => events.push({ type, path: p }))
    await new Promise((r) => setTimeout(r, 300)) // let the watcher arm

    await writeFile(file, 'v0', 'utf8')
    await waitFor(events, () => events.some((e) => e.type === 'create' && e.path === file))

    await writeFile(file, 'v1', 'utf8')
    await waitFor(events, () => events.some((e) => e.type === 'update' && e.path === file))

    await rm(file)
    await waitFor(events, () => events.some((e) => e.type === 'delete' && e.path === file))
  })

  it('emits for hidden + normal files but never for excluded or hidden directories', async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cate-pw-')))
    await mkdir(path.join(root, 'src'))
    await mkdir(path.join(root, '.git'))
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })

    const events: Array<{ type: string; path: string }> = []
    pool = createWatchPool(() => EXCLUSIONS)
    pool.subscribe(root, (p, type) => events.push({ type, path: p }))
    await new Promise((r) => setTimeout(r, 300))

    const keepHiddenFile = path.join(root, '.env')
    const keepNormal = path.join(root, 'src', 'a.ts')
    const dropGit = path.join(root, '.git', 'HEAD')
    const dropNodeModules = path.join(root, 'node_modules', 'pkg', 'i.js')

    await writeFile(dropGit, 'x')
    await writeFile(dropNodeModules, 'x')
    await writeFile(keepHiddenFile, 'x')
    await writeFile(keepNormal, 'x')

    // Wait until BOTH keepers arrive — then the watcher is provably live and the
    // absence of the excluded ones is meaningful.
    await waitFor(
      events,
      () => events.some((e) => e.path === keepHiddenFile) && events.some((e) => e.path === keepNormal),
    )
    await new Promise((r) => setTimeout(r, 300)) // tail: a wrongly-watched path would have fired by now

    const seen = new Set(events.map((e) => e.path))
    expect(seen.has(keepHiddenFile)).toBe(true)
    expect(seen.has(keepNormal)).toBe(true)
    expect(seen.has(dropGit)).toBe(false)
    expect(seen.has(dropNodeModules)).toBe(false)
  })

  // Removing a populated directory must surface a delete for EVERY file inside,
  // not a single event for the directory. parcel synthesizes the per-file
  // deletes on recursive removal, so an editor open on a file in the deleted
  // subtree still learns its file is gone (the narrowing the old native
  // recursive fs.watch carried — a lone dir rename — is fixed).
  it('synthesizes a delete for every file when a populated subtree is removed', async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cate-pw-')))
    const dir = path.join(root, 'pkg')
    const top = path.join(dir, 'a.ts')
    const deep = path.join(dir, 'nested', 'b.ts')
    await mkdir(path.join(dir, 'nested'), { recursive: true })
    await writeFile(top, 'x')
    await writeFile(deep, 'x')

    const events: Array<{ type: string; path: string }> = []
    pool = createWatchPool(() => EXCLUSIONS)
    pool.subscribe(root, (p, type) => events.push({ type, path: p }))
    await new Promise((r) => setTimeout(r, 300))

    await rm(dir, { recursive: true, force: true })

    await waitFor(
      events,
      () =>
        events.some((e) => e.type === 'delete' && e.path === top) &&
        events.some((e) => e.type === 'delete' && e.path === deep),
    )
    expect(events.some((e) => e.type === 'delete' && e.path === top)).toBe(true)
    expect(events.some((e) => e.type === 'delete' && e.path === deep)).toBe(true)
  })

  // Robustness: a directory symlink in the tree (e.g. a monorepo / pnpm package
  // link) must not break watching of real files. NOTE: parcel does NOT recurse
  // into a directory symlink that points OUTSIDE the watched root — changes
  // under `linked/` are not reported. This asserts only that the symlink's
  // presence is harmless; it is not a claim that symlinked subtrees are watched.
  it('keeps watching real files when an external directory symlink is present', async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cate-pw-')))
    const ext = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cate-pw-ext-')))
    extraDirs.push(ext)
    await mkdir(path.join(ext, 'pkg'), { recursive: true })
    await symlink(path.join(ext, 'pkg'), path.join(root, 'linked'), 'dir')
    await mkdir(path.join(root, 'src'))

    const events: Array<{ type: string; path: string }> = []
    pool = createWatchPool(() => EXCLUSIONS)
    pool.subscribe(root, (p, type) => events.push({ type, path: p }))
    await new Promise((r) => setTimeout(r, 300))

    const real = path.join(root, 'src', 'a.ts')
    await writeFile(real, 'x')
    await waitFor(events, () => events.some((e) => e.path === real && e.type === 'create'))
    expect(events.some((e) => e.path === real)).toBe(true)
  })
})
