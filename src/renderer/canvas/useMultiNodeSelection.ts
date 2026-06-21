// =============================================================================
// useMultiNodeSelection — helpers for branching canvas UI on whether more than
// one canvas node is selected at once. Canvas context menus use this to hide
// per-node actions (split / new tab) and surface bulk actions (Close All) only
// when a multi-selection is active.
// =============================================================================

import { useCallback } from 'react'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'

export function useMultiNodeSelection() {
  const canvasApi = useCanvasStoreApi()

  // Imperative read — for async menu builders / event handlers that need the
  // value at call time rather than as a reactive subscription.
  const isMultiSelected = useCallback(
    () => canvasApi.getState().selection.length > 1,
    [canvasApi],
  )

  // Close (remove) every selected node at once. Mirrors the Delete shortcut.
  const closeSelection = useCallback(() => {
    canvasApi.getState().deleteSelection()
  }, [canvasApi])

  return { isMultiSelected, closeSelection }
}
