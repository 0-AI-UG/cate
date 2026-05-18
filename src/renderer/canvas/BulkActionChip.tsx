// =============================================================================
// BulkActionChip — floats above a multi-selection's bounding box. Kept to the
// handful of actions that actually earn their pixels on a spatial panel
// canvas: group into a region, stack row/column, tidy into a grid, delete.
// =============================================================================

import React from 'react'
import { Rows, Columns, SquaresFour, FolderSimple, Trash } from '@phosphor-icons/react'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { confirmDeleteRegion } from '../lib/confirmDeleteRegion'

interface Props {
  /** View-space rect of the selection, in screen px. */
  view: { x: number; y: number; w: number; h: number }
  /** Number of selected nodes. */
  count: number
}

const ICON_SIZE = 14

const ChipButton: React.FC<{
  title: string
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}> = ({ title, onClick, children, danger }) => (
  <button
    title={title}
    onClick={(e) => {
      e.stopPropagation()
      onClick()
    }}
    onMouseDown={(e) => e.stopPropagation()}
    className={`flex items-center justify-center w-7 h-7 rounded transition-colors ${
      danger
        ? 'text-muted hover:text-red-400 hover:bg-hover'
        : 'text-secondary hover:text-primary hover:bg-hover'
    }`}
  >
    {children}
  </button>
)

const Divider: React.FC = () => <div className="w-px h-4 bg-subtle/40 mx-0.5" />

const BulkActionChip: React.FC<Props> = ({ view, count: _count }) => {
  const groupSelectedIntoRegion = useCanvasStoreContext((s) => s.groupSelectedIntoRegion)
  const stackSelected = useCanvasStoreContext((s) => s.stackSelected)
  const tidyGridSelected = useCanvasStoreContext((s) => s.tidyGridSelected)
  const deleteSelection = useCanvasStoreContext((s) => s.deleteSelection)
  const canvasApi = useCanvasStoreApi()

  const handleDelete = async () => {
    const state = canvasApi.getState()
    const containedPanels = state.selectedRegionIds.size > 0
      ? Object.values(state.nodes).filter((n) => n.regionId && state.selectedRegionIds.has(n.regionId)).length
      : 0
    if (containedPanels > 0) {
      const choice = await confirmDeleteRegion(containedPanels)
      if (choice === 'cancel') return
      canvasApi.getState().deleteSelection(choice === 'with-contents')
      return
    }
    deleteSelection(false)
  }

  const left = view.x + view.w / 2
  const top = Math.max(8, view.y - 40)

  return (
    <div
      data-bulk-action-chip
      style={{
        position: 'fixed',
        left,
        top,
        transform: 'translateX(-50%)',
        zIndex: 100000,
      }}
      className="flex items-center gap-0.5 px-1 py-1 rounded-md bg-surface-4 border border-subtle shadow-2xl backdrop-blur"
    >
      <ChipButton title="Group into Region" onClick={() => groupSelectedIntoRegion()}>
        <FolderSimple size={ICON_SIZE} />
      </ChipButton>

      <Divider />

      <ChipButton title="Stack as row" onClick={() => stackSelected('row')}>
        <Columns size={ICON_SIZE} />
      </ChipButton>
      <ChipButton title="Stack as column" onClick={() => stackSelected('column')}>
        <Rows size={ICON_SIZE} />
      </ChipButton>
      <ChipButton title="Tidy into grid" onClick={() => tidyGridSelected()}>
        <SquaresFour size={ICON_SIZE} />
      </ChipButton>

      <Divider />

      <ChipButton title="Delete selection" onClick={handleDelete} danger>
        <Trash size={ICON_SIZE} />
      </ChipButton>
    </div>
  )
}

export default BulkActionChip
