import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { viewToCanvas, type Point } from '@workspace/canvas/contract'
import type { RelationSide as PanelConnectionSide } from '@workspace/document/contract'
import { Icon, POPOVER_SURFACE } from '../../kernel/interaction'
import { isIconName } from '@kernel/interaction/contract'
import {
  defaultPanelRelationKind,
  panelConnectionPathFromPoints,
  panelPlacementAtConnectionEnd,
  relationPanelOf,
  wouldCreatePanelRelationCycle,
} from '@workspace/relations/contract'
import { addRelation } from './actions'
import { relationRoleOf, relationUiHost, useRelationCanvas } from './host'
import { relationUiPort } from './port'
import { useRelationUi } from './state'

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
}

const CREATE_MENU_WIDTH = 220

interface CreateMenuItem {
  type: string
  label: string
  icon: string
}

/** Types offered for a new linked panel: those people create on a canvas. */
function createMenuItems(): CreateMenuItem[] {
  return relationUiHost().creatable().map((d) => ({ type: d.type, label: d.label, icon: d.icon }))
}

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
  const { canvas: canvasApi, overlayTarget: relationOverlayTarget } = useRelationCanvas()

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
        <NewLinkedPanelMenu
          position={createMenuPosition!}
          items={createMenuItems()}
          onPick={createAndConnect}
          onClose={closeCreateMenu}
          portalTarget={relationOverlayTarget}
        />
      )}
    </>
  )
}

/** The panel type menu at the loose end of a dragged connection. */
function NewLinkedPanelMenu({ position, items, onPick, onClose, portalTarget }: {
  position: { top: number; right: number }
  items: CreateMenuItem[]
  onPick: (type: string) => void
  onClose: () => void
  portalTarget: HTMLElement | null | undefined
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const onResize = () => onClose()
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose])
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="New linked panel"
      className="dock-new-tab-menu pointer-events-auto z-[1000] w-[220px] max-w-[calc(100vw-16px)] text-[13px]"
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') { onClose(); event.stopPropagation(); return }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}
      style={{
        position: portalTarget ? 'absolute' : 'fixed',
        top: position.top,
        right: position.right,
        transform: 'translateY(-50%)',
        animation: 'none',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span
        data-panel-connection-menu-port
        className="pointer-events-none absolute left-[-12px] top-1/2 z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-focus bg-focus-blue"
        style={{ boxShadow: '0 0 0 4px color-mix(in srgb, var(--focus-blue) 18%, transparent)' }}
      />
      <div
        className={`w-full overflow-y-auto ${POPOVER_SURFACE} p-1.5`}
        style={{ maxHeight: portalTarget ? undefined : `calc(100vh - ${position.top + 8}px)` }}
      >
        {items.map(({ type, label, icon }) => (
          <button
            key={type}
            type="button"
            role="menuitem"
            className="flex items-center gap-2.5 w-full rounded-lg px-2.5 py-1.5 text-primary hover:bg-hover focus-visible:bg-hover transition-colors duration-100 motion-reduce:transition-none"
            onClick={() => {
              onClose()
              onPick(type)
            }}
          >
            {isIconName(icon) ? <Icon name={icon} size={16} className="shrink-0 text-secondary" /> : null}
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>,
    portalTarget ?? document.body,
  )
}
