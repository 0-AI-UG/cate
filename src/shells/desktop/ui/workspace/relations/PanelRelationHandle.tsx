import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { viewToCanvas, type Point } from '@workspace/canvas/contract'
import type { RelationSide as PanelConnectionSide } from '@workspace/document/contract'
import { Icon, Modal } from '../../kernel/interaction'
import { isIconName } from '@kernel/interaction/contract'
import { panelConnectionPathFromPoints, panelPlacementAtConnectionEnd } from '@workspace/canvas/contract'
import {
  defaultPanelRelationKind,
  relationPanelOf,
  wouldCreatePanelRelationCycle,
} from '@workspace/relations/contract'
import { addRelation } from './actions'
import { relatable, relationRoleOf, relationUiHost, useRelationCanvas } from './host'
import { relationUiPort } from './port'
import { useRelationUi } from './state'

const SIDES: PanelConnectionSide[] = ['top', 'right', 'bottom', 'left']
/** Screen px from the panel edge to a handle dot's centre: the dot sits just
 *  outside the edge, touching it, so it never overlaps the panel. */
const PORT_OFFSET = 8
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
  /** Where the connection was dropped, in canvas space: the new panel goes here. */
  menuCanvasPoint: Point
}

interface CreateMenuItem {
  type: string
  label: string
  icon: string
}

/** Types offered for a new linked panel: those people create on a canvas
 *  that take part in relations. */
function createMenuItems(): CreateMenuItem[] {
  return relationUiHost().creatable().filter((d) => d.relation).map((d) => ({ type: d.type, label: d.label, icon: d.icon }))
}

function portsForRect(rect: DOMRect): Port[] {
  return [
    { side: 'top', x: rect.left + rect.width / 2, y: rect.top - PORT_OFFSET },
    { side: 'right', x: rect.right + PORT_OFFSET, y: rect.top + rect.height / 2 },
    { side: 'bottom', x: rect.left + rect.width / 2, y: rect.bottom + PORT_OFFSET },
    { side: 'left', x: rect.left - PORT_OFFSET, y: rect.top + rect.height / 2 },
  ]
}

