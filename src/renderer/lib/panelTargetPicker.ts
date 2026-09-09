import type { PanelType } from '../../shared/types'
import { PANEL_DEFINITIONS } from '../../shared/panels'
import type { PanelPlacement } from '../stores/appStore'
import type { PanelTargetAvailability } from '../stores/canvasStore'
import { useAppStore } from '../stores/appStore'
import {
  ensureCanvasOpsForPanel,
  getFirstDockedCanvasPanelId,
  resolvePanelLocation,
  placementForPanel,
} from './workspace/canvasAccess'
import { revealPanel } from './workspace/panelReveal'

export type PanelTarget =
  | { kind: 'new'; placement: Extract<PanelPlacement, { target: 'canvas' | 'dock' }> }
  | { kind: 'existing'; panelId: string }

export interface PanelTargetRequest {
  workspaceId: string
  panelType: PanelType
  availability: PanelTargetAvailability
  /** Restrict existing choices after the type filter (for example, idle terminals in one worktree). */
  existingPanelIds?: string[]
  /** Resolve the source in this window; absent sources use the first docked canvas. */
  sourcePanelId?: string
  /** Overlays use the first docked canvas, or create directly in the center dock. */
  source?: 'overlay'
}

export async function requestPanelTarget(request: PanelTargetRequest): Promise<PanelTarget | null> {
  const state = useAppStore.getState()
  const workspace = state.workspaces.find((candidate) => candidate.id === request.workspaceId)
  if (!workspace) return null
  const existing = Object.values(workspace.panels)
    .filter((panel) => panel.type === request.panelType && (!request.existingPanelIds || request.existingPanelIds.includes(panel.id)))
    .map((panel) => ({ panelId: panel.id, title: panel.title }))

  const sourcePlacement = request.source !== 'overlay' && request.sourcePanelId
    ? placementForPanel(request.workspaceId, request.sourcePanelId)
    : undefined
  const canvasPanelId = sourcePlacement?.target === 'canvas'
    ? sourcePlacement.canvasPanelId
    : sourcePlacement?.target === 'dock' ? null : getFirstDockedCanvasPanelId(request.workspaceId)
  const dockPlacement = sourcePlacement?.target === 'dock'
    ? sourcePlacement
    : { target: 'dock' as const, zone: 'center' as const }

  if (!canvasPanelId) {
    // Overlay fallback deliberately creates directly, even for a combined request.
    if (request.availability === 'new' || (request.source === 'overlay' && request.availability === 'both')) {
      return { kind: 'new', placement: dockPlacement }
    }
    const dockExisting = existing.filter((panel) =>
      resolvePanelLocation(request.workspaceId, panel.panelId)?.kind === 'dock',
    )
    if (dockExisting.length === 0) return request.availability === 'both'
      ? { kind: 'new', placement: dockPlacement } : null
    const id = await window.electronAPI.showContextMenu([
      ...(request.availability === 'both' ? [{ id: '__new', label: `New ${PANEL_DEFINITIONS[request.panelType].label}` }] : []),
      ...dockExisting.map((panel) => ({ id: panel.panelId, label: panel.title })),
    ])
    if (id === '__new' && request.availability === 'both') return { kind: 'new', placement: dockPlacement }
    return dockExisting.some((panel) => panel.panelId === id) ? { kind: 'existing', panelId: id! } : null
  }

  // Switch hidden tabs/zones before opening the chooser. This also works for
  // canvases in detached windows, whose stores and dock registry are local.
  if (!await revealPanel(request.workspaceId, canvasPanelId)) return null
  const canvas = ensureCanvasOpsForPanel(canvasPanelId).storeApi
  if (request.sourcePanelId && request.source !== 'overlay') {
    const nodeId = canvas.getState().nodeForPanel(request.sourcePanelId)
    if (nodeId) canvas.getState().focusNode(nodeId)
  }
  const canvasExisting = existing.filter((panel) => {
    const location = resolvePanelLocation(request.workspaceId, panel.panelId)
    return location?.kind === 'canvas' && location.canvasPanelId === canvasPanelId
  })

  return new Promise((resolve) => {
    const shown = canvas.getState().beginPanelTarget({
      panelType: request.panelType,
      availability: request.availability,
      existing: canvasExisting,
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
