// =============================================================================
// DockTabContextMenu — long-press split-button popup for DockTabStack.
// Renders a small floating menu of panel types; clicking one performs a
// split-with-type via the provided callback.
// =============================================================================

import React from 'react'
import { createPortal } from 'react-dom'
import type { PanelType } from '../../shared/types'
import { Terminal as TerminalIcon, Globe, FileText, GitBranch, TreeStructure, SquaresFour, List } from '@phosphor-icons/react'

export type SplitMenuItem = { type: PanelType; label: string; Icon: React.ComponentType<any> }

// Items shown in the long-press split menu (order = display order).
export const SPLIT_MENU_ITEMS: SplitMenuItem[] = [
  { type: 'editor', label: 'Editor', Icon: FileText },
  { type: 'terminal', label: 'Terminal', Icon: TerminalIcon },
  { type: 'browser', label: 'Browser', Icon: Globe },
  { type: 'fileExplorer', label: 'File Explorer', Icon: TreeStructure },
  { type: 'git', label: 'Git', Icon: GitBranch },
  { type: 'canvas', label: 'Canvas', Icon: SquaresFour },
  { type: 'projectList', label: 'Projects', Icon: List },
]

export interface DockTabContextMenuProps {
  open: boolean
  position: { top: number; right: number } | null
  items: SplitMenuItem[]
  onPick: (type: PanelType) => void
  onClose: () => void
}

export function DockTabContextMenu({ open, position, items, onPick, onClose }: DockTabContextMenuProps) {
  if (!open || !position) return null
  return createPortal(
    <div
      className="fixed z-[1000] min-w-[170px] rounded-md border border-subtle bg-surface-3 shadow-xl py-1 text-xs"
      style={{ top: position.top, right: position.right }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map(({ type, label, Icon }) => (
        <button
          key={type}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-secondary hover:bg-surface-4 hover:text-primary"
          onClick={() => {
            onClose()
            onPick(type)
          }}
        >
          <Icon size={13} className="text-muted" />
          <span>Split with {label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
