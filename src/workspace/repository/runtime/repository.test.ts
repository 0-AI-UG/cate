import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { isRpcError, RpcError } from '@kernel/rpc/contract'
import type { CallContext } from '@kernel/rpc/runtime'
import {
  applyOp,
  createDocument,
  opChanges,
  type DocBatch,
  type DocChange,
  type PanelRecord,
  type WorkspaceDocument,
} from '@workspace/document/contract'
import { createRepositoryRuntime, vcsCapabilityImpl, type RepositoryRuntime } from './repository'

/** Applies ops with the real reducer and records them. */
function fakeDocument() {
  let doc: WorkspaceDocument = createDocument()
  const ops: Array<DocChange | DocBatch> = []
  return {
    ops,
    changes: () => ops.flatMap((op) => opChanges(op)),
    get: () => doc,
    async apply(op: DocChange | DocBatch) {
      const result = applyOp(doc, op)
      if (result.error) throw new RpcError(result.error.code, result.error.message)
      ops.push(op)
      doc = result.doc
    },
  }
}

const addPanel = (record: PanelRecord): DocChange => ({
  kind: 'addPanel',
  record,
  at: { to: 'stack', dock: { windowId: 'main' }, stackId: 'stack-1' },
})

const terminal = (id: string, worktreeId?: string): PanelRecord =>
  ({ id, type: 'terminal', title: id, fields: {}, ...(worktreeId ? { worktreeId } : {}) })

