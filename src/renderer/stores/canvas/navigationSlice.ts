// =============================================================================
// Navigation slice — spatial keyboard navigation (focus-jump / select-jump in a
// direction) and step-panning the viewport.
// =============================================================================

import type { CanvasNodeState } from '../../../shared/types'
import type { CanvasGet, CanvasSet, CanvasStoreActions } from './storeTypes'
import type { CanvasStoreCtx } from './storeCtx'
import { findNodeInDirection, PAN_STEP } from './helpers'
import { focusedNodeId } from './selectionModel'

type NavigationActions = Pick<CanvasStoreActions, 'navigateDirection' | 'navigateSelect' | 'panViewport'>

export function createNavigationSlice(set: CanvasSet, get: CanvasGet, ctx: CanvasStoreCtx): NavigationActions {
  return {
    navigateDirection(dir) {
      const state = get()
      const nodeList = Object.values(state.nodes)
      if (nodeList.length === 0) return

      // Reference center: focused node's center, else the viewport center.
      const focused = focusedNodeId(state)
      const current = focused ? state.nodes[focused] : null
      let refX: number
      let refY: number
      if (current) {
        refX = current.origin.x + current.size.width / 2
        refY = current.origin.y + current.size.height / 2
      } else {
        const cs = state.containerSize
        const center = get().viewToCanvas({ x: cs.width / 2, y: cs.height / 2 })
        refX = center.x
        refY = center.y
      }

      const best = findNodeInDirection(nodeList, refX, refY, dir, current?.id)
      if (best) get().focusAndCenter(best.id)
    },

    navigateSelect(dir) {
      const state = get()
      const nodeList = Object.values(state.nodes)
      if (nodeList.length === 0) return

      // Reference center: the single selected node, else the focused node, else
      // the viewport center. Using selection (not focus) as the cursor lets the
      // user chain jumps without the destination grabbing keyboard focus.
      let ref: CanvasNodeState | null = null
      if (state.selection.length === 1) {
        ref = state.nodes[state.selection[0]] ?? null
      }
      const focused = focusedNodeId(state)
      if (!ref && focused) ref = state.nodes[focused] ?? null

      let refX: number
      let refY: number
      if (ref) {
        refX = ref.origin.x + ref.size.width / 2
        refY = ref.origin.y + ref.size.height / 2
      } else {
        const cs = state.containerSize
        const center = get().viewToCanvas({ x: cs.width / 2, y: cs.height / 2 })
        refX = center.x
        refY = center.y
      }

      const best = findNodeInDirection(nodeList, refX, refY, dir, ref?.id)
      if (!best) return

      // Select + raise the target and clear focus so no panel content grabs the
      // keyboard — otherwise the next arrow would be swallowed by the node
      // instead of moving to the one beyond it. The viewport then glides to
      // centre the node (see animateViewportTo) instead of snapping.
      set({
        nodes: { ...state.nodes, [best.id]: { ...best, zOrder: state.nextZOrder } },
        nextZOrder: state.nextZOrder + 1,
        // Select without activating (ring, not halo) so no panel grabs the
        // keyboard and the next arrow keeps navigating.
        selection: [best.id],
        selectionActive: false,
        // Don't let auto-focus-largest re-activate a node as we pan to centre.
        suppressAutoFocus: true,
      })
      const cs = state.containerSize
      const zoom = state.zoomLevel
      if (cs.width > 0 && cs.height > 0) {
        get().animateViewportTo({
          x: cs.width / 2 - (best.origin.x + best.size.width / 2) * zoom,
          y: cs.height / 2 - (best.origin.y + best.size.height / 2) * zoom,
        })
      }
    },

    panViewport(dir) {
      // Panning the canvas by keyboard must not auto-activate nodes scrolling
      // into view.
      if (!get().suppressAutoFocus) set({ suppressAutoFocus: true })
      // Accumulate from the in-flight target (if animating) so repeated key
      // presses stack smoothly rather than chasing the easing tween.
      const o = ctx.offsetAnimTarget ?? get().viewportOffset
      // Arrow direction = direction the camera moves, so content scrolls the
      // opposite way (Down reveals what's below → offset.y decreases).
      const target =
        dir === 'up' ? { x: o.x, y: o.y + PAN_STEP }
        : dir === 'down' ? { x: o.x, y: o.y - PAN_STEP }
        : dir === 'left' ? { x: o.x + PAN_STEP, y: o.y }
        : { x: o.x - PAN_STEP, y: o.y }
      get().animateViewportTo(target)
    },
  }
}
