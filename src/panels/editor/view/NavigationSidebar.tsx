// The editor's files sidebar: the explorer or the content search of its
// checkout. Both are client concerns: the tree model and the search store
// live with the view, over the files client, not in the session.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileExplorer, FileTreeModel, SearchView, panelSearchStore, releasePanelSearchStore, type FileTreeSavedState } from '@workspace/files/ui'

const MIN_WIDTH = 180
const MAX_WIDTH = 480
const COLLAPSE_OVERSHOOT = 64

/** Expanded folders per panel, kept across remounts of the view. */
const savedTrees = new Map<string, FileTreeSavedState>()

function SidebarFrame({ visible, fill = false, onHide, children }: { visible: boolean; fill?: boolean; onHide: () => void; children: ReactNode }) {
  const sidebarRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(260)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ startX: number; startWidth: number; scale: number; max: number } | null>(null)
  return (
    <aside
      ref={sidebarRef}
      aria-hidden={!visible}
      className={`relative shrink-0 h-full ${dragging ? '' : 'transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none'}`}
      style={{ width: visible ? (fill ? '100%' : width) : 0, maxWidth: fill ? 'none' : '70%', opacity: visible ? 1 : 0 }}
    >
      <div className={`h-full overflow-hidden ${fill ? '' : 'border-l border-subtle'}`} style={{ visibility: visible ? 'visible' : 'hidden', transition: visible ? undefined : 'visibility 0s 200ms' }}>
        <div className="h-full" style={{ width: fill ? '100%' : width }}>{children}</div>
      </div>
      {visible && !fill && (
        <div
          role="separator"
          aria-label="Resize file explorer"
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          className="absolute -left-1 top-0 bottom-0 w-2 z-40 cursor-col-resize touch-none select-none group hover:bg-focus/20"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            event.stopPropagation()
            setWidth((current) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, current + (event.key === 'ArrowLeft' ? 16 : -16))))
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !sidebarRef.current) return
            event.preventDefault()
            event.stopPropagation()
            const parent = sidebarRef.current.parentElement!
            const scale = parent.getBoundingClientRect().width / parent.clientWidth || 1
            drag.current = { startX: event.clientX, startWidth: sidebarRef.current.getBoundingClientRect().width / scale, scale, max: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parent.clientWidth * 0.7)) }
            event.currentTarget.setPointerCapture(event.pointerId)
            setDragging(true)
          }}
          onPointerMove={(event) => {
            const current = drag.current
            if (!current) return
            event.stopPropagation()
            const requested = current.startWidth + (current.startX - event.clientX) / current.scale
            if (requested < MIN_WIDTH - COLLAPSE_OVERSHOOT) {
              drag.current = null
              setDragging(false)
              event.currentTarget.releasePointerCapture(event.pointerId)
              onHide()
              return
            }
            setWidth(Math.max(MIN_WIDTH, Math.min(current.max, requested)))
          }}
          onPointerUp={(event) => {
            if (!drag.current) return
            event.stopPropagation()
            drag.current = null
            setDragging(false)
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
        >
          <div className="absolute left-[3px] top-0 bottom-0 w-px group-hover:bg-focus" />
        </div>
      )}
    </aside>
  )
}

export function NavigationSidebar({ workspaceId, panelId, root, view, visible, fill, focusToken, focusInput, onHide, onOpenFiles }: {
  workspaceId: string
  panelId: string
  root: string
  view: 'explorer' | 'search'
  visible: boolean
  fill: boolean
  focusToken: number
  focusInput: boolean
  onHide: () => void
  onOpenFiles: (paths: string[], mode?: 'dock' | 'canvas', reveal?: { line: number; column?: number }) => void
}) {
  // The effect that disposes the model also creates it: a model made during
  // render would stay disposed after a remount (StrictMode, Offscreen) and
  // never load.
  const [owned, setOwned] = useState<FileTreeModel | null>(null)
  useLayoutEffect(() => {
    const next = new FileTreeModel(root, workspaceId, { saved: savedTrees.get(panelId) })
    setOwned(next)
    return () => {
      savedTrees.set(panelId, next.capture())
      next.dispose()
    }
  }, [root, workspaceId, panelId])
  const tree = owned && owned.rootPath === root && owned.workspaceId === workspaceId ? owned : null
  useEffect(() => {
    if (visible) tree?.activate()
  }, [tree, visible])
  const search = useMemo(() => (view === 'search' ? panelSearchStore(panelId, workspaceId, root) : null), [view, panelId, workspaceId, root])
  useEffect(() => () => releasePanelSearchStore(panelId), [panelId])

  return (
    <SidebarFrame visible={visible} fill={fill} onHide={onHide}>
      {search
        ? <SearchView store={search} workspaceId={workspaceId} rootPath={root} focusToken={focusToken} focusInput={focusInput} onOpenMatch={(file, line, column) => onOpenFiles([file], 'dock', { line, column })} />
        : tree && <FileExplorer resource={tree} workspaceId={workspaceId} panelId={panelId} rootPath={root} onOpenFiles={onOpenFiles} compact />}
    </SidebarFrame>
  )
}
