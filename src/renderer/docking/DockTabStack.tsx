// =============================================================================
// DockTabStack — tab bar + renders the active panel's component.
// Supports dock-aware drag initiation from tabs and drop zone registration.
// =============================================================================

import React, { useCallback, useEffect, useRef } from 'react'
import { useDockStoreContext, useDockStoreApi } from '../stores/DockStoreContext'
import { useDockDragStore, registerDropZone, hitTestDropTarget } from '../hooks/useDockDrag'
import { executeDrop } from './dropExecution'
import { createTransferSnapshot } from '../lib/panelTransfer'
import { terminalRegistry } from '../lib/terminalRegistry'
import type { DockTabStack as DockTabStackType, PanelState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { X } from 'lucide-react'
import DropZoneOverlay from './DropZoneOverlay'
import { canvasDropZoneHovered } from './CanvasDropZone'

interface DockTabStackProps {
  stack: DockTabStackType
  zone: 'left' | 'right' | 'bottom' | 'center'
  renderPanel: (panelId: string) => React.ReactNode
  getPanelTitle: (panelId: string) => string
  onClosePanel?: (panelId: string) => void
  getPanel?: (panelId: string) => PanelState | undefined
  workspaceId?: string
  onPanelRemoved?: (panelId: string) => void
}

export default function DockTabStack({ stack, zone: zoneProp, renderPanel, getPanelTitle, onClosePanel, getPanel: getPanelProp, workspaceId: workspaceIdProp, onPanelRemoved }: DockTabStackProps) {
  const setActiveTab = useDockStoreContext((s) => s.setActiveTab)
  const dockStoreApi = useDockStoreApi()
  const stackRef = useRef<HTMLDivElement>(null)
  const dragAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => { dragAbortRef.current?.abort() }
  }, [])

  const isDragging = useDockDragStore((s) => s.isDragging)
  const activeDropTarget = useDockDragStore((s) => s.activeDropTarget)
  const dragSource = useDockDragStore((s) => s.dragSource)

  // Register this tab stack as a drop zone
  useEffect(() => {
    return registerDropZone({
      id: `stack-${stack.id}`,
      zone: zoneProp,
      stackId: stack.id,
      getRect: () => stackRef.current?.getBoundingClientRect() ?? null,
    })
  }, [stack.id, zoneProp])

  const handleTabClick = useCallback(
    (index: number) => {
      setActiveTab(stack.id, index)
    },
    [stack.id, setActiveTab],
  )

  // Drag initiation from tab
  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, panelId: string) => {
      if (e.button !== 0) return
      const startX = e.clientX
      const startY = e.clientY
      let dragStarted = false
      let cwDragSnapshot: import('../../shared/types').PanelTransferSnapshot | null = null

      let panel: PanelState | undefined
      if (getPanelProp) {
        panel = getPanelProp(panelId)
      } else {
        const wsId = useAppStore.getState().selectedWorkspaceId
        const ws = useAppStore.getState().workspaces.find(w => w.id === wsId)
        panel = ws?.panels[panelId]
      }
      if (!panel) return

      const sourceZone = zoneProp

      const handleMove = (ev: MouseEvent) => {
        if (!dragStarted) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
          dragStarted = true
          document.body.classList.add('canvas-interacting')
          useDockDragStore.getState().startDrag(
            panelId,
            panel.type,
            panel.title,
            { type: 'dock', zone: sourceZone, stackId: stack.id },
          )
        }

        const dockDrag = useDockDragStore.getState()
        dockDrag.updateCursor({ x: ev.clientX, y: ev.clientY })

        // Check if cursor is outside the window BEFORE hit testing — otherwise
        // the cursor can pass through a sibling panel's drop zone on the way out,
        // causing a local drop instead of a detach.
        const outsideWindow = ev.clientX <= 0 || ev.clientY <= 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight
        if (!outsideWindow) {
          // Skip hit-testing when the CanvasDropZone overlay is hovered —
          // it handles the drop itself via onPointerUp.
          if (!canvasDropZoneHovered) {
            const target = hitTestDropTarget(ev.clientX, ev.clientY)
            dockDrag.setDropTarget(target)
          }
        } else {
          dockDrag.setDropTarget(null)
        }
        if (outsideWindow && !cwDragSnapshot) {
          const snapshot = createTransferSnapshot(
            panel,
            { type: 'dock', zone: sourceZone, stackId: stack.id },
            { origin: { x: ev.screenX, y: ev.screenY }, size: { width: 700, height: 500 } },
          )
          cwDragSnapshot = snapshot
          window.electronAPI.crossWindowDragStart(snapshot, { x: ev.screenX, y: ev.screenY })
        } else if (!outsideWindow && cwDragSnapshot) {
          // Cursor re-entered this window — cancel cross-window drag
          cwDragSnapshot = null
          window.electronAPI.crossWindowDragCancel()
        }
      }

      const cleanup = () => {
        dragAbortRef.current?.abort()
        dragAbortRef.current = null
        document.body.classList.remove('canvas-interacting')
      }

      const handleUp = (ev: MouseEvent) => {
        cleanup()

        if (dragStarted) {
          const dockDrag = useDockDragStore.getState()
          const target = dockDrag.activeDropTarget

          if (target && dockDrag.draggedPanelId) {
            // Drop within this window — cancel any cross-window drag
            if (cwDragSnapshot) {
              cwDragSnapshot = null
              window.electronAPI.crossWindowDragCancel()
            }
            executeDrop(
              dockDrag.draggedPanelId,
              { type: 'dock', zone: sourceZone, stackId: stack.id },
              target,
              undefined,
              dockStoreApi,
            )
          } else if (
            dockDrag.draggedPanelId &&
            (ev.clientX <= 0 || ev.clientY <= 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight)
          ) {
            // Cursor outside window — try cross-window drop, fall back to detach
            const draggedId = dockDrag.draggedPanelId
            const cwSnapshot = cwDragSnapshot
            cwDragSnapshot = null

            if (cwSnapshot) {
              window.electronAPI.crossWindowDragResolve().then(({ claimed }) => {
                if (claimed) {
                  // Target window accepted — remove panel from this dock
                  dockStoreApi.getState().undockPanel(draggedId)
                  if (panel?.type === 'terminal') terminalRegistry.release(draggedId)
                  onPanelRemoved?.(draggedId)
                } else {
                  // No target — fall back to creating a new dock window
                  dockStoreApi.getState().undockPanel(draggedId)
                  if (panel?.type === 'terminal') terminalRegistry.release(draggedId)
                  onPanelRemoved?.(draggedId)
                  const wsId = workspaceIdProp ?? useAppStore.getState().selectedWorkspaceId
                  window.electronAPI.dragDetach(cwSnapshot, wsId)
                }
              })
            } else if (panel) {
              // No cross-window drag was active — direct detach
              const snapshot = createTransferSnapshot(
                panel,
                { type: 'dock', zone: sourceZone, stackId: stack.id },
                { origin: { x: ev.screenX, y: ev.screenY }, size: { width: 700, height: 500 } },
              )
              dockStoreApi.getState().undockPanel(draggedId)
              if (panel.type === 'terminal') terminalRegistry.release(draggedId)
              onPanelRemoved?.(draggedId)
              const wsId = workspaceIdProp ?? useAppStore.getState().selectedWorkspaceId
              window.electronAPI.dragDetach(snapshot, wsId)
            }
          }
          useDockDragStore.getState().endDrag()
        }
      }

      // Cancel drag on window blur — OS won't deliver mouseup
      const handleBlur = () => {
        if (dragStarted) {
          cleanup()
          if (cwDragSnapshot) {
            cwDragSnapshot = null
            window.electronAPI.crossWindowDragCancel()
          }
          useDockDragStore.getState().endDrag()
        }
      }

      dragAbortRef.current?.abort()
      const controller = new AbortController()
      dragAbortRef.current = controller
      const { signal } = controller
      window.addEventListener('mousemove', handleMove, { signal })
      window.addEventListener('mouseup', handleUp, { signal })
      window.addEventListener('blur', handleBlur, { signal })
    },
    [stack.id, zoneProp, getPanelProp, workspaceIdProp, onPanelRemoved, dockStoreApi],
  )

  const activePanelId = stack.panelIds[stack.activeIndex]

  // Check if this stack is the active drop target, but suppress indicators
  // when dragging a panel over the stack it originated from (self-drop is a no-op)
  const isSelfDrop =
    dragSource?.type === 'dock' && dragSource.stackId === stack.id
  const isOver =
    isDragging &&
    !isSelfDrop &&
    activeDropTarget != null &&
    (activeDropTarget.type === 'tab' || activeDropTarget.type === 'split') &&
    'stackId' in activeDropTarget &&
    activeDropTarget.stackId === stack.id

  return (
    <div ref={stackRef} className="flex flex-col h-full min-h-0 relative">
      {/* Tab bar — always rendered, same markup for single or multiple tabs */}
      <div
        className="flex items-center bg-[#1E1E24] border-b border-white/[0.06] min-h-[30px] overflow-x-auto"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {stack.panelIds.map((panelId, i) => (
          <button
            key={panelId}
            className={`
              flex items-center gap-1 px-3 py-1 text-xs whitespace-nowrap
              border-r border-white/[0.06] transition-colors cursor-grab
              ${i === stack.activeIndex
                ? 'bg-[#28282E] text-white/90'
                : 'text-white/50 hover:text-white/70 hover:bg-white/[0.03]'
              }
            `}
            onClick={() => handleTabClick(i)}
            onMouseDown={(e) => handleTabMouseDown(e, panelId)}
          >
            <span className="truncate max-w-[120px]">{getPanelTitle(panelId)}</span>
            {onClosePanel && (
              <span
                className="ml-1 p-0.5 rounded-sm hover:bg-white/10"
                onClick={(e) => {
                  e.stopPropagation()
                  onClosePanel(panelId)
                }}
              >
                <X size={10} />
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Active panel content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activePanelId ? renderPanel(activePanelId) : (
          <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
            No panel
          </div>
        )}
      </div>

      {/* Drop zone overlay */}
      <DropZoneOverlay activeTarget={activeDropTarget} isOver={isOver} />
    </div>
  )
}