function nearestTarget(workspaceId: string, sourcePanelId: string, x: number, y: number, canvasRoot: HTMLElement | null): SnapTarget | null {
  const panels = relationUiHost().document(workspaceId)?.getSnapshot().panels ?? {}
  let nearest: SnapTarget | null = null
  let nearestDistance = SNAP_DISTANCE
  for (const node of document.querySelectorAll<HTMLElement>('[data-node-id][data-active-panel-id]')) {
    if (canvasRoot && node.closest('[data-canvas-container]') !== canvasRoot) continue
    const panelId = node.dataset.activePanelId
    if (!panelId || panelId === sourcePanelId || !panels[panelId] || !relatable(panels[panelId].type)) continue
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
  const { canvas: canvasApi } = useRelationCanvas()

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
      const target = nearestTarget(workspaceId, sourcePanelId, x, y, current.canvasRoot)
      return { ...current, end: target ? { x: target.x, y: target.y } : { x, y }, target }
    })
  }

  const finish = async (x: number, y: number) => {
    const current = drag
    const target = current
      ? nearestTarget(workspaceId, sourcePanelId, x, y, current.canvasRoot) ?? current.target
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
        menuCanvasPoint: viewToCanvas(
          { x: x - rect.left, y: y - rect.top },
          canvasState.zoomLevel,
          canvasState.viewportOffset,
        ),
      })
      return
    }
    const doc = relationUiHost().document(workspaceId)?.getSnapshot()
    const sourcePanel = doc?.panels[sourcePanelId]
    const targetPanel = doc?.panels[target.panelId]
    if (!doc || !sourcePanel || !targetPanel) return
    if (wouldCreatePanelRelationCycle(Object.values(doc.relations), sourcePanelId, target.panelId)) {
      await relationUiPort().showMenu([{ label: 'This connection would create a cycle', enabled: false }])
      return
    }
    const recommended = defaultPanelRelationKind(relationPanelOf(sourcePanel, relationRoleOf), relationPanelOf(targetPanel, relationRoleOf))
    const relationId = addRelation(workspaceId, sourcePanelId, target.panelId, recommended, current.sourceSide, target.side)
    if (relationId) useRelationUi.getState().openRelationEditor(relationId)
  }

  const closeCreateMenu = useCallback(() => setCreateMenu(null), [])

  const createAndConnect = useCallback((type: string) => {
    if (!createMenu || !canvasApi) return
    const sourcePanel = relationUiHost().document(workspaceId)?.getSnapshot().panels[sourcePanelId]
    if (!sourcePanel) return
    const kind = relationUiHost().definitions().find((d) => d.type === type)
    if (!kind) return
    const size = kind.defaultSize
    const placement = panelPlacementAtConnectionEnd(
      createMenu.menuCanvasPoint,
      size,
      [],
      OPPOSITE_SIDE[createMenu.sourceSide],
    )
    const at = canvasApi.getState().placeTarget(size, { position: placement.origin, exact: true })
    const targetPanelId = relationUiHost().createPanel(workspaceId, type, {
      at,
      ...(sourcePanel.worktreeId ? { worktreeId: sourcePanel.worktreeId } : {}),
    })
    if (!targetPanelId) return
    const targetPanel = relationUiHost().document(workspaceId)?.getSnapshot().panels[targetPanelId]
    if (!targetPanel) return
    const relationId = addRelation(
      workspaceId,
      sourcePanelId,
      targetPanelId,
      defaultPanelRelationKind(relationPanelOf(sourcePanel, relationRoleOf), relationPanelOf(targetPanel, relationRoleOf)),
      createMenu.sourceSide,
      placement.side,
    )
    if (!relationId) return
    const canvas = canvasApi.getState()
    const sourceNodeId = canvas.nodeForPanel(sourcePanelId)
    const targetNodeId = canvas.nodeForPanel(targetPanelId)
    if (sourceNodeId && targetNodeId) {
      canvas.selectNodes([sourceNodeId, targetNodeId])
      canvas.zoomToSelection()
      canvas.focusNode(targetNodeId)
    }
    useRelationUi.getState().openRelationEditor(relationId)
  }, [canvasApi, createMenu, sourcePanelId, workspaceId])

  const previewPath = drag && panelConnectionPathFromPoints(
    drag.start,
    drag.end,
    drag.sourceSide,
    drag.target?.side ?? OPPOSITE_SIDE[drag.sourceSide],
  )
  return (
    <>
      {SIDES.map((side) => {
        // The button is 20px; scale() keeps its centre, so offset by the
        // half-size plus the screen-constant distance in canvas units.
        const out = 'calc(-10px - 8px / var(--canvas-zoom, 1))'
        const position: React.CSSProperties = {
          top: { top: out, left: '50%', marginLeft: -10 },
          right: { right: out, top: '50%', marginTop: -10 },
          bottom: { bottom: out, left: '50%', marginLeft: -10 },
          left: { left: out, top: '50%', marginTop: -10 },
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
            className={`group pointer-events-auto absolute z-20 grid h-5 w-5 place-items-center rounded-full border-0 bg-transparent p-0 outline-none`}
            style={{ ...position, cursor: 'crosshair', scale: 'calc(1 / var(--canvas-zoom, 1))' }}
          >
            <span className="h-2 w-2 rounded-full border-[1.5px] border-surface-1 bg-focus-blue shadow-[0_0_0_1px_var(--focus-blue)] transition-[transform,box-shadow] duration-150 ease-out group-hover:scale-125 group-hover:shadow-[0_0_0_4px_color-mix(in_srgb,var(--focus-blue)_25%,transparent)] group-focus-visible:scale-125 group-focus-visible:shadow-[0_0_0_4px_color-mix(in_srgb,var(--focus-blue)_25%,transparent)] motion-reduce:transition-none" />
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
              strokeWidth="1.75"
              strokeOpacity="0.8"
              strokeLinecap="round"
            />
          </svg>
          {drag.target?.ports.map((port) => (
            <span
              key={port.side}
              data-panel-connection-target={port.side}
              className="pointer-events-none fixed h-1.5 w-1.5 rounded-full transition-[transform,opacity,background-color,box-shadow] duration-150 ease-out motion-reduce:transition-none"
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
      {createMenu && (
        <NewLinkedPanelDialog items={createMenuItems()} onPick={createAndConnect} onClose={closeCreateMenu} />
      )}
    </>
  )
}

/** The panel type picker for the loose end of a dragged connection. */
function NewLinkedPanelDialog({ items, onPick, onClose }: {
  items: CreateMenuItem[]
  onPick: (type: string) => void
  onClose: () => void
}) {
  return (
    <Modal numbered title="Connect a new panel" width={280} onClose={onClose} bodyClassName="min-h-0 flex-1 overflow-auto px-1.5 pb-1.5">
      <div aria-label="New linked panel" className="text-[13px]">
        {items.map(({ type, label, icon }) => (
          <button
            key={type}
            type="button"
            data-menu-item
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left text-primary outline-none transition-colors hover:bg-hover focus-visible:bg-hover"
            onClick={() => {
              onClose()
              onPick(type)
            }}
          >
            {isIconName(icon) ? <Icon name={icon} size={16} className="shrink-0 text-secondary" /> : null}
            <span className="flex-1">{label}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
