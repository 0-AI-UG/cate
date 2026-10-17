// Asking the user where a panel should go: a new one at a spot they pick, or
// an existing one. On a canvas the canvas view shows its targeting overlay
// (it installs the picker); without a canvas the choice is a menu over the
// docked panels of the type. A panel another panel opens always gets its
// place here (`createPanelFrom`).

import { canvasOf, canvasPanelOf, documentOrder, placementOf, isCanvasDock, type PanelId, type PlaceTarget } from '@workspace/document/contract'
import type { Point, Size } from '@workspace/canvas/contract'
import { placeTargetFor, type PanelCreateOptions, type PanelPlacementOptions } from '@panels/framework/contract'
import { clientUi } from '@kernel/interaction'
import { documentStoreFor } from '@client/document'
import { createPanel, newId } from './createPanel'
import { panelDefinition, panelLabel } from './definitions'
import { revealPanel } from './reveal'

export type PanelTarget =
  | { kind: 'new'; placement: PanelPlacementOptions }
  | { kind: 'existing'; panelId: PanelId }

export type PanelTargetAvailability = 'new' | 'existing' | 'both'

export interface PanelTargetRequest {
  workspaceId: string
  panelType: string
  availability: PanelTargetAvailability
  /** Narrows the existing choices after the type filter. */
  existingPanelIds?: readonly PanelId[]
  /** The panel asking; its canvas (if any) is where the choice happens. */
  sourcePanelId?: PanelId
  /** Overlays pick on the first docked canvas, or create in the dock. */
  source?: 'overlay'
}

/** What the canvas view's overlay gets. */
export interface CanvasTargetRequest {
  workspaceId: string
  canvasId: string
  canvasPanelId: PanelId
  panelType: string
  availability: PanelTargetAvailability
  existing: { panelId: PanelId; title: string }[]
  sourcePanelId?: PanelId
}

export type CanvasTargetChoice =
  | { kind: 'new'; point: Point; size: Size }
  | { kind: 'existing'; panelId: PanelId }

export interface CanvasTargetPicker {
  /** Null when the user cancelled or the overlay could not show. */
  pick(request: CanvasTargetRequest): Promise<CanvasTargetChoice | null>
}

let picker: CanvasTargetPicker | null = null

export function installCanvasTargetPicker(next: CanvasTargetPicker | null): void {
  picker = next
}

/** A picked target as the document names it: where a new panel goes, or an
 *  existing panel. */
export type PanelPlace =
  | { kind: 'new'; at: PlaceTarget }
  | { kind: 'existing'; panelId: PanelId }

/** `requestPanelTarget`, with a new panel's placement resolved to the target
 *  `createPanel` would use, for a session op that creates the panel in the
 *  runtime. */
export async function pickPanelPlace(request: PanelTargetRequest): Promise<PanelPlace | null> {
  const target = await requestPanelTarget(request)
  if (!target || target.kind === 'existing') return target
  const doc = documentStoreFor(request.workspaceId)?.getSnapshot()
  const definition = panelDefinition(request.panelType)
  return doc && definition ? { kind: 'new', at: placeTargetFor(doc, definition, target.placement, newId) } : null
}

/** Where a new panel of `panelType` that `sourcePanelId` asked for goes:
 *  on the source's canvas a spot through the canvas's placement flow, in a
 *  dock beside the source; without a source the first docked canvas, else
 *  the main window. Null when the person cancelled. */
export async function pickNewPanelPlace(workspaceId: string, panelType: string, sourcePanelId?: PanelId): Promise<PlaceTarget | null> {
  const place = await pickPanelPlace({ workspaceId, panelType, availability: 'new', ...(sourcePanelId ? { sourcePanelId } : {}) })
  return place?.kind === 'new' ? place.at : null
}

/** Creates a panel of `type` that `sourcePanelId` asked for, at a place from
 *  `pickNewPanelPlace` (inheriting the source's worktree), and brings it on
 *  screen. Every panel one panel opens for another (a clicked link, "open
 *  in ...") is placed here. Null when cancelled or not created. */
export async function createPanelFrom(
  workspaceId: string,
  sourcePanelId: PanelId | undefined,
  type: string,
  options: PanelCreateOptions & Record<string, unknown> = {},
): Promise<PanelId | null> {
  const at = await pickNewPanelPlace(workspaceId, type, sourcePanelId)
  const id = at ? createPanel(workspaceId, type, { ...options, ...(sourcePanelId ? { near: sourcePanelId } : {}), at }) : null
  if (id) void revealPanel(workspaceId, id)
  return id
}

export async function requestPanelTarget(request: PanelTargetRequest): Promise<PanelTarget | null> {
  const doc = documentStoreFor(request.workspaceId)?.getSnapshot()
  if (!doc) return null
  const existing = Object.values(doc.panels)
    .filter((panel) => panel.type === request.panelType && (!request.existingPanelIds || request.existingPanelIds.includes(panel.id)))
    .map((panel) => ({ panelId: panel.id, title: panel.title }))

  const fromSource = request.source !== 'overlay' && request.sourcePanelId
  const sourceCanvas = fromSource ? canvasOf(doc, request.sourcePanelId!) : null
  const sourcePlacement = fromSource ? placementOf(doc, request.sourcePanelId!) : null
  // A source in a dock keeps the choice in the dock; no source means the
  // first canvas docked in a window.
  const firstDockedCanvas = documentOrder(doc).map((id) => doc.panels[id]).find((panel) => {
    const placement = panel?.canvasId ? placementOf(doc, panel.id) : null
    return placement && !isCanvasDock(placement.dock)
  })
  const canvasId = sourceCanvas ?? (sourcePlacement ? null : firstDockedCanvas?.canvasId ?? null)
  const canvasPanel = canvasId ? canvasPanelOf(doc, canvasId) : null
  const dockPlacement: PanelPlacementOptions = sourcePlacement ? { near: request.sourcePanelId } : {}

  if (!canvasId || !canvasPanel || !picker) {
    if (request.availability === 'new' || (request.source === 'overlay' && request.availability === 'both')) {
      return { kind: 'new', placement: dockPlacement }
    }
    const docked = existing.filter((panel) => {
      const placement = placementOf(doc, panel.panelId)
      return placement && !isCanvasDock(placement.dock)
    })
    if (docked.length === 0) return request.availability === 'both' ? { kind: 'new', placement: dockPlacement } : null
    const id = await clientUi().showContextMenu([
      ...(request.availability === 'both' ? [{ id: '__new', label: `New ${panelLabel(request.panelType)}` }] : []),
      ...docked.map((panel) => ({ id: panel.panelId, label: panel.title })),
    ])
    if (id === '__new' && request.availability === 'both') return { kind: 'new', placement: dockPlacement }
    return docked.some((panel) => panel.panelId === id) ? { kind: 'existing', panelId: id! } : null
  }

  if (!await revealPanel(request.workspaceId, request.sourcePanelId && sourceCanvas ? request.sourcePanelId : canvasPanel.id)) return null
  const choice = await picker.pick({
    workspaceId: request.workspaceId,
    canvasId,
    canvasPanelId: canvasPanel.id,
    panelType: request.panelType,
    availability: request.availability,
    existing: existing.filter((panel) => canvasOf(doc, panel.panelId) === canvasId),
    sourcePanelId: fromSource ? request.sourcePanelId : undefined,
  })
  if (!choice) return null
  if (choice.kind === 'existing') return choice
  return {
    kind: 'new',
    placement: { at: { to: 'canvas', canvasId, nodeId: newId(), stackId: newId(), rect: { origin: choice.point, size: choice.size } } },
  }
}
