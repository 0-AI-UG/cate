// =============================================================================
// CanvasNodeTitleBar — title bar for canvas node panels.
// Ported from CanvasNodeTitleBar.swift.
// =============================================================================

import React, { useCallback, useState } from 'react'
import { Terminal, Globe, FileText, Bot, GitBranch, Maximize2, Minimize2, Pin, X } from 'lucide-react'
import type { PanelType } from '../../shared/types'
import { panelColor } from '../panels/types'
import { useCanvasStore } from '../stores/canvasStore'
import ContextMenu from '../ui/ContextMenu'

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

interface TitleBarProps {
  nodeId: string
  panelType: PanelType
  title: string
  isFocused: boolean
  isMaximized: boolean
  isPinned: boolean
  onClose: () => void
  onToggleMaximize: () => void
  onTogglePin: () => void
  onDragStart: (e: React.MouseEvent) => void
  onRename?: () => void
  onDuplicate?: () => void
  onSplitHorizontal?: () => void
  onSplitVertical?: () => void
  onAddTab?: () => void
  onDetach?: () => void
}

// -----------------------------------------------------------------------------
// Icon component helper
// -----------------------------------------------------------------------------

function PanelIcon({ type, color }: { type: PanelType; color: string }) {
  const props = { size: 14, color, strokeWidth: 1.5 }
  switch (type) {
    case 'terminal':
      return <Terminal {...props} />
    case 'browser':
      return <Globe {...props} />
    case 'editor':
      return <FileText {...props} />
    case 'aiChat':
      return <Bot {...props} />
    case 'git':
      return <GitBranch {...props} />
  }
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

const CanvasNodeTitleBar: React.FC<TitleBarProps> = ({
  nodeId,
  panelType,
  title,
  isFocused,
  isMaximized,
  isPinned,
  onClose,
  onToggleMaximize,
  onTogglePin,
  onDragStart,
  onRename,
  onDuplicate,
  onSplitHorizontal,
  onSplitVertical,
  onAddTab,
  onDetach,
}) => {
  const iconColor = panelColor(panelType)

  // Local context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Don't start drag if clicking on buttons
      const target = e.target as HTMLElement
      if (target.closest('[data-titlebar-button]')) return

      // Double-click toggles maximize
      if (e.detail === 2) {
        onToggleMaximize()
        return
      }

      onDragStart(e)
    },
    [onDragStart, onToggleMaximize],
  )

  const handleCloseClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onClose()
    },
    [onClose],
  )

  const handleMaximizeClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onToggleMaximize()
    },
    [onToggleMaximize],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      // Stop propagation so the canvas background doesn't also see this event
      e.stopPropagation()
      setContextMenu({ x: e.clientX, y: e.clientY })
    },
    [],
  )

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const contextMenuItems = [
    ...(onRename
      ? [{ label: 'Rename', onClick: onRename }]
      : []),
    ...(onDuplicate
      ? [{ label: 'Duplicate', onClick: onDuplicate }]
      : []),
    ...(onRename || onDuplicate
      ? [{ label: '', separator: true, onClick: () => {} }]
      : []),
    {
      label: 'Move to Front',
      onClick: () => {
        useCanvasStore.getState().moveToFront(nodeId)
      },
    },
    {
      label: 'Move to Back',
      onClick: () => {
        useCanvasStore.getState().moveToBack(nodeId)
      },
    },
    ...(onSplitHorizontal || onSplitVertical || onAddTab
      ? [{ label: '', separator: true, onClick: () => {} }]
      : []),
    ...(onSplitHorizontal
      ? [{ label: 'Split Right', onClick: onSplitHorizontal }]
      : []),
    ...(onSplitVertical
      ? [{ label: 'Split Down', onClick: onSplitVertical }]
      : []),
    ...(onAddTab
      ? [{ label: 'Add Tab', onClick: onAddTab }]
      : []),
    ...(onDetach
      ? [{ label: '', separator: true, onClick: () => {} }]
      : []),
    ...(onDetach
      ? [{ label: 'Detach to Window', onClick: onDetach }]
      : []),
    { label: '', separator: true, onClick: () => {} },
    {
      label: 'Close',
      danger: true,
      onClick: onClose,
    },
  ]

  return (
    <>
      <div
        className="group flex h-7 items-center bg-[#28282E] px-2 select-none"
        onMouseDown={handleMouseDown}
        onContextMenu={handleContextMenu}
      >
        {/* Panel type icon */}
        <div className="mr-1.5 flex-shrink-0">
          <PanelIcon type={panelType} color={iconColor} />
        </div>

        {/* Title */}
        <div className="min-w-0 flex-1 truncate text-xs font-medium text-white/80">
          {title}
        </div>

        {/* Pin button — always visible when pinned, hover-only otherwise */}
        <button
          data-titlebar-button
          className={`ml-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm transition-opacity hover:bg-white/[0.15] ${isPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          onClick={(e) => { e.stopPropagation(); onTogglePin() }}
          title={isPinned ? 'Unpin' : 'Pin'}
        >
          <Pin size={12} className={isPinned ? 'text-blue-400' : 'text-white/80'} />
        </button>

        {/* Maximize/Restore button — visible on hover */}
        <button
          data-titlebar-button
          className="ml-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity hover:bg-white/[0.15] group-hover:opacity-100"
          onClick={handleMaximizeClick}
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? (
            <Minimize2 size={12} className="text-white/80" />
          ) : (
            <Maximize2 size={12} className="text-white/80" />
          )}
        </button>

        {/* Close button — visible on hover */}
        <button
          data-titlebar-button
          className="ml-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity hover:bg-red-500/30 group-hover:opacity-100"
          onClick={handleCloseClick}
          title="Close"
        >
          <X size={12} className="text-white/80" />
        </button>
      </div>

      {/* Node title bar right-click context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}
    </>
  )
}

export default React.memo(CanvasNodeTitleBar)
