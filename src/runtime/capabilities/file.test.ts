import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { watch, type FSWatcher } from 'chokidar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFsIgnoreMatcher } from './file'

// =============================================================================
// createFsIgnoreMatcher is the SINGLE chokidar ignore predicate shared by the
// local watcher pool (main/ipc/filesystem.ts) and the daemon watch capability
// (runtime/capabilities/index.ts). It must:
//   • prune excluded entries (node_modules, .git, …) and hidden DIRECTORIES
//     (.cache, .cate) so a recursive watch stays cheap and our own state-dir
//     writes don't echo back, AND
//   • NOT ignore hidden FILES (.gitignore, .env) — a dotfile opened in an editor
//     must still get live change events through this one shared watcher.
//
// Regression for: an editor open on a dotfile never received external-change
// events because the matcher ignored every dot-prefixed path.
// =============================================================================

const ROOT = '/proj'
const EXCLUDED = new Set(['node_modules', '.git', '.DS_Store', '__pycache__'])
const asFile = { isDirectory: () => false }
const asDir = { isDirectory: () => true }

describe('createFsIgnoreMatcher — unit', () => {
  const ignored = createFsIgnoreMatcher(ROOT, EXCLUDED)

  it('does NOT ignore a hidden file at the root (the bug)', () => {
    expect(ignored('/proj/.gitignore', asFile)).toBe(false)
    expect(ignored('/proj/.env', asFile)).toBe(false)
    // Stats absent (chokidar's pre-stat probe): still not ignored, so chokidar
    // proceeds to stat it rather than pruning a file it never looked at.
    expect(ignored('/proj/.gitignore')).toBe(false)
  })

  it('does NOT ignore a hidden file nested under a normal directory', () => {
    expect(ignored('/proj/src/.eslintrc.json', asFile)).toBe(false)
    expect(ignored('/proj/config/.prettierrc', asFile)).toBe(false)
  })

  it('does NOT ignore ordinary files', () => {
    expect(ignored('/proj/src/index.ts', asFile)).toBe(false)
    expect(ignored('/proj/README.md', asFile)).toBe(false)
  })

  it('ignores a hidden DIRECTORY leaf (so chokidar will not descend)', () => {
    expect(ignored('/proj/.cate', asDir)).toBe(true)
    expect(ignored('/proj/.cache', asDir)).toBe(true)
  })

  it('ignores anything under a hidden ancestor directory regardless of stats', () => {
    expect(ignored('/proj/.cate/session.json', asFile)).toBe(true)
    expect(ignored('/proj/.git/HEAD', asFile)).toBe(true)
    expect(ignored('/proj/.cache/x/y.bin')).toBe(true)
  })

  it('ignores excluded entries (files or dirs, with or without stats)', () => {
    expect(ignored('/proj/node_modules', asDir)).toBe(true)
    expect(ignored('/proj/node_modules/pkg/index.js', asFile)).toBe(true)
    expect(ignored('/proj/__pycache__/m.pyc')).toBe(true)
    expect(ignored('/proj/.DS_Store', asFile)).toBe(true)
  })

  it('does not ignore the root itself or paths outside the root', () => {
    expect(ignored('/proj', asDir)).toBe(false)
    expect(ignored('/other/.gitignore', asFile)).toBe(false)
    // A dotted/excluded segment in the root's OWN path must not silence the tree.
    const m = createFsIgnoreMatcher('/Users/me/.config/proj', EXCLUDED)
    expect(m('/Users/me/.config/proj/src/a.ts', asFile)).toBe(false)
  })

  it('normalizes separators (Windows: native root, POSIX paths from chokidar)', () => {
    // chokidar hands the predicate forward-slash paths even on Windows, while the
    // root arrives OS-native — both must compare equal or the matcher ignores
    // nothing and the whole tree gets watched.
    const m = createFsIgnoreMatcher('C:\\proj', EXCLUDED)
    expect(m('C:\\proj\\.gitignore', asFile)).toBe(false)
    expect(m('C:/proj/.gitignore', asFile)).toBe(false)
    expect(m('C:\\proj\\src\\a.ts', asFile)).toBe(false)
    expect(m('C:/proj/.cate', asDir)).toBe(true)
    expect(m('C:/proj/.cate/session.json', asFile)).toBe(true)
    expect(m('C:\\proj\\node_modules\\pkg\\i.js', asFile)).toBe(true)
  })

  it('treats a hidden-dir leaf without stats as not-ignored (chokidar re-asks)', () => {
    // No stats yet → defer (false); chokidar stats it and calls again with
    // stats.isDirectory() === true, which prunes it. Covered live below.
    expect(ignored('/proj/.cate')).toBe(false)
    expect(ignored('/proj/.cate', asDir)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// End-to-end: drive a REAL chokidar watcher with the matcher over a real tree.
// This is the guard that the whole watch path behaves — hidden files emit,
// hidden/excluded dirs stay pruned (no events, not even watched).
// -----------------------------------------------------------------------------

describe('createFsIgnoreMatcher — live chokidar', () => {
  let dir: string
  let watcher: FSWatcher | null = null

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-watch-'))
    await fs.mkdir(path.join(dir, 'src'))
    await fs.mkdir(path.join(dir, '.cate'))
    await fs.mkdir(path.join(dir, '.git'))
    await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(dir, '.gitignore'), 'a\n')
    await fs.writeFile(path.join(dir, '.env'), 'a\n')
    await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'a\n')
    await fs.writeFile(path.join(dir, '.cate', 'session.json'), 'a\n')
    await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'a\n')
    await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'i.js'), 'a\n')
  })

  afterEach(async () => {
    await watcher?.close()
    watcher = null
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('emits for hidden + normal files, never for hidden/excluded dirs', async () => {
    const events: Array<{ type: string; rel: string }> = []
    watcher = watch(dir, { ignoreInitial: true, ignored: createFsIgnoreMatcher(dir, EXCLUDED) })
    watcher.on('all', (type, p) => events.push({ type, rel: path.relative(dir, p) }))
    await new Promise<void>((resolve) => watcher!.once('ready', () => resolve()))

    // Touch one of each category.
    await fs.appendFile(path.join(dir, '.gitignore'), 'b\n')
    await fs.appendFile(path.join(dir, '.env'), 'b\n')
    await fs.appendFile(path.join(dir, 'src', 'a.ts'), 'b\n')
    await fs.appendFile(path.join(dir, '.cate', 'session.json'), 'b\n')
    await fs.appendFile(path.join(dir, '.git', 'HEAD'), 'b\n')
    await fs.appendFile(path.join(dir, 'node_modules', 'pkg', 'i.js'), 'b\n')

    // Wait until the expected events arrive (fs.watch latency varies by OS), then
    // a short tail so a wrongly-watched path would have had its chance to fire.
    const want = ['.gitignore', '.env', path.join('src', 'a.ts')]
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !want.every((w) => events.some((e) => e.rel === w))) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await new Promise((r) => setTimeout(r, 400))

    const touched = new Set(events.map((e) => e.rel))
    expect(touched.has('.gitignore')).toBe(true)
    expect(touched.has('.env')).toBe(true)
    expect(touched.has(path.join('src', 'a.ts'))).toBe(true)
    expect(touched.has(path.join('.cate', 'session.json'))).toBe(false)
    expect(touched.has(path.join('.git', 'HEAD'))).toBe(false)
    expect(touched.has(path.join('node_modules', 'pkg', 'i.js'))).toBe(false)
  }, 15_000)
})
