// =============================================================================
// DragGhost — floating preview that follows the cursor during dock-aware drags.
// Shows the panel title and type icon as a small pill.
// =============================================================================

import React, { useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useDockDragStore } from '../hooks/useDockDrag'
import { Terminal, Globe, FileText, GitBranch, FolderOpen, SquaresFour, Square } from '@phosphor-icons/react'
import type { PanelType } from '../../shared/types'

function PanelIcon({ type }: { type: PanelType }) {
  const props = { size: 12, className: 'text-primary' }
  switch (type) {
    case 'terminal': return <Terminal {...props} />
    case 'browser': return <Globe {...props} />
    case 'editor': return <FileText {...props} />
    case 'git': return <GitBranch {...props} />
    case 'fileExplorer': return <FolderOpen {...props} />
    case 'projectList': return <SquaresFour {...props} />
    case 'canvas': return <Square {...props} />
  }
}

export default function DragGhost() {
  const isDragging = useDockDragStore((s) => s.isDragging)
  const panelType = useDockDragStore((s) => s.draggedPanelType)
  const panelTitle = useDockDragStore((s) => s.draggedPanelTitle)
  const ref = useRef<HTMLDivElement>(null)

  // Position the ghost via direct DOM manipulation — bypasses React's batching
  // so the ghost tracks the cursor exactly on every mousemove.
  useEffect(() => {
    if (!isDragging) return
    // Apply initial position if cursor is already known
    const initial = useDockDragStore.getState().cursorPosition
    if (ref.current && initial) {
      ref.current.style.left = `${initial.x}px`
      ref.current.style.top = `${initial.y}px`
    }
    return useDockDragStore.subscribe((state) => {
      if (ref.current && state.cursorPosition) {
        ref.current.style.left = `${state.cursorPosition.x}px`
        ref.current.style.top = `${state.cursorPosition.y}px`
      }
    })
  }, [isDragging])

  if (!isDragging || !panelType) return null

  // Portal to document.body so position:fixed resolves against the viewport,
  // not any intermediate containing block from ancestor transforms/overflow.
  return createPortal(
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: -9999,
        top: -9999,
        zIndex: 99999,
        pointerEvents: 'none',
      }}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-5 border border-focus/40 rounded-md shadow-lg">
        <PanelIcon type={panelType} />
        <span className="text-xs text-primary whitespace-nowrap max-w-[150px] truncate">
          {panelTitle}
        </span>
      </div>
    </div>,
    document.body,
  )
}
