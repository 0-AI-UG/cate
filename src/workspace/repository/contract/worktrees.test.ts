import { describe, expect, it } from 'vitest'
import { createDocument, type PanelRecord, type WorktreeMeta } from '@workspace/document/contract'
import {
  inheritWorktree,
  panelCheckout,
  joinWorktrees,
  pickWorktreeColor,
  resolveWorktree,
  selectedWorktree,
  toBranchName,
  worktreeForPanel,
  worktreeForPath,
  worktreeRemovalChanges,
  worktreeSlug,
  WORKTREE_COLORS,
  type PanelCheckoutHooks,
} from '../contract'

const meta = (id: string, path: string, extra: Partial<WorktreeMeta> = {}): WorktreeMeta =>
  ({ id, path, color: 'green', status: 'ready', ...extra })

const panel = (id: string, type: PanelRecord['type'], extra: Partial<PanelRecord> = {}): PanelRecord =>
  ({ id, type, title: id, fields: {}, ...extra })

const hooks: PanelCheckoutHooks = {
  checkoutPath: (r) => typeof r.fields.filePath === 'string' ? r.fields.filePath : undefined,
  bound: (type) => type === 'terminal' || type === 'chat',
  workingDir: (r) => typeof r.fields.cwd === 'string' ? r.fields.cwd : undefined,
}

const worktrees = [
  { id: 'primary', path: '/repo', isPrimary: true },
  { id: 'feature', path: '/checkouts/feature' },
]

describe('resolveWorktree', () => {
  const wt = meta('wt-x', '/repo/.cate/worktrees/x')
  it('matches by stable id, never by path', () => {
    expect(resolveWorktree('wt-x', [wt])?.path).toBe(wt.path)
    expect(resolveWorktree(wt.path, [wt])).toBeUndefined()
    expect(resolveWorktree('wt-gone', [wt])).toBeUndefined()
    expect(resolveWorktree(undefined, [wt])).toBeUndefined()
  })
})

describe('checkout of a path or panel', () => {
  it('resolves files in sibling checkouts and chooses the most specific root', () => {
    const nested = { id: 'nested', path: '/checkouts/feature/vendor' }
    expect(worktreeForPath('/checkouts/feature/src/app.ts', worktrees)?.id).toBe('feature')
    expect(worktreeForPath('/checkouts/feature/vendor/pkg/a.ts', [...worktrees, nested])?.id).toBe('nested')
    expect(worktreeForPath('/elsewhere/file.ts', worktrees)).toBeUndefined()
    expect(worktreeForPath('C:\\Repo\\src\\a.ts', [{ id: 'w', path: 'c:/repo' }])?.id).toBe('w')
  })

  it('prefers the explicit binding, then the operative path', () => {
    expect(worktreeForPanel(panel('t', 'terminal', { worktreeId: 'feature' }), worktrees, hooks)?.id).toBe('feature')
    expect(worktreeForPanel(panel('e', 'editor', { fields: { filePath: '/checkouts/feature/a.ts' } }), worktrees, hooks)?.id).toBe('feature')
  })

  it('puts an untagged bound panel in the main checkout, and nothing else', () => {
    expect(panelCheckout(panel('t', 'terminal'), worktrees, hooks)?.id).toBe('primary')
    expect(panelCheckout(panel('t', 'terminal', { worktreeId: 'feature' }), worktrees, hooks)?.id).toBe('feature')
    expect(panelCheckout(panel('b', 'browser'), worktrees, hooks)).toBeUndefined()
  })

  it('falls back to the primary live checkout when a saved selection is stale', () => {
    expect(selectedWorktree([...worktrees, { id: 'gone', path: '/gone', isOrphan: true }], 'gone')?.id).toBe('primary')
  })
})

