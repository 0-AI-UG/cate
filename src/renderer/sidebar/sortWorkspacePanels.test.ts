import { describe, it, expect } from 'vitest'
import { sortWorkspacePanels } from './sortWorkspacePanels'

interface P {
  id: string
  type: string
  title?: string
  worktreeId?: string
}
const panel = (id: string, type: string, title?: string, worktreeId?: string): P => ({
  id,
  type,
  title,
  worktreeId,
})

const ids = (panels: P[]): string[] => panels.map((p) => p.id)

const worktrees = [
  { id: 'wt-main', path: '/repo' },
  { id: 'wt-feat', path: '/repo/.cate/worktrees/feat' },
  { id: 'wt-fix', path: '/repo/.cate/worktrees/fix' },
]

describe('sortWorkspacePanels', () => {
  it('groups a worktree\'s terminals/agents together, primary worktree first', () => {
    // Interleaved by title (the old type-then-title order). After grouping, each
    // worktree's panels are adjacent.
    const panels = [
      panel('a-claude', 'terminal', 'Claude Code', 'wt-main'),
      panel('b-claude', 'terminal', 'Claude Code 3', 'wt-feat'),
      panel('c-claude', 'terminal', 'Claude Code 6', 'wt-fix'),
      panel('d-dev', 'terminal', 'Dev Server', 'wt-feat'),
      panel('e-term', 'terminal', 'Terminal 2', 'wt-fix'),
    ]
    const sorted = sortWorkspacePanels(panels, worktrees, '/repo')
    expect(ids(sorted)).toEqual([
      'a-claude', // wt-main (primary)
      'b-claude', 'd-dev', // wt-feat, by title
      'c-claude', 'e-term', // wt-fix, by title
    ])
  })

  it('places the primary worktree (the rootPath checkout) first regardless of registry order', () => {
    // Primary listed LAST in the registry — it must still rank first.
    const reordered = [
      { id: 'wt-feat', path: '/repo/.cate/worktrees/feat' },
      { id: 'wt-main', path: '/repo' },
    ]
    const panels = [
      panel('feat', 'terminal', 'A', 'wt-feat'),
      panel('main', 'terminal', 'B', 'wt-main'),
    ]
    const sorted = sortWorkspacePanels(panels, reordered, '/repo')
    expect(ids(sorted)).toEqual(['main', 'feat'])
  })

  it('groups untagged panels with the primary worktree', () => {
    const panels = [
      panel('tagged-feat', 'terminal', 'Z', 'wt-feat'),
      panel('untagged', 'terminal', 'A'),
    ]
    const sorted = sortWorkspacePanels(panels, worktrees, '/repo')
    // Untagged → rank 0 (primary group) → sorts ahead of the wt-feat panel.
    expect(ids(sorted)).toEqual(['untagged', 'tagged-feat'])
  })

  it('resolves a path-valued worktree tag to its registry record', () => {
    const panels = [
      panel('by-path', 'terminal', 'A', '/repo/.cate/worktrees/fix'),
      panel('by-id', 'terminal', 'B', 'wt-feat'),
    ]
    const sorted = sortWorkspacePanels(panels, worktrees, '/repo')
    // wt-feat ranks before wt-fix → by-id first.
    expect(ids(sorted)).toEqual(['by-id', 'by-path'])
  })

  it('within a worktree, orders by type then title', () => {
    const panels = [
      panel('term-b', 'terminal', 'B', 'wt-main'),
      panel('canvas', 'canvas', 'Canvas', 'wt-main'),
      panel('term-a', 'terminal', 'A', 'wt-main'),
      panel('editor', 'editor', 'file.ts', 'wt-main'),
    ]
    const sorted = sortWorkspacePanels(panels, worktrees, '/repo')
    expect(ids(sorted)).toEqual(['canvas', 'term-a', 'term-b', 'editor'])
  })

  it('falls back to type-then-title when there are no worktrees', () => {
    const panels = [
      panel('t2', 'terminal', 'B'),
      panel('c', 'canvas', 'Canvas'),
      panel('t1', 'terminal', 'A'),
    ]
    const sorted = sortWorkspacePanels(panels, undefined, '/repo')
    expect(ids(sorted)).toEqual(['c', 't1', 't2'])
  })

  it('does not mutate the input array', () => {
    const panels = [
      panel('b', 'terminal', 'B', 'wt-feat'),
      panel('a', 'terminal', 'A', 'wt-main'),
    ]
    const before = ids(panels)
    sortWorkspacePanels(panels, worktrees, '/repo')
    expect(ids(panels)).toEqual(before)
  })
})
