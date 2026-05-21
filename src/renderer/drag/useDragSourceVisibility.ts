// =============================================================================
// useDragSourceVisibility — single source of truth for "is this element the
// active drag source, and should it be hidden?". Consumers (CanvasNode,
// DockTabStack tab pills) subscribe via this hook and apply the returned
// `hidden` flag as inline opacity/pointer-events on exactly ONE DOM element.
//
// Replaces three previously drifting channels:
//   1. the [data-drag-source] CSS rule
//   2. the 'set-source-attr' DragEffect + dispatcher document.querySelector
//   3. ad-hoc inline opacity props sourced from a local zustand subscription
// =============================================================================

import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useDragStore } from './store'
import { shallow } from 'zustand/shallow'
import {
  selectDragSourceRole,
  selectDragSourceRoleForTab,
  type DragSourceRole,
} from './selectors'

export interface DragSourceVisibility {
  hidden: boolean
  role: DragSourceRole
}

/** Visibility for a canvas-node id. `hidden` is true only for whole-node
 *  drags — tab-role does NOT hide the host node (the tab itself is hidden
 *  separately by DockTabStack via useTabSourceVisibility). */
export function useDragSourceVisibility(nodeId: string): DragSourceVisibility {
  return useStoreWithEqualityFn(
    useDragStore,
    (s) => {
      const role = selectDragSourceRole(s, nodeId)
      return { hidden: role === 'whole-node', role }
    },
    shallow,
  )
}

/** Visibility for an individual dock tab. `hidden` is true while THIS panel
 *  is the dock-tab source in flight. */
export function useTabSourceVisibility(panelId: string): {
  hidden: boolean
  role: 'tab' | null
} {
  return useStoreWithEqualityFn(
    useDragStore,
    (s) => {
      const role = selectDragSourceRoleForTab(s, panelId)
      return { hidden: role === 'tab', role }
    },
    shallow,
  )
}