describe('inheritWorktree', () => {
  it('returns {} with nothing selected or a panel outside any checkout', () => {
    expect(inheritWorktree(undefined, worktrees, hooks)).toEqual({})
    expect(inheritWorktree(panel('b', 'browser'), worktrees, hooks)).toEqual({})
  })

  it('passes on a bound panel\'s own directory and binding', () => {
    expect(inheritWorktree(panel('t', 'terminal', { worktreeId: 'wt-a', fields: { cwd: '/repo/wt' } }), worktrees, hooks))
      .toEqual({ cwd: '/repo/wt', worktreeId: 'wt-a' })
    expect(inheritWorktree(panel('c', 'chat', { worktreeId: 'feature' }), worktrees, hooks))
      .toEqual({ cwd: '/checkouts/feature', worktreeId: 'feature' })
  })

  it('inherits the checkout of a file-backed panel', () => {
    expect(inheritWorktree(panel('e', 'editor', { fields: { filePath: '/checkouts/feature/src/file.ts' } }), worktrees, hooks))
      .toEqual({ cwd: '/checkouts/feature', worktreeId: 'feature' })
  })
})

describe('naming', () => {
  it('turns free text into a branch name and a folder slug', () => {
    expect(toBranchName('  fix the login bug ')).toBe('fix-the-login-bug')
    expect(toBranchName('feat/x')).toBe('feat/x')
    expect(worktreeSlug('feat/x')).toBe('feat-x')
    expect(worktreeSlug('///')).toBe('wt')
  })

  it('picks the first unused palette key, wrapping when all are used', () => {
    expect(pickWorktreeColor([])).toBe('green')
    expect(pickWorktreeColor([{ color: 'green' }])).toBe('cyan')
    const all = WORKTREE_COLORS.map((color) => ({ color }))
    expect(pickWorktreeColor(all)).toBe(WORKTREE_COLORS[0])
  })
})

describe('worktreeRemovalChanges', () => {
  const doc = {
    ...createDocument(),
    panels: {
      t1: panel('t1', 'terminal', { worktreeId: 'wt-f' }),
      c1: panel('c1', 'chat', { worktreeId: 'wt-f' }),
      t2: panel('t2', 'terminal', { worktreeId: 'wt-main' }),
    },
    worktrees: { 'wt-main': meta('wt-main', '/repo'), 'wt-f': meta('wt-f', '/repo/.cate/worktrees/f') },
  }

  it('closes bound panels, then drops the metadata', () => {
    expect(worktreeRemovalChanges(doc, 'wt-f', { closePanels: true, root: '/repo' })).toEqual([
      { kind: 'removePanels', ids: ['t1', 'c1'] },
      { kind: 'removeWorktree', id: 'wt-f' },
    ])
  })

  it('moves bound panels to the main checkout', () => {
    expect(worktreeRemovalChanges(doc, 'wt-f', { closePanels: false, root: '/repo/' })).toEqual([
      { kind: 'updatePanel', id: 't1', patch: { worktreeId: 'wt-main' } },
      { kind: 'updatePanel', id: 'c1', patch: { worktreeId: 'wt-main' } },
      { kind: 'removeWorktree', id: 'wt-f' },
    ])
  })

  it('unbinds when there is no main checkout metadata', () => {
    const { 'wt-main': _main, ...rest } = doc.worktrees
    expect(worktreeRemovalChanges({ ...doc, worktrees: rest }, 'wt-f', { closePanels: false, root: '/repo' })[0])
      .toEqual({ kind: 'updatePanel', id: 't1', patch: { worktreeId: null } })
  })
})

describe('joinWorktrees', () => {
  it('joins live checkouts with metadata and lists orphans and pending creates', () => {
    const joined = joinWorktrees('/repo', [
      meta('wt-main', '/repo'),
      meta('wt-f', '/repo/.cate/worktrees/f', { label: 'F' }),
      meta('wt-gone', '/repo/.cate/worktrees/gone'),
      meta('wt-new', '/repo/.cate/worktrees/new', { status: 'creating' }),
    ], [
      { path: '/repo', branch: 'main', isBare: false, isCurrent: true },
      { path: '/repo/.cate/worktrees/f', branch: 'f', isBare: false, isCurrent: false },
      { path: '/elsewhere', branch: 'x', isBare: false, isCurrent: false },
    ])
    expect(joined.map((w) => [w.id, w.isPrimary, w.isOrphan, w.status])).toEqual([
      ['wt-main', true, false, 'ready'],
      ['wt-f', false, false, 'ready'],
      ['/elsewhere', false, false, undefined],
      ['wt-gone', false, true, 'ready'],
      ['wt-new', false, false, 'creating'],
    ])
    expect(joined[1].label).toBe('F')
  })
})
