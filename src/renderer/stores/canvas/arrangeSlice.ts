// =============================================================================
// Arrange slice — bulk arrangement: auto-layout the whole canvas, and
// stack/tidy the current selection.
// =============================================================================

import type { CanvasGet, CanvasSet, CanvasStoreActions } from './storeTypes'

type ArrangeActions = Pick<
  CanvasStoreActions,
  'autoLayout' | 'stackSelected' | 'tidyGridSelected'
>

export function createArrangeSlice(set: CanvasSet, get: CanvasGet): ArrangeActions {
  return {
    autoLayout() {
      const state = get()
      const nodeList = Object.values(state.nodes).sort(
        (a, b) => a.creationIndex - b.creationIndex,
      )
      if (nodeList.length === 0) {
        return
      }

      const containerWidth = state.containerSize.width > 0
        ? state.containerSize.width / state.zoomLevel
        : 1600
      const containerHeight = state.containerSize.height > 0
        ? state.containerSize.height / state.zoomLevel
        : 1000

      // Uniform-size grid sized to the viewport.
      const gap = 6
      const n = nodeList.length
      const aspect = containerWidth / Math.max(containerHeight, 1)
      const cols = Math.max(1, Math.round(Math.sqrt(n * aspect)))
      const rows = Math.ceil(n / cols)
      const cellW = Math.max(
        240,
        (containerWidth - gap * (cols + 1)) / cols,
      )
      // Cap cell height by a panel-friendly aspect (≈ 4:3) so tall viewports
      // don't stretch panels vertically.
      const maxCellH = cellW * 0.72
      const cellH = Math.min(
        maxCellH,
        Math.max(160, (containerHeight - gap * (rows + 1)) / rows),
      )
      get().pushHistory()
      const updatedNodes = { ...state.nodes }
      nodeList.forEach((node, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        updatedNodes[node.id] = {
          ...updatedNodes[node.id],
          origin: {
            x: gap + col * (cellW + gap),
            y: gap + row * (cellH + gap),
          },
          size: { width: cellW, height: cellH },
        }
      })
      set({ nodes: updatedNodes })
      get().zoomToFit()
    },

    stackSelected(axis, gap = 16) {
      get().pushHistory()
      set((state) => {
        const selected = Object.values(state.nodes).filter((n) => state.selection.includes(n.id))
        if (selected.length < 2) return state

        const row = axis === 'row'
        const sorted = [...selected].sort((a, b) =>
          row ? a.origin.x - b.origin.x : a.origin.y - b.origin.y,
        )
        // Anchor at the selection's top-left so the stack stays where the user
        // already placed it.
        const startX = Math.min(...selected.map((n) => n.origin.x))
        const startY = Math.min(...selected.map((n) => n.origin.y))

        const next = { ...state.nodes }
        let cursor = row ? startX : startY
        for (const n of sorted) {
          const x = row ? cursor : startX
          const y = row ? startY : cursor
          next[n.id] = { ...n, origin: { x, y } }
          cursor += (row ? n.size.width : n.size.height) + gap
        }
        return { nodes: next }
      })
    },

    tidyGridSelected(gap = 16) {
      get().pushHistory()
      set((state) => {
        const selected = Object.values(state.nodes).filter((n) => state.selection.includes(n.id))
        if (selected.length < 2) return state

        const n = selected.length
        const cols = Math.ceil(Math.sqrt(n))

        // Use the max dimensions so nothing overlaps even with mixed sizes.
        const cellW = Math.max(...selected.map((nd) => nd.size.width))
        const cellH = Math.max(...selected.map((nd) => nd.size.height))

        const startX = Math.min(...selected.map((nd) => nd.origin.x))
        const startY = Math.min(...selected.map((nd) => nd.origin.y))

        // Preserve visual reading order: row-major by current (y, x).
        const sorted = [...selected].sort(
          (a, b) => a.origin.y - b.origin.y || a.origin.x - b.origin.x,
        )

        const next = { ...state.nodes }
        sorted.forEach((nd, i) => {
          const col = i % cols
          const row = Math.floor(i / cols)
          next[nd.id] = {
            ...nd,
            origin: { x: startX + col * (cellW + gap), y: startY + row * (cellH + gap) },
          }
        })
        return { nodes: next }
      })
    },
  }
}