describe('worktree lifecycle', () => {
  let root: string
  let trusted: boolean
  let closePanels: boolean
  let document: ReturnType<typeof fakeDocument>
  let checkouts: Set<string>
  let repo: RepositoryRuntime
  let ids: number

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-repo-')))
    const git = simpleGit(root)
    await git.init()
    await git.addConfig('user.name', 'Cate Test')
    await git.addConfig('user.email', 'cate@example.test')
    await fs.writeFile(path.join(root, 'README.md'), 'hello\n')
    await git.add('README.md')
    await git.commit('initial')
    trusted = true
    closePanels = true
    ids = 0
    document = fakeDocument()
    checkouts = new Set()
    repo = createRepositoryRuntime({
      root,
      env: () => process.env,
      trust: {
        isTrusted: () => trusted,
        requireTrusted: () => { if (!trusted) throw new RpcError('untrusted') },
      },
      paths: {
        resolveDir: (dir) => dir,
        addCheckout: (p) => checkouts.add(p),
        removeCheckout: (p) => checkouts.delete(p),
      },
      document,
      settings: { get: () => closePanels },
      newId: () => `wt-${++ids}`,
    })
  })

  afterEach(async () => {
    repo.dispose()
    await fs.rm(root, { recursive: true, force: true })
  })

  const statuses = () => document.changes().flatMap((c) =>
    c.kind === 'setWorktree' ? [`${c.worktree.id}:${c.worktree.status}`] : c.kind === 'removeWorktree' ? [`${c.id}:gone`] : [])

  test('create writes creating, then ready, and makes the checkout', async () => {
    const meta = await repo.createWorktree({ branch: 'fix the bug' })

    const target = path.join(root, '.cate', 'worktrees', 'fix-the-bug')
    expect(meta).toMatchObject({ id: 'wt-1', path: target, label: 'fix the bug', status: 'ready', color: 'green' })
    expect(statuses()).toEqual(['wt-1:creating', 'wt-1:ready'])
    expect(document.get().worktrees['wt-1'].status).toBe('ready')
    expect((await simpleGit(target).branchLocal()).current).toBe('fix-the-bug')
    expect(checkouts.has(target)).toBe(true)
  })

  test('a second identical create joins the running one', async () => {
    const [a, b] = await Promise.all([
      repo.createWorktree({ branch: 'feature' }),
      repo.createWorktree({ branch: 'feature' }),
    ])
    expect(a).toBe(b)
    expect(statuses()).toEqual(['wt-1:creating', 'wt-1:ready'])
    await expect(repo.createWorktree({ branch: 'feature' })).rejects.toSatisfy((e) => isRpcError(e, 'rejected'))
  })

  test('a failed create drops its metadata', async () => {
    await expect(repo.createWorktree({ branch: 'broken', base: 'no-such-ref' })).rejects.toThrow()
    expect(statuses()).toEqual(['wt-1:creating', 'wt-1:gone'])
    expect(document.get().worktrees).toEqual({})
  })

  test('remove closes bound panels, deletes the branch and drops the metadata', async () => {
    const meta = await repo.createWorktree({ branch: 'feature' })
    await document.apply({ kind: 'batch', changes: [addPanel(terminal('t1', meta.id)), addPanel(terminal('t2'))] })

    expect(await repo.removeWorktree({ worktreeId: meta.id })).toEqual({})

    expect(statuses()).toEqual(['wt-1:creating', 'wt-1:ready', 'wt-1:removing', 'wt-1:gone'])
    expect(Object.keys(document.get().panels)).toEqual(['t2'])
    expect(document.get().worktrees).toEqual({})
    await expect(fs.stat(meta.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await simpleGit(root).branchLocal()).all).not.toContain('feature')
    expect(checkouts.has(meta.path)).toBe(false)
  })

  test('remove moves bound panels to the main checkout when closing is off', async () => {
    closePanels = false
    await repo.reconcileWorktrees()
    const main = Object.values(document.get().worktrees).find((w) => w.path === root)!
    const meta = await repo.createWorktree({ branch: 'feature' })
    await document.apply(addPanel(terminal('t1', meta.id)))

    await repo.removeWorktree({ worktreeId: meta.id, deleteBranch: false })

    expect(document.get().panels.t1.worktreeId).toBe(main.id)
    expect(Object.keys(document.get().worktrees)).toEqual([main.id])
    expect((await simpleGit(root).branchLocal()).all).toContain('feature')
  })

  test('a second identical remove joins the running one', async () => {
    const meta = await repo.createWorktree({ branch: 'feature' })
    const [a, b] = await Promise.all([
      repo.removeWorktree({ worktreeId: meta.id }),
      repo.removeWorktree({ worktreeId: meta.id }),
    ])
    expect(a).toBe(b)
    expect(statuses().filter((s) => s.endsWith(':removing'))).toHaveLength(1)
    await expect(repo.removeWorktree({ worktreeId: meta.id })).rejects.toSatisfy((e) => isRpcError(e, 'gone'))
  })

  test('a failed remove restores the status', async () => {
    const meta = await repo.createWorktree({ branch: 'feature' })
    await fs.writeFile(path.join(meta.path, 'dirty.txt'), 'x\n')
    await simpleGit(meta.path).add('dirty.txt')

    await expect(repo.removeWorktree({ worktreeId: meta.id })).rejects.toThrow()
    expect(document.get().worktrees[meta.id].status).toBe('ready')
    await repo.removeWorktree({ worktreeId: meta.id, force: true })
    expect(document.get().worktrees).toEqual({})
  })

  test('the main checkout cannot be removed', async () => {
    await repo.reconcileWorktrees()
    const [main] = Object.values(document.get().worktrees)
    await expect(repo.removeWorktree({ worktreeId: main.id })).rejects.toSatisfy((e) => isRpcError(e, 'rejected'))
  })

  test('reconcile adds metadata for checkouts made outside Cate, once', async () => {
    const outside = path.join(root, '.cate', 'worktrees', 'cli')
    await simpleGit(root).raw(['worktree', 'add', '-b', 'cli', outside])
    await repo.reconcileWorktrees()
    await repo.reconcileWorktrees()
    const paths = Object.values(document.get().worktrees).map((w) => w.path).sort()
    expect(paths).toEqual([root, outside].sort())
  })

  test('prune drops metadata whose checkout is gone, with its panels', async () => {
    const meta = await repo.createWorktree({ branch: 'feature' })
    await document.apply(addPanel(terminal('t1', meta.id)))
    await fs.rm(meta.path, { recursive: true, force: true })

    const result = await repo.pruneWorktrees()

    expect(result.removed).toEqual([meta.id])
    expect(document.get().worktrees[meta.id]).toBeUndefined()
    expect(document.get().panels.t1).toBeUndefined()
  })

  test('an untrusted workspace runs no git at all', async () => {
    trusted = false
    const impl = vcsCapabilityImpl(repo)
    const ctx = { connection: { id: 1 }, signal: new AbortController().signal } as unknown as CallContext
    const untrusted = (e: unknown) => isRpcError(e, 'untrusted')

    expect(() => repo.createWorktree({ branch: 'x' })).toThrow(RpcError)
    expect(() => repo.removeWorktree({ worktreeId: 'x' })).toThrow(RpcError)
    await expect(Promise.resolve().then(() => impl.readStatus({}, ctx))).rejects.toSatisfy(untrusted)
    await expect(Promise.resolve().then(() => impl.isRepo({}, ctx))).rejects.toSatisfy(untrusted)
    await expect(Promise.resolve().then(() => impl.commit({ message: 'm' }, ctx))).rejects.toSatisfy(untrusted)
    await expect(Promise.resolve().then(() => impl.githubConnection(undefined, ctx))).rejects.toSatisfy(untrusted)
    // The status stream waits for trust: no snapshot, no git.
    const emit = vi.fn()
    const stop = await impl.status({}, { emit } as never, ctx)
    await new Promise((r) => setTimeout(r, 50))
    expect(emit).not.toHaveBeenCalled()
    await repo.reconcileWorktrees()
    expect(document.ops).toEqual([])

    trusted = true
    repo.trustChanged()
    await vi.waitFor(() => expect(emit).toHaveBeenCalled())
    stop?.()
  })

  test('the status stream sends a snapshot and follows writes', async () => {
    const impl = vcsCapabilityImpl(repo)
    const ctx = { connection: { id: 1 }, signal: new AbortController().signal } as unknown as CallContext
    const events: Array<{ dirty: boolean; files: unknown[] }> = []
    const sink = { emit: (e: { dirty: boolean; files: unknown[] }) => events.push(e) } as never
    const stop = await impl.status({}, sink, ctx)
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ isRepo: true, dirty: false, files: [] })

    await fs.writeFile(path.join(root, 'README.md'), 'changed\n')
    await impl.stageAll({}, ctx)
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ dirty: true }))
    if (typeof stop === 'function') stop()
  })
})
