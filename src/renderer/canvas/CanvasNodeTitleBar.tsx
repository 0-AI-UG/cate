// =============================================================================
// CanvasNodeTitleBar — title bar for canvas node panels.
// Ported from CanvasNodeTitleBar.swift.
// =============================================================================

import React, { useCallback, useState } from 'react'
import { Terminal, Globe, FileText, GitBranch, Lock, X } from 'lucide-react'
import type { PanelType } from '../../shared/types'
import { panelColor } from '../panels/types'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
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
}) => {
  const canvasApi = useCanvasStoreApi()
  const iconColor = panelColor(panelType)

  // Local context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Don't start drag if clicking on buttons
      const target = e.target as HTMLElement
      if (target.closest('[data-titlebar-button]')) return

      // Stop propagation so CanvasNode's resize edge detection doesn't
      // also fire on the same mousedown event.
      e.stopPropagation()

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
      label: isMaximized ? 'Restore' : 'Maximize',
      onClick: onToggleMaximize,
    },
    {
      label: isPinned ? 'Unlock' : 'Lock',
      onClick: onTogglePin,
    },
    { label: '', separator: true, onClick: () => {} },
    {
      label: 'Move to Front',
      onClick: () => {
        canvasApi.getState().moveToFront(nodeId)
      },
    },
    {
      label: 'Move to Back',
      onClick: () => {
        canvasApi.getState().moveToBack(nodeId)
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
        className="flex h-6 bg-[#1E1E24] border-b border-white/[0.05] select-none"
        onContextMenu={handleContextMenu}
      >
        {/* Single tab item — matches stacked tab style */}
        <div
          className="group flex items-center gap-1 px-2 cursor-grab bg-[#28282E] text-white/90 border-r border-white/[0.05] shrink-0"
          onMouseDown={handleMouseDown}
        >
          <PanelIcon type={panelType} color={iconColor} />
          <span className="truncate max-w-[120px] text-xs">{title}</span>
          {/* Close button — visible on hover */}
          <button
            data-titlebar-button
            className="ml-1 p-0.5 rounded-sm opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-white/10"
            onClick={handleCloseClick}
          >
            <X size={10} className="text-white/60" />
          </button>
        </div>

        {/* Pin indicator — shown inline after the tab when pinned */}
        {isPinned && (
          <div className="flex items-center px-1">
            <Lock size={10} className="text-blue-400/60" />
          </div>
        )}
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
