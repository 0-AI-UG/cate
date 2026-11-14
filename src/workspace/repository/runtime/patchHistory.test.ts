import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseReviewPatch } from '../contract'
import { createPatchHistory, type TrackedPatch } from './patchHistory'

const exec = promisify(execFile)
let cwd: string
const git = async (...args: string[]) => (await exec('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout
const commit = async (message: string) => { await git('add', '.'); await git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', message); return (await git('rev-parse', 'HEAD')).trim() }
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'cate-patch-history-'))
  await git('init', '-q')
  await writeFile(path.join(cwd, 'file.txt'), 'before\n')
  await commit('Initial')
})
afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

const prepare = async () => {
  const read = vi.fn((_cwd: string, args: string[]) => git(...args))
  const history = createPatchHistory({ read })
  await writeFile(path.join(cwd, 'file.txt'), 'after\n')
  const hunks = parseReviewPatch(await git('diff'))
  const baseCommit = await history.capture(cwd, [{ path: 'file.txt', hunks }])
  const file: TrackedPatch = { key: 'edit:file.txt', path: 'file.txt', createdAt: new Date().toISOString(), hunks, baseCommit }
  return { history, file, read }
}

it('tracks uncommitted edits, groups the committed edit, and retains it after restart', async () => {
  const { history, file } = await prepare()
  expect(file.baseCommit).toBeTruthy()
  expect((await history.reconcile(cwd, [file])).get(file.key)).toEqual({ uncommitted: true })
  const hash = await commit('Implement feature')
  expect((await history.reconcile(cwd, [file])).get(file.key)).toMatchObject({ uncommitted: false, commit: { hash, message: 'Implement feature' } })
  const restarted = createPatchHistory({ read: (_cwd, args) => git(...args) })
  expect((await restarted.reconcile(cwd, [file])).get(file.key)?.commit?.hash).toBe(hash)
})

it('prunes a fully reverted pending edit even with unrelated dirty files', async () => {
  const { history, file } = await prepare()
  await writeFile(path.join(cwd, 'file.txt'), 'before\n')
  await writeFile(path.join(cwd, 'unrelated.txt'), 'keep me\n')
  expect((await history.reconcile(cwd, [file])).get(file.key)?.reverted).toBe(true)
})

it('recognizes an explicit Git revert and keeps later modifications with uncertain attribution', async () => {
  const { history, file } = await prepare()
  const hash = await commit('Feature')
  await writeFile(path.join(cwd, 'file.txt'), 'different\n')
  expect((await history.reconcile(cwd, [file])).get(file.key)?.reverted).not.toBe(true)
  await git('restore', 'file.txt')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'revert', '--no-edit', hash)
  expect((await history.reconcile(cwd, [file])).get(file.key)?.reverted).toBe(true)
})

it('finds commits for older records without a captured baseline and never infers a revert from a clean status alone', async () => {
  const { history, file } = await prepare()
  delete file.baseCommit
  const hash = await commit('Existing capture')
  expect((await history.reconcile(cwd, [file])).get(file.key)?.commit?.hash).toBe(hash)
  const unknown = { ...file, key: 'unknown', hunks: parseReviewPatch('@@ -1 +1 @@\n-unrelated\n+something else\n') }
  expect((await history.reconcile(cwd, [unknown])).get(unknown.key)).toEqual({ uncommitted: false })
})

it('reuses commit evidence on idle reads and invalidates it when file content changes', async () => {
  const { history, file, read } = await prepare()
  await commit('Feature')
  await history.reconcile(cwd, [file])
  read.mockClear()
  await history.reconcile(cwd, [file])
  expect(read.mock.calls.map(([, args]) => args)).toEqual([['rev-parse', '--verify', 'HEAD'], ['rev-parse', '--git-path', 'index'], ['for-each-ref', '--format=%(objectname)']])
  await writeFile(path.join(cwd, 'file.txt'), 'before\n')
  expect((await history.reconcile(cwd, [file])).get(file.key)?.reverted).toBe(true)
})

it('tracks added files and prunes them only after deletion', async () => {
  const history = createPatchHistory({ read: (_cwd, args) => git(...args) })
  await writeFile(path.join(cwd, 'new.txt'), 'new content\n')
  const hunks = parseReviewPatch('@@ -0,0 +1 @@\n+new content\n')
  const baseCommit = await history.capture(cwd, [{ path: 'new.txt', hunks }])
  expect(baseCommit).toBeTruthy()
  const file = { path: 'new.txt', key: 'new', hunks, baseCommit, createdAt: new Date().toISOString() }
  expect((await history.reconcile(cwd, [file])).get('new')).toEqual({ uncommitted: true })
  await rm(path.join(cwd, 'new.txt'))
  expect((await history.reconcile(cwd, [file])).get('new')?.reverted).toBe(true)
})

it('keeps committed edits when switching to a branch that does not contain them', async () => {
  const { history, file } = await prepare()
  const original = await git('branch', '--show-current')
  await git('switch', '-c', 'feature')
  const hash = await commit('Feature on another branch')
  await git('switch', original.trim())
  const result = (await history.reconcile(cwd, [file])).get(file.key)
  expect(result?.commit?.hash).toBe(hash)
  expect(result?.reverted).not.toBe(true)
})

it('does not prune staged edits when the working file was restored', async () => {
  const { history, file } = await prepare()
  await git('add', 'file.txt')
  await writeFile(path.join(cwd, 'file.txt'), 'before\n')
  expect((await history.reconcile(cwd, [file])).get(file.key)).toEqual({ uncommitted: true })
  await git('restore', '--staged', 'file.txt')
  expect((await history.reconcile(cwd, [file])).get(file.key)?.reverted).toBe(true)
})

it('prunes edits rolled back with reset, but preserves commits still referenced on another branch', async () => {
  const { history, file } = await prepare()
  const hash = await commit('Feature')
  file.commit = { hash, message: 'Feature', date: new Date().toISOString() }
  await git('branch', 'keep-feature')
  await git('reset', '--hard', file.baseCommit!)
  expect((await history.reconcile(cwd, [file])).get(file.key)?.reverted).not.toBe(true)
  await git('branch', '-D', 'keep-feature')
  expect((await history.reconcile(cwd, [file])).get(file.key)?.reverted).toBe(true)
})
