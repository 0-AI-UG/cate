import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  defaultPanelRelationKind,
  wouldCreatePanelRelationCycle,
  type PanelConnectionSide,
} from '../../shared/panelRelations'
import { PANEL_DEFINITIONS } from '../../shared/panels'
import type { PanelType, Point } from '../../shared/types'
import { DockTabContextMenu, SPLIT_MENU_ITEMS } from '../docking/DockTabContextMenu'
import { viewToCanvas } from '../lib/canvas/coordinates'
import { createInteractivePanel } from '../lib/panels/createInteractivePanel'
import { useAppStore } from '../stores/appStore'
import { useOptionalCanvasStoreApi } from '../stores/CanvasStoreContext'
import { panelConnectionPathFromPoints, panelPlacementAtConnectionEnd } from './panelConnectionGeometry'
import { useUIStore } from '../stores/uiStore'
import { useCanvasRelationOverlayTarget } from './CanvasTopOverlayContext'

const SIDES: PanelConnectionSide[] = ['top', 'right', 'bottom', 'left']
const PORT_OFFSET = 12
const SNAP_DISTANCE = 72

interface Port {
  side: PanelConnectionSide
  x: number
  y: number
}

interface SnapTarget extends Port {
  panelId: string
  ports: Port[]
}

interface DragState {
  sourceSide: PanelConnectionSide
  start: { x: number; y: number }
  end: { x: number; y: number }
  target: SnapTarget | null
  canvasRoot: HTMLElement | null
}

interface CreateMenuState {
  sourceSide: PanelConnectionSide
  startCanvasPoint: Point
  screenPoint: Point
  menuCanvasPoint: Point
  canvasPanelId?: string
}

const CREATE_MENU_WIDTH = 220
const CREATE_MENU_ITEMS = SPLIT_MENU_ITEMS.filter(({ type }) => PANEL_DEFINITIONS[type].canLiveOnCanvas)

function portsForRect(rect: DOMRect): Port[] {
  return [
    { side: 'top', x: rect.left + rect.width / 2, y: rect.top - PORT_OFFSET },
    { side: 'right', x: rect.right + PORT_OFFSET, y: rect.top + rect.height / 2 },
    { side: 'bottom', x: rect.left + rect.width / 2, y: rect.bottom + PORT_OFFSET },
    { side: 'left', x: rect.left - PORT_OFFSET, y: rect.top + rect.height / 2 },
  ]
}

function nearestTarget(sourcePanelId: string, x: number, y: number, canvasRoot: HTMLElement | null): SnapTarget | null {
  let nearest: SnapTarget | null = null
  let nearestDistance = SNAP_DISTANCE
  for (const node of document.querySelectorAll<HTMLElement>('[data-node-id][data-active-panel-id]')) {
    if (canvasRoot && node.closest('[data-canvas-container]') !== canvasRoot) continue
    const panelId = node.dataset.activePanelId
    if (!panelId || panelId === sourcePanelId) continue
    const ports = portsForRect(node.getBoundingClientRect())
    for (const port of ports) {
      const distance = Math.hypot(x - port.x, y - port.y)
      if (distance >= nearestDistance) continue
      nearestDistance = distance
      nearest = { ...port, panelId, ports }
    }
  }
  return nearest
}

const OPPOSITE_SIDE: Record<PanelConnectionSide, PanelConnectionSide> = {
  top: 'bottom', right: 'left', bottom: 'top', left: 'right',
}

