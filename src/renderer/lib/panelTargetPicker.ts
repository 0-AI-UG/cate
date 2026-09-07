import type { PanelType } from '../../shared/types'
import { PANEL_DEFINITIONS } from '../../shared/panels'
import type { PanelPlacement } from '../stores/appStore'
import type { PanelTargetAvailability } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import {
  getActiveCanvasPanelId,
  getCanvasOpsById,
  getWorkspaceCanvasPanelId,
  placementForPanel,
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
  /** Additional candidates owned by another window, resolved by the caller. */
  additionalExisting?: Array<{ panelId: string; title: string }>
  /** Prefer the canvas containing this panel; otherwise use the active or primary canvas. */
  sourcePanelId?: string
  chooseExistingInDock?: boolean
}

export function requestPanelTarget(request: PanelTargetRequest): Promise<PanelTarget | null> {
  const state = useAppStore.getState()
  const workspace = state.workspaces.find((candidate) => candidate.id === request.workspaceId)
  if (!workspace) return Promise.resolve(null)
  const existing = [
    ...Object.values(workspace.panels)
      .filter((panel) => panel.type === request.panelType && (!request.existingPanelIds || request.existingPanelIds.includes(panel.id)))
      .map((panel) => ({ panelId: panel.id, title: panel.title })),
    ...(request.additionalExisting ?? []),
  ].filter((candidate, index, all) => all.findIndex((item) => item.panelId === candidate.panelId) === index)

  const sourcePlacement = request.sourcePanelId
    ? placementForPanel(request.workspaceId, request.sourcePanelId)
    : undefined
  if (sourcePlacement?.target === 'dock') {
    if (request.chooseExistingInDock && request.availability === 'both') {
      return window.electronAPI.showContextMenu([
        { id: '__new', label: `New ${PANEL_DEFINITIONS[request.panelType].label}` },
        ...existing.map((panel) => ({ id: panel.panelId, label: panel.title })),
      ]).then((id) => !id ? null : id === '__new'
        ? { kind: 'new' as const, placement: sourcePlacement }
        : { kind: 'existing' as const, panelId: id })
    }
    if (request.availability === 'existing') return Promise.resolve(null)
    return Promise.resolve({
      kind: 'new',
      placement: sourcePlacement,
    })
  }
  const canvasPanelId = sourcePlacement?.target === 'canvas'
    ? sourcePlacement.canvasPanelId
    : getActiveCanvasPanelId() ?? getWorkspaceCanvasPanelId(request.workspaceId)
  if (!canvasPanelId) return Promise.resolve(null)
  const canvas = getCanvasOpsById(canvasPanelId)?.storeApi
  if (!canvas) return Promise.resolve(null)

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
