// A document window drawn in a client window: its dock, the edge strips
// that split the whole dock, and the drag overlay. A client with `windows`
// draws each detached window in its own native window; one without draws
// every window in its one window, switched from a strip of window tabs.

import React, { useEffect, useRef, useSyncExternalStore } from 'react'
import { AppWindow, X } from 'lucide-react'
import { MAIN_WINDOW, type SplitSide, type WindowId } from '@workspace/document/contract'
import { clientHas } from '@client/connections'
import { useDocument } from '@client/document/ui'
import { installRevealHooks } from '@client/host'
import { DockView } from '../dock/DockView'
import { EmptyDockChooser } from '../dock/EmptyDockChooser'
import { DragOverlay } from '../drag/Overlay'
import { EdgeDropIndicator } from '../drag/EdgeIndicator'
import { registerDropZone } from '../drag/registry'
import { useDragStore } from '../drag/store'
import { closeDetachedWindow } from './closeWindow'
import { detachedWindows, windowTitle } from './panelIndex'
import { windowsPort } from './ports'

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

  useEffect(() => {
    const dock = { windowId }
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
  }, [workspaceId, windowId])

  const activeEdge = isDragging && target?.kind === 'dock-zone' && target.workspaceId === workspaceId
    && 'windowId' in target.dock && target.dock.windowId === windowId ? target.edge : undefined

  return (
    <div ref={rootRef} data-window-view={windowId} className="flex flex-col h-full w-full min-h-0 min-w-0 relative">
      <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden">
        <DockView workspaceId={workspaceId} dock={{ windowId }} emptyContent={emptyContent} leadingInset={leadingInset} />
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

// --- One window for all (no `windows` feature) ----------------------------------------

const shown = new Map<string, WindowId>()
const listeners = new Set<() => void>()

export function shownWindow(workspaceId: string): WindowId {
  return shown.get(workspaceId) ?? MAIN_WINDOW
}

export function showWindow(workspaceId: string, windowId: WindowId): void {
  if (shownWindow(workspaceId) === windowId) return
  shown.set(workspaceId, windowId)
  for (const listener of [...listeners]) listener()
}

function subscribeShown(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Reveal brings a window forward: a native window is focused; on a client
 *  without `windows` the switcher shows it. Returns the uninstall. */
export function installWindowReveal(): () => void {
  return installRevealHooks({
    showWindow(workspaceId, windowId) {
      const port = windowsPort()
      if (clientHas('windows') && port) {
        if (windowId !== MAIN_WINDOW) port.focus?.({ workspaceId, windowId })
        return
      }
      showWindow(workspaceId, windowId)
    },
  })
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** The main window of a client: the main document window, and on a client
 *  without `windows` a switchable strip of the detached ones too. Empty, it
 *  offers the panel types to open (`emptyContent` replaces that). */
export function MainWindowView({ workspaceId, emptyContent: emptyProp, leadingInset }: {
  workspaceId: string
  emptyContent?: React.ReactNode
  /** Space the top-left tab bar leaves for window chrome (hidden sidebar). */
  leadingInset?: number
}) {
  const emptyContent = emptyProp ?? <EmptyDockChooser workspaceId={workspaceId} />
  const inline = !clientHas('windows')
  const detached = useDocument(workspaceId, (doc) => detachedWindows(doc).map((w) => w.id), sameIds)
  const titles = useDocument(workspaceId, (doc) => detached.map((id) => windowTitle(doc, id)), sameIds)
  const current = useSyncExternalStore(subscribeShown, () => shownWindow(workspaceId))
  const windowId = inline && detached.includes(current) ? current : MAIN_WINDOW
  if (!inline || detached.length === 0) return <WindowView workspaceId={workspaceId} windowId={MAIN_WINDOW} emptyContent={emptyContent} leadingInset={leadingInset} />
  return (
    <div className="flex flex-col h-full w-full min-h-0 min-w-0">
      <div role="tablist" aria-label="Windows" className="flex items-center gap-1 px-2 h-7 shrink-0 border-b border-subtle bg-surface-1 text-[12px]" style={leadingInset ? { paddingLeft: leadingInset } : undefined}>
        {[MAIN_WINDOW, ...detached].map((id, i) => (
          <button
            key={id}
            role="tab"
            aria-selected={id === windowId}
            className={`flex items-center gap-1 h-5 px-2 rounded-md ${id === windowId ? 'bg-surface-2 text-primary' : 'text-muted hover:text-secondary hover:bg-hover'}`}
            onClick={() => showWindow(workspaceId, id)}
          >
            {id !== MAIN_WINDOW && <AppWindow size={11} />}
            <span className="truncate max-w-[140px]">{id === MAIN_WINDOW ? 'Main' : titles[i - 1]}</span>
            {id !== MAIN_WINDOW && (
              <span
                role="button"
                aria-label="Close window"
                className="p-0.5 rounded hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeDetachedWindow(workspaceId, id)
                }}
              >
                <X size={10} />
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 min-w-0">
        <WindowView workspaceId={workspaceId} windowId={windowId} emptyContent={windowId === MAIN_WINDOW ? emptyContent : undefined} />
      </div>
    </div>
  )
}