export function PanelRelationHandle({ workspaceId, sourcePanelId }: {
  workspaceId: string
  sourcePanelId: string
}) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null)
  const canvasApi = useOptionalCanvasStoreApi()
  const relationOverlayTarget = useCanvasRelationOverlayTarget()

  const begin = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const sourceSide = event.currentTarget.dataset.panelConnectionHandle as PanelConnectionSide
    const rect = event.currentTarget.getBoundingClientRect()
    const start = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    const canvasRoot = event.currentTarget.closest<HTMLElement>('[data-canvas-container]')
    setCreateMenu(null)
    setDrag({ sourceSide, start, end: start, target: null, canvasRoot })
  }

  const update = (x: number, y: number) => {
    setDrag((current) => {
      if (!current) return null
      const target = nearestTarget(sourcePanelId, x, y, current.canvasRoot)
      return { ...current, end: target ? { x: target.x, y: target.y } : { x, y }, target }
    })
  }

  const finish = async (x: number, y: number) => {
    const current = drag
    const target = current
      ? nearestTarget(sourcePanelId, x, y, current.canvasRoot) ?? current.target
      : null
    setDrag(null)
    if (!current) return
    if (!target) {
      const canvasRoot = current.canvasRoot
      const rect = canvasRoot?.getBoundingClientRect()
      const canvasState = canvasApi?.getState()
      if (!canvasRoot || !rect || !canvasState) return
      setCreateMenu({
        sourceSide: current.sourceSide,
        startCanvasPoint: viewToCanvas(
          { x: current.start.x - rect.left, y: current.start.y - rect.top },
          canvasState.zoomLevel,
          canvasState.viewportOffset,
        ),
        screenPoint: { x, y },
        menuCanvasPoint: viewToCanvas(
          { x: x - rect.left, y: y - rect.top },
          canvasState.zoomLevel,
          canvasState.viewportOffset,
        ),
        canvasPanelId: canvasRoot.dataset.canvasPanelId,
      })
      return
    }
    const workspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
    const sourcePanel = workspace?.panels[sourcePanelId]
    const targetPanel = workspace?.panels[target.panelId]
    if (!workspace || !sourcePanel || !targetPanel) return
    if (wouldCreatePanelRelationCycle(workspace.panelRelations ?? [], sourcePanelId, target.panelId)) {
      await window.electronAPI.showContextMenu([{ label: 'This connection would create a cycle', enabled: false }])
      return
    }
    const recommended = defaultPanelRelationKind(sourcePanel, targetPanel)
    const relationId = useAppStore.getState().addPanelRelation(
      workspaceId,
      sourcePanelId,
      target.panelId,
      recommended,
      current.sourceSide,
      target.side,
    )
    if (relationId) useUIStore.getState().openPanelRelationEditor(relationId)
  }

  const closeCreateMenu = useCallback(() => setCreateMenu(null), [])

  const createAndConnect = useCallback((type: PanelType) => {
    if (!createMenu) return
    const workspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
    const sourcePanel = workspace?.panels[sourcePanelId]
    if (!workspace || !sourcePanel) return
    const canvas = canvasApi?.getState()
    const placement = panelPlacementAtConnectionEnd(
      createMenu.menuCanvasPoint,
      PANEL_DEFINITIONS[type].defaultSize,
      [],
      OPPOSITE_SIDE[createMenu.sourceSide],
    )
    const targetPanelId = createInteractivePanel(type, {
      workspaceId,
      canvasPoint: placement.origin,
      placement: {
        target: 'canvas',
        canvasPanelId: createMenu.canvasPanelId,
        focus: false,
      },
    }, sourcePanel)
    if (!targetPanelId) return
    const targetPanel = useAppStore.getState().workspaces
      .find((item) => item.id === workspaceId)?.panels[targetPanelId]
    if (!targetPanel) return
    const targetNodeId = canvas?.nodeForPanel(targetPanelId)
    if (canvas && targetNodeId) canvas.moveNode(targetNodeId, placement.origin)
    const relationId = useAppStore.getState().addPanelRelation(
      workspaceId,
      sourcePanelId,
      targetPanelId,
      defaultPanelRelationKind(sourcePanel, targetPanel),
      createMenu.sourceSide,
      placement.side,
    )
    if (relationId) {
      const sourceNodeId = canvas?.nodeForPanel(sourcePanelId)
      if (canvas && sourceNodeId && targetNodeId) {
        canvas.selectNodes([sourceNodeId, targetNodeId])
        canvas.zoomToSelection()
        canvas.focusNode(targetNodeId)
      }
      useUIStore.getState().openPanelRelationEditor(relationId)
    }
  }, [canvasApi, createMenu, sourcePanelId, workspaceId])

  const createMenuPosition = createMenu
    ? relationOverlayTarget
      ? {
          top: createMenu.menuCanvasPoint.y,
          right: relationOverlayTarget.offsetWidth - createMenu.menuCanvasPoint.x - CREATE_MENU_WIDTH - PORT_OFFSET,
        }
      : {
          top: createMenu.screenPoint.y,
          right: Math.max(8, window.innerWidth - Math.max(8, createMenu.screenPoint.x) - CREATE_MENU_WIDTH),
        }
    : null

  const previewPath = drag && panelConnectionPathFromPoints(
    drag.start,
    drag.end,
    drag.sourceSide,
    drag.target?.side ?? OPPOSITE_SIDE[drag.sourceSide],
  )
  const createPreviewPath = createMenu && panelConnectionPathFromPoints(
    createMenu.startCanvasPoint,
    createMenu.menuCanvasPoint,
    createMenu.sourceSide,
    OPPOSITE_SIDE[createMenu.sourceSide],
  )

  return (
    <>
      {SIDES.map((side) => {
        const position = {
          top: 'left-1/2 -top-[22px] -translate-x-1/2',
          right: 'top-1/2 -right-[22px] -translate-y-1/2',
          bottom: 'left-1/2 -bottom-[22px] -translate-x-1/2',
          left: 'top-1/2 -left-[22px] -translate-y-1/2',
        }[side]
        return (
          <button
            key={side}
            type="button"
            data-panel-connection-handle={side}
            aria-label={`Connect panel from ${side}`}
            title="Drag to connect"
            onPointerDown={begin}
            onClick={(event) => { event.preventDefault(); event.stopPropagation() }}
            className={`group pointer-events-auto absolute ${position} z-20 grid h-5 w-5 place-items-center rounded-full border-0 bg-transparent p-0 outline-none`}
            style={{ cursor: 'crosshair' }}
          >
            <span className="h-2 w-2 rounded-full border border-focus bg-focus-blue shadow-sm transition-[transform,box-shadow,filter] duration-150 ease-out group-hover:scale-125 group-hover:brightness-110 group-hover:shadow-md group-focus-visible:scale-125 group-focus-visible:ring-2 group-focus-visible:ring-focus-blue/30 motion-reduce:transition-none" />
          </button>
        )
      })}
      {drag && createPortal(
        <div
          className="fixed inset-0 z-[10000] cursor-crosshair"
          onPointerMove={(event) => update(event.clientX, event.clientY)}
          onPointerUp={(event) => { void finish(event.clientX, event.clientY) }}
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            <path
              d={previewPath ?? ''}
              fill="none"
              stroke="var(--focus-blue)"
              strokeWidth="2.25"
              strokeLinecap="round"
              className="cate-panel-connection-active"
            />
          </svg>
          {drag.target?.ports.map((port) => (
            <span
              key={port.side}
              data-panel-connection-target={port.side}
              className="pointer-events-none fixed h-2 w-2 rounded-full border border-focus transition-[transform,opacity,background-color,box-shadow] duration-150 ease-out motion-reduce:transition-none"
              style={{
                left: port.x,
                top: port.y,
                opacity: port.side === drag.target?.side ? 1 : 0.55,
                backgroundColor: 'var(--focus-blue)',
                boxShadow: port.side === drag.target?.side
                  ? '0 0 0 4px color-mix(in srgb, var(--focus-blue) 18%, transparent)'
                  : 'none',
                transform: `translate(-50%, -50%) scale(${port.side === drag.target?.side ? 1.25 : 1})`,
              }}
            />
          ))}
        </div>,
        document.body,
      )}
      {createMenu && relationOverlayTarget && createPortal(
        <svg
          aria-hidden
          data-panel-connection-create-preview
          width="1"
          height="1"
          style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none', zIndex: 999 }}
        >
          <path
            d={createPreviewPath ?? ''}
            fill="none"
            stroke="var(--focus-blue)"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeDasharray="6 5"
            className="cate-panel-connection-active"
          />
        </svg>,
        relationOverlayTarget,
      )}
      {createMenu && relationOverlayTarget !== null && (
        <DockTabContextMenu
          open
          position={createMenuPosition}
          items={CREATE_MENU_ITEMS}
          onPick={createAndConnect}
          onClose={closeCreateMenu}
          portalTarget={relationOverlayTarget}
          ariaLabel="New linked panel"
          showConnectionPort
        />
      )}
    </>
  )
}
