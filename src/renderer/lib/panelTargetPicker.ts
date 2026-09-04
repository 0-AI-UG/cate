import type { PanelType } from '../../shared/types'
import type { PanelPlacement } from '../stores/appStore'
import type { PanelTargetAvailability } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import {
  getActiveCanvasPanelId,
  getCanvasOpsById,
  getWorkspaceCanvasPanelId,
  resolvePanelLocation,
} from './workspace/canvasAccess'

export type PanelTarget =
  | { kind: 'new'; placement: Extract<PanelPlacement, { target: 'canvas' | 'dock' }> }
  | { kind: 'existing'; panelId: string }

export interface PanelTargetRequest {
  workspaceId: string
  panelType: PanelType
  availability: PanelTargetAvailability
  /** Restrict existing choices after the type filter (for example, idle terminals in one worktree). */
  existingPanelIds?: string[]
  /** Prefer the canvas containing this panel; otherwise use the active or primary canvas. */
  sourcePanelId?: string
}

export function requestPanelTarget(request: PanelTargetRequest): Promise<PanelTarget | null> {
  const state = useAppStore.getState()
  const workspace = state.workspaces.find((candidate) => candidate.id === request.workspaceId)
  if (!workspace) return Promise.resolve(null)

  const sourceLocation = request.sourcePanelId
    ? resolvePanelLocation(request.workspaceId, request.sourcePanelId)
    : null
  if (sourceLocation?.kind === 'dock') {
    if (request.availability === 'existing') return Promise.resolve(null)
    return Promise.resolve({
      kind: 'new',
      placement: {
        target: 'dock',
        zone: sourceLocation.zone,
        stackId: sourceLocation.stackId,
      },
    })
  }
  const canvasPanelId = sourceLocation?.kind === 'canvas'
    ? sourceLocation.canvasPanelId
    : getActiveCanvasPanelId() ?? getWorkspaceCanvasPanelId(request.workspaceId)
  if (!canvasPanelId) return Promise.resolve(null)
  const canvas = getCanvasOpsById(canvasPanelId)?.storeApi
  if (!canvas) return Promise.resolve(null)

  const allowed = request.existingPanelIds ? new Set(request.existingPanelIds) : null
  const existing = Object.values(workspace.panels)
    .filter((panel) => panel.type === request.panelType && (!allowed || allowed.has(panel.id)))
    .map((panel) => ({ panelId: panel.id, title: panel.title }))

  return new Promise((resolve) => {
    const shown = canvas.getState().beginPanelTarget({
      panelType: request.panelType,
      availability: request.availability,
      existing,
      onSelected: (choice) => resolve(choice.kind === 'existing'
        ? choice
        : {
            kind: 'new',
            placement: {
              target: 'canvas',
              canvasPanelId,
              position: choice.point,
              size: choice.size,
            },
          }),
      onCancelled: () => resolve(null),
    })
    if (!shown) resolve(null)
  })
}
