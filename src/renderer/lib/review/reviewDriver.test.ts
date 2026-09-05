import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  workspace: {} as any,
  setPanelReviewState: vi.fn(),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      workspaces: [state.workspace],
      setPanelReviewState: state.setPanelReviewState,
    }),
  },
}))

import { handleReviewMethod } from './reviewDriver'

describe('review CLI driver', () => {
  const comparison = {
    files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }],
    additions: 1,
    deletions: 1,
    resolvedBase: 'base-sha',
    resolvedTarget: 'target-sha',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    const reviewState = {
      repoPath: '/repo',
      spec: { kind: 'branch', base: 'main', target: 'feature' },
      display: { split: false, wordDiff: true, wrap: false, fullFile: false, advancedPreview: true },
      notes: [],
      agentReview: {
        runId: 'review-run',
        terminalPanelId: 'reviewer',
        status: 'working',
        startedAt: 1,
      },
    }
    state.workspace = {
      id: 'ws',
      panels: {
        review: { id: 'review', type: 'review', reviewState },
        reviewer: {
          id: 'reviewer',
          type: 'terminal',
          codingAgentRun: { id: 'review-run', ownerPanelId: 'review', createdAt: 1 },
        },
      },
    }
    state.setPanelReviewState.mockImplementation((_workspaceId, panelId, next) => {
      state.workspace.panels[panelId].reviewState = next
    })
    vi.stubGlobal('crypto', { randomUUID: () => 'note-1234' })
    vi.stubGlobal('window', {
      electronAPI: {
        gitCompare: vi.fn(async () => comparison),
        gitFileDiff: vi.fn(async () => ({
          path: 'src/a.ts',
          binary: false,
          tooLarge: false,
          byteLength: 10,
          hunks: [{
            header: '@@ -4 +4 @@',
            lines: [{ kind: 'add', text: 'return safe()', oldLine: null, newLine: 4 }],
          }],
        })),
      },
    })
  })

  it('inspects the live comparison and notes', async () => {
    const outcome = await handleReviewMethod('ws', 'reviewer', 'cate.review.inspect', { panelId: 'review' })
    expect(outcome).toEqual({
      ok: true,
      result: expect.objectContaining({
        panelId: 'review',
        repoPath: '/repo',
        files: comparison.files,
        resolvedBase: 'base-sha',
      }),
    })
  })

  it('adds an agent-authored note anchored to a diff line', async () => {
    const outcome = await handleReviewMethod('ws', 'reviewer', 'cate.review.note.add', {
      panelId: 'review',
      file: 'src/a.ts',
      line: 4,
      side: 'new',
      severity: 'error',
      body: 'This can throw.',
    })
    expect(outcome).toEqual({
      ok: true,
      result: expect.objectContaining({
        id: 'note-1234',
        path: 'src/a.ts',
        line: 4,
        context: 'return safe()',
        status: 'open',
        severity: 'error',
        author: 'agent',
        agentRunId: 'review-run',
      }),
    })
    expect(state.workspace.panels.review.reviewState.notes).toHaveLength(1)
  })

  it('rejects targets outside the reviewed diff', async () => {
    await expect(handleReviewMethod('ws', 'reviewer', 'cate.review.note.add', {
      panelId: 'review',
      file: 'src/missing.ts',
      side: 'new',
      line: 4,
      body: 'Not reviewed',
    })).resolves.toEqual({ ok: false, error: 'file-not-in-review' })
  })

  it('rejects file-level notes', async () => {
    await expect(handleReviewMethod('ws', 'reviewer', 'cate.review.note.add', {
      panelId: 'review',
      file: 'src/a.ts',
      side: 'file',
      body: 'Whole-file comment',
    })).resolves.toEqual({ ok: false, error: 'invalid-side' })
  })

  it('resolves notes by prefix and only lets the assigned reviewer complete', async () => {
    state.workspace.panels.review.reviewState.notes = [{
      id: 'note-abcdef',
      path: 'src/a.ts',
      side: 'file',
      line: null,
      body: 'Fix this',
      context: '',
      resolvedBase: null,
      resolvedTarget: null,
      createdAt: 'now',
    }]
    await expect(handleReviewMethod('ws', 'reviewer', 'cate.review.note.resolve', {
      panelId: 'review', noteId: 'note-a',
    })).resolves.toEqual({ ok: true, result: { noteId: 'note-abcdef', status: 'resolved' } })
    expect(state.workspace.panels.review.reviewState.notes[0].status).toBe('resolved')

    await expect(handleReviewMethod('ws', 'other', 'cate.review.complete', { panelId: 'review' }))
      .resolves.toEqual({ ok: false, error: 'review-agent-mismatch' })
    await expect(handleReviewMethod('ws', 'reviewer', 'cate.review.complete', { panelId: 'review' }))
      .resolves.toEqual({ ok: true, result: { status: 'complete' } })
    expect(state.workspace.panels.review.reviewState.agentReview.status).toBe('complete')
  })
})
