// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  target: vi.fn(),
  workspace: { id: 'ws', panels: {} as Record<string, any> },
  createReview: vi.fn(() => 'new-review'),
  setPanelReviewState: vi.fn(),
  revealPanel: vi.fn(async () => true),
  placementForPanel: vi.fn(),
  placementForActivePanel: vi.fn(),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      getWorkspace: () => h.workspace,
      createReview: h.createReview,
      setPanelReviewState: h.setPanelReviewState,
    }),
  },
}))
vi.mock('../panelTargetPicker', () => ({ requestPanelTarget: h.target }))
vi.mock('../activePanel', () => ({ getActivePanelId: () => null }))
vi.mock('../workspace/panelReveal', () => ({ revealPanel: h.revealPanel }))
vi.mock('../workspace/canvasAccess', () => ({
  placementForPanel: h.placementForPanel,
  placementForActivePanel: h.placementForActivePanel,
}))

import { useWindowPanelStore } from '../../stores/windowPanelStore'
import { openReviewPanel, retargetReviewPanel } from './openReviewPanel'

const spec = { kind: 'unstaged' as const }

beforeEach(() => {
  h.target.mockReset()
  h.workspace.panels = {}
  h.createReview.mockClear()
  h.setPanelReviewState.mockClear()
  h.revealPanel.mockClear()
  h.placementForPanel.mockReset()
  h.placementForActivePanel.mockReset()
  useWindowPanelStore.setState({ panels: [] })
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    openWindowReviewPanel: vi.fn(async () => true),
  }
})

describe('openReviewPanel', () => {
  it('retargets an existing Review panel in another window instead of duplicating it', async () => {
    useWindowPanelStore.setState({ panels: [{
      panelId: 'detached-review',
      type: 'review',
      title: 'Diff Review',
      workspaceId: 'ws',
      ownerWindowId: 9,
      ownerWindowType: 'dock',
      reviewRepoPath: '/repo',
    }] })

    await expect(openReviewPanel({
      workspaceId: 'ws',
      repoPath: '/repo',
      spec,
      focusedFile: 'src/a.ts',
    })).resolves.toBe('detached-review')

    expect(window.electronAPI.openWindowReviewPanel).toHaveBeenCalledWith('detached-review', {
      spec,
      focusedFile: 'src/a.ts',
      sourceAgent: undefined,
    })
    expect(h.createReview).not.toHaveBeenCalled()
  })

  it('places a new Review panel with the initiating panel', async () => {
    const placement = { target: 'dock', zone: 'center', stackId: 'source-stack' }
    h.placementForPanel.mockReturnValue(placement)
    const sourceAgent = { runId: 'run-1', ownerPanelId: 'owner', panelId: 'worker' }

    await openReviewPanel({ workspaceId: 'ws', repoPath: '/repo', spec, sourceAgent })

    expect(h.placementForPanel).toHaveBeenCalledWith('ws', 'worker')
    expect(h.createReview).toHaveBeenCalledWith(
      'ws',
      '/repo',
      { spec, focusedFile: undefined, sourceAgent },
      undefined,
      placement,
    )
  })
})

describe('retargetReviewPanel', () => {
  it('updates and reveals an owned Review panel while preserving its local UI state', async () => {
    h.workspace.panels.review = {
      id: 'review',
      type: 'review',
      reviewState: {
        repoPath: '/repo',
        spec: { kind: 'uncommitted' },
        display: { split: true, wordDiff: true, wrap: false, fullFile: false, advancedPreview: true },
        collapsedFiles: ['src/a.ts', 'src/b.ts'],
        notes: [{ id: 'note-1' }],
      },
    }

    await expect(retargetReviewPanel('ws', 'review', {
      spec,
      focusedFile: 'src/a.ts',
    })).resolves.toBe(true)

    expect(h.setPanelReviewState).toHaveBeenCalledWith('ws', 'review', expect.objectContaining({
      spec,
      focusedFile: 'src/a.ts',
      collapsedFiles: ['src/b.ts'],
      notes: [{ id: 'note-1' }],
      display: expect.objectContaining({ split: true }),
    }))
    expect(h.revealPanel).toHaveBeenCalledWith('ws', 'review', { retry: true })
  })
})


describe('overlay review requests', () => {
  it('offers matching reviews instead of silently reusing one', async () => {
    h.workspace.panels.review = { id: 'review', type: 'review', reviewState: { repoPath: '/repo', spec } }
    h.target.mockResolvedValue({ kind: 'existing', panelId: 'review' })
    expect(await openReviewPanel({ workspaceId: 'ws', repoPath: '/repo', spec, source: 'overlay' })).toBe('review')
    expect(h.target).toHaveBeenCalledWith({ workspaceId: 'ws', panelType: 'review', source: 'overlay', availability: 'both', existingPanelIds: ['review'] })
    expect(h.createReview).not.toHaveBeenCalled()
    expect(h.setPanelReviewState).toHaveBeenCalled()
  })
  it.each(['canvas', 'dock'] as const)('uses the selected %s placement exactly once', async (target) => {
    const placement = target === 'canvas' ? { target, canvasPanelId: 'first', position: { x: 1, y: 2 }, size: { width: 600, height: 400 } } : { target, zone: 'center' }
    h.target.mockResolvedValue({ kind: 'new', placement })
    expect(await openReviewPanel({ workspaceId: 'ws', repoPath: '/repo', spec, source: 'overlay', openNew: true })).toBe('new-review')
    expect(h.target).toHaveBeenCalledWith(expect.objectContaining({ availability: 'new' }))
    expect(h.createReview).toHaveBeenCalledWith('ws', '/repo', expect.objectContaining({ spec }), undefined, placement)
    expect(h.placementForActivePanel).not.toHaveBeenCalled()
  })
  it('cancellation leaves reviews untouched', async () => {
    h.target.mockResolvedValue(null)
    expect(await openReviewPanel({ workspaceId: 'ws', repoPath: '/repo', spec, source: 'overlay' })).toBeNull()
    expect(h.createReview).not.toHaveBeenCalled()
    expect(h.setPanelReviewState).not.toHaveBeenCalled()
  })
})
