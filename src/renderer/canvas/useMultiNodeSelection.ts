// =============================================================================
// useMultiNodeSelection — helpers for branching canvas UI on whether more than
// one canvas node is selected at once. Canvas context menus use this to hide
// per-node actions (split / new tab) and surface bulk actions (Close All) only
// when a multi-selection is active.
// =============================================================================

import { useCallback } from 'react'
import { useOptionalCanvasStoreApi } from '../stores/CanvasStoreContext'

export function useMultiNodeSelection() {
  // Optional: DockTabStack (via useDockTabActions) also renders inside detached
  // dock windows, which have no canvas node and thus no CanvasStoreProvider.
  // Multi-node selection only applies to localOnly canvas mini-docks (which
  // always have a provider), so a missing store just means "no selection".
  const canvasApi = useOptionalCanvasStoreApi()

  // Imperative read — for async menu builders / event handlers that need the
  // value at call time rather than as a reactive subscription.
  const isMultiSelected = useCallback(
    () => (canvasApi?.getState().selection.length ?? 0) > 1,
    [canvasApi],
  )

  // Close (remove) every selected node at once. Mirrors the Delete shortcut.
  const closeSelection = useCallback(() => {
    void canvasApi?.getState().deleteSelection()
  }, [canvasApi])

  return { isMultiSelected, closeSelection }
}
