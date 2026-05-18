// =============================================================================
// livePositions — a lightweight, side-channel position map used during node
// drag so overlay layers (CanvasConnections in particular) can follow the
// node in real time.
//
// Background: useNodeDrag deliberately does NOT call canvasStore.moveNode on
// every pointer-move — instead it mutates the dragged DOM element's
// `style.left/top` imperatively and commits to the store once on mouseup.
// That keeps the 60 fps drag cheap (no React re-render of every node), but
// it means anything that reads positions from canvasStore (like the SVG
// overlay drawing connection wires) is stuck on the pre-drag coordinates
// until the drag ends.
//
// This module is the bridge: useNodeDrag pushes the live origin here on
// each RAF tick; CanvasConnections reads from it (falling back to the store
// when no drag is in progress) and rerenders accordingly.
// =============================================================================

import { useSyncExternalStore } from 'react'

const positions = new Map<string, { x: number; y: number }>()
const listeners = new Set<() => void>()
let version = 0
let frame: number | null = null

function notify(): void {
  // Coalesce notifications to one per animation frame so a fast drag doesn't
  // explode subscriber re-renders.
  if (frame !== null) return
  frame = requestAnimationFrame(() => {
    frame = null
    version++
    for (const fn of listeners) {
      try { fn() } catch { /* subscriber errors must not break the drag */ }
    }
  })
}

export const livePositions = {
  /** Push the live origin for a node during a drag. */
  set(nodeId: string, x: number, y: number): void {
    const prev = positions.get(nodeId)
    if (prev && prev.x === x && prev.y === y) return
    positions.set(nodeId, { x, y })
    notify()
  },
  /** Clear the live origin for a node — call on drop / drag-cancel so the
   *  next read falls back to the canvasStore value. */
  clear(nodeId: string): void {
    if (!positions.has(nodeId)) return
    positions.delete(nodeId)
    notify()
  },
  clearAll(): void {
    if (positions.size === 0) return
    positions.clear()
    notify()
  },
  get(nodeId: string): { x: number; y: number } | null {
    return positions.get(nodeId) ?? null
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  /** Monotonic counter — bumps whenever any live position changes. Used by
   *  hooks that just need a "something moved" signal. */
  getVersion(): number {
    return version
  },
}

/** React hook: re-renders whenever any live position changes. Returns the
 *  current version counter — components don't need to use it, just subscribing
 *  is enough to trigger the rerender. */
export function useLivePositionsVersion(): number {
  return useSyncExternalStore(livePositions.subscribe, livePositions.getVersion, livePositions.getVersion)
}
