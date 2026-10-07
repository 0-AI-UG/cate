// A document window drawn in a desktop window: its dock, the edge strips
// that split the whole dock, and the drag overlay. Each detached window has
// its own native window.

import React, { useEffect, useRef } from 'react'
import { MAIN_WINDOW, type SplitSide, type WindowId } from '@workspace/document/contract'
import { installRevealHooks } from '@client/host'
import { useClientState, useDocument } from '../../document'
import { DockView } from '../dock/DockView'
import { EmptyDockChooser } from '../dock/EmptyDockChooser'
import { DragOverlay } from '../drag/Overlay'
import { EdgeDropIndicator } from '../drag/EdgeIndicator'
import { registerDropZone } from '../drag/registry'
import { useDragStore } from '../drag/store'
import { windowsPort } from './ports'
import { WindowHeader } from './WindowHeader'

/** Width of the edge strips a drag can split the whole dock at. */
const EDGE_ZONE_SIZE = 60
const EDGES: SplitSide[] = ['left', 'bottom']

export interface WindowViewProps {
  workspaceId: string
  windowId: WindowId
  /** Shown while the window's dock is empty. */
  emptyContent?: React.ReactNode
  /** Draw the drag ghost and indicators here (once per client window). */
  overlay?: boolean
  /** Space the top-left tab bar leaves for window chrome at its left. */
  leadingInset?: number
}

export function WindowView({ workspaceId, windowId, emptyContent, overlay = true, leadingInset }: WindowViewProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const isDragging = useDragStore((s) => s.isDragging)
  const target = useDragStore((s) => s.target)
  // The layout this client shows (a window with one layout shows no switcher).
  const window = useDocument(workspaceId, (doc) => doc.windows[windowId])
  const chosen = useClientState(workspaceId, (s) => s.activeLayouts[windowId])
  const layoutId = window?.layouts.find((l) => l.id === chosen)?.id ?? window?.layouts[0]?.id ?? ''

  useEffect(() => {
    const dock = { windowId, layoutId }
    const stops = EDGES.map((edge) => registerDropZone({
      id: `edge-${workspaceId}-${windowId}-${edge}`,
      workspaceId,
      dock,
      edge,
      getRect: () => {
        const root = rootRef.current
        if (!root) return null
        const b = root.getBoundingClientRect()
        return edge === 'left'
          ? new DOMRect(b.left, b.top, EDGE_ZONE_SIZE, b.height)
          : new DOMRect(b.left, b.bottom - EDGE_ZONE_SIZE, b.width, EDGE_ZONE_SIZE)
      },
    }))
    return () => { for (const stop of stops) stop() }
  }, [workspaceId, windowId, layoutId])

  const activeEdge = isDragging && target?.kind === 'dock-zone' && target.workspaceId === workspaceId
    && 'windowId' in target.dock && target.dock.windowId === windowId && target.dock.layoutId === layoutId ? target.edge : undefined

  return (
    <div ref={rootRef} data-window-view={windowId} className="flex flex-col h-full w-full min-h-0 min-w-0 relative">
      {/* The main window always has its layout header; a detached window gets one once it has several layouts. */}
      {window && (windowId === MAIN_WINDOW || window.layouts.length > 1) && (
        <WindowHeader workspaceId={workspaceId} window={window} activeLayoutId={layoutId} leadingInset={leadingInset} />
      )}
      <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden">
        <DockView workspaceId={workspaceId} dock={{ windowId, layoutId }} emptyContent={emptyContent} compact />
      </div>
      {activeEdge && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 9998, pointerEvents: 'none' }}>
          <EdgeDropIndicator edge={activeEdge} />
        </div>
      )}
      {overlay && <DragOverlay />}
    </div>
  )
}

/** Reveal brings a detached window forward. Returns the uninstall. */
export function installWindowReveal(): () => void {
  return installRevealHooks({
    showWindow(workspaceId, windowId) {
      if (windowId !== MAIN_WINDOW) windowsPort()?.focus?.({ workspaceId, windowId })
    },
  })
}

/** The main window of a workspace. Empty, it offers the panel types to open
 *  (`emptyContent` replaces that). */
export function MainWindowView({ workspaceId, emptyContent, leadingInset }: {
  workspaceId: string
  emptyContent?: React.ReactNode
  /** Space the top-left tab bar leaves for window chrome (hidden sidebar). */
  leadingInset?: number
}) {
  return (
    <WindowView
      workspaceId={workspaceId}
      windowId={MAIN_WINDOW}
      emptyContent={emptyContent ?? <EmptyDockChooser workspaceId={workspaceId} />}
      leadingInset={leadingInset}
    />
  )
}
