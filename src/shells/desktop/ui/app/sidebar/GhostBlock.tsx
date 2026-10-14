// The dashed block that stands for a lifted layout of the workspace tree: in
// its place while another zone owns the drop, under the cursor while the tree does.

import React from 'react'
import { createPortal } from 'react-dom'
import { GHOST_LOOK } from '../../client/layout/drag'
import type { Float } from './useSidebarTree'

/** What the lifted row looks like as the ghost. */
export interface RowLook {
  label: string
  icon: React.ReactNode
}

/** The dashed ghost that stands for a lifted row or layout: its size, its label at the top (centered when it is one row). */
export function GhostBlock({ look, height, ...rest }: { look: RowLook; height: number } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      {...rest}
      className={`flex gap-1.5 px-2 text-[13px] rounded-lg select-none ${height <= 36 ? 'items-center' : 'items-start pt-1.5'}`}
      style={{ ...rest.style, ...GHOST_LOOK, height }}
    >
      <span className={`shrink-0 flex ${height <= 36 ? '' : 'pt-0.5'}`}>{look.icon}</span>
      <span className="min-w-0 flex-1 truncate">{look.label}</span>
    </div>
  )
}

/** The lifted layout under the cursor: its dashed block. (A lifted panel row is restyled in
 *  place: see `rowGhost` in the tree.) */
export function DragFloat({ look, float }: { look: RowLook; float: Float }) {
  return createPortal(
    <GhostBlock look={look} height={float.height} data-sidebar-drag-float style={{ position: 'fixed', zIndex: 10000, pointerEvents: 'none', left: float.left, top: float.top, width: float.width }} />,
    document.body,
  )
}
