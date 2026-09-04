import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  begin: vi.fn(),
  location: { kind: 'canvas', canvasPanelId: 'canvas-1' } as
    | { kind: 'canvas'; canvasPanelId: string }
    | { kind: 'dock'; zone: 'left' | 'right' | 'bottom' | 'center'; stackId: string },
  workspace: {
    id: 'ws',
    panels: {
      terminal: { id: 'terminal', type: 'terminal', title: 'Terminal' },
      editor: { id: 'editor', type: 'editor', title: 'Editor' },
      review: { id: 'review', type: 'review', title: 'Review' },
    },
  } as any,
}))

vi.mock('../stores/appStore', () => ({
  useAppStore: { getState: () => ({ workspaces: [state.workspace] }) },
}))

vi.mock('./workspace/canvasAccess', () => ({
  resolvePanelLocation: () => state.location,
  getActiveCanvasPanelId: () => 'canvas-active',
  getWorkspaceCanvasPanelId: () => 'canvas-primary',
  getCanvasOpsById: () => ({ storeApi: { getState: () => ({ beginPanelTarget: state.begin }) } }),
}))

import { requestPanelTarget } from './panelTargetPicker'

describe('generic panel target picker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.location = { kind: 'canvas', canvasPanelId: 'canvas-1' }
  })

  it.each(['new', 'existing', 'both'] as const)(
    'passes through the %s availability requested by the consumer',
    async (availability) => {
      state.begin.mockImplementationOnce((request) => {
        request.onSelected({ kind: 'existing', panelId: 'terminal' })
        return true
      })
      await expect(requestPanelTarget({
        workspaceId: 'ws',
        panelType: 'terminal',
        availability,
        sourcePanelId: 'review',
      })).resolves.toEqual({ kind: 'existing', panelId: 'terminal' })
      expect(state.begin).toHaveBeenCalledWith(expect.objectContaining({
        panelType: 'terminal',
        availability,
        existing: [{ panelId: 'terminal', title: 'Terminal' }],
      }))
    },
  )

  it('works for any requested panel type and returns a canvas placement for new targets', async () => {
    state.begin.mockImplementationOnce((request) => {
      request.onSelected({ kind: 'new', point: { x: 40, y: 80 }, size: { width: 900, height: 600 } })
      return true
    })
    await expect(requestPanelTarget({
      workspaceId: 'ws',
      panelType: 'review',
      availability: 'both',
      existingPanelIds: ['review'],
      sourcePanelId: 'editor',
    })).resolves.toEqual({
      kind: 'new',
      placement: {
        target: 'canvas',
        canvasPanelId: 'canvas-1',
        position: { x: 40, y: 80 },
        size: { width: 900, height: 600 },
      },
    })
    expect(state.begin).toHaveBeenCalledWith(expect.objectContaining({
      panelType: 'review',
      existing: [{ panelId: 'review', title: 'Review' }],
    }))
  })

  it.each(['new', 'both'] as const)(
    'places a new panel beside a docked consumer for %s availability',
    async (availability) => {
      state.location = { kind: 'dock', zone: 'right', stackId: 'review-stack' }

      await expect(requestPanelTarget({
        workspaceId: 'ws',
        panelType: 'terminal',
        availability,
        sourcePanelId: 'review',
      })).resolves.toEqual({
        kind: 'new',
        placement: { target: 'dock', zone: 'right', stackId: 'review-stack' },
      })
      expect(state.begin).not.toHaveBeenCalled()
    },
  )

  it('returns no target for an existing-only request from a docked consumer', async () => {
    state.location = { kind: 'dock', zone: 'bottom', stackId: 'review-stack' }

    await expect(requestPanelTarget({
      workspaceId: 'ws',
      panelType: 'terminal',
      availability: 'existing',
      sourcePanelId: 'review',
    })).resolves.toBeNull()
    expect(state.begin).not.toHaveBeenCalled()
  })
})
