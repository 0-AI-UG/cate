import { describe, expect, it } from 'vitest'
import type { PanelState } from '../../shared/types'
import { selectedWorktree, worktreeForPanel, worktreeForPath } from './worktreeContext'

const worktrees = [
  { id: 'primary', path: '/repo', isPrimary: true },
  { id: 'feature', path: '/checkouts/feature' },
]

describe('worktreeContext', () => {
  it('resolves files in sibling checkouts and chooses the most specific root', () => {
    const nested = { id: 'nested', path: '/checkouts/feature/vendor' }
    expect(worktreeForPath('/checkouts/feature/src/app.ts', worktrees)?.id).toBe('feature')
    expect(worktreeForPath('/checkouts/feature/vendor/pkg/a.ts', [...worktrees, nested])?.id).toBe('nested')
    expect(worktreeForPath('/elsewhere/file.ts', worktrees)).toBeUndefined()
  })

  it('keeps runtime locators isolated even when their host paths match', () => {
    const remote = [
      { id: 'a', path: 'cate-runtime://server-a/srv/repo', isPrimary: true },
      { id: 'b', path: 'cate-runtime://server-b/srv/repo' },
    ]
    expect(worktreeForPath('cate-runtime://server-b/srv/repo/src/a.ts', remote)?.id).toBe('b')
  })

  it('derives editor, document, and review affinity from their operative paths', () => {
    const editor: PanelState = {
      id: 'editor', type: 'editor', title: 'app.ts', isDirty: false,
      filePath: '/checkouts/feature/src/app.ts',
    }
    const document: PanelState = {
      id: 'document', type: 'document', title: 'spec.pdf', isDirty: false,
      filePath: '/checkouts/feature/docs/spec.pdf',
    }
    const review: PanelState = {
      id: 'review', type: 'review', title: 'Review', isDirty: false,
      reviewState: {
        repoPath: '/checkouts/feature',
        spec: { kind: 'uncommitted' },
        display: { split: false, wordDiff: true, wrap: false, fullFile: false, advancedPreview: true },
        collapsedFiles: [], notes: [],
      },
    }
    expect(worktreeForPanel(editor, worktrees)?.id).toBe('feature')
    expect(worktreeForPanel(document, worktrees)?.id).toBe('feature')
    expect(worktreeForPanel(review, worktrees)?.id).toBe('feature')
  })

  it('falls back to the primary live checkout when a saved selection is stale', () => {
    expect(selectedWorktree([
      ...worktrees,
      { id: 'gone', path: '/gone', isOrphan: true },
    ], 'gone')?.id).toBe('primary')
  })
})
