// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  target: vi.fn(), retarget: vi.fn(async () => true), create: vi.fn(() => 'new'), setState: vi.fn(), title: vi.fn(),
  workspace: { rootPath: '/repo', panels: {} as Record<string, any> },
}))
vi.mock('../panelTargetPicker', () => ({ requestPanelTarget: h.target }))
vi.mock('./openReviewPanel', () => ({ retargetReviewPanel: h.retarget }))
vi.mock('../../stores/appStore', () => ({ useAppStore: { getState: () => ({
  getWorkspace: () => h.workspace, createReview: h.create, setPanelReviewState: h.setState, updatePanelTitle: h.title,
}) } }))
import { openAgentChanges } from './openAgentChanges'

beforeEach(() => {
  vi.clearAllMocks()
  h.workspace.panels = { source: { type: 'agent', agentThreadId: 'chat' }, review: { type: 'review', reviewState: { repoPath: '/repo' } } }
})
describe('agent changes placement handoff', () => {
  it('creates a filtered panel with the clicked file and turn', async () => {
    const placement = { target: 'canvas', canvasPanelId: 'canvas', position: { x: 1, y: 2 } }
    h.target.mockResolvedValue({ kind: 'new', placement })
    await openAgentChanges({ workspaceId: 'ws', panelId: 'source', cwd: '/repo', sessionId: 'chat', turnId: 'turn', focusedFile: 'a.ts' })
    expect(h.target).toHaveBeenCalledWith(expect.objectContaining({ availability: 'both', panelType: 'review', sourcePanelId: 'source' }))
    expect(h.create).toHaveBeenCalledWith('ws', '/repo', { spec: { kind: 'uncommitted' }, agentChanges: { panelId: 'source', sessionId: 'chat', turnId: 'turn' }, focusedFile: 'a.ts' }, undefined, placement)
  })
  it('retargets an existing review, without creating a second one', async () => {
    h.target.mockResolvedValue({ kind: 'existing', panelId: 'review' })
    await openAgentChanges({ workspaceId: 'ws', panelId: 'source', cwd: '/repo', focusedFile: 'b.ts' })
    expect(h.create).not.toHaveBeenCalled()
    expect(h.retarget).toHaveBeenCalledWith('ws', 'review', expect.objectContaining({ agentChanges: expect.objectContaining({ panelId: 'source' }), focusedFile: 'b.ts' }))
  })
  it('leaves everything untouched on cancel or conversation switch', async () => {
    h.target.mockResolvedValue(null)
    expect(await openAgentChanges({ workspaceId: 'ws', panelId: 'source', cwd: '/repo' })).toBe(false)
    h.target.mockResolvedValue({ kind: 'existing', panelId: 'review' })
    expect(await openAgentChanges({ workspaceId: 'ws', panelId: 'source', cwd: '/repo', sessionId: 'old-chat' })).toBe(false)
    expect(h.create).not.toHaveBeenCalled()
    expect(h.retarget).not.toHaveBeenCalled()
    expect(h.setState).not.toHaveBeenCalled()
  })
})
