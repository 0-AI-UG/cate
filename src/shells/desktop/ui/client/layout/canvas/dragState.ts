import { useCallback, useSyncExternalStore } from 'react'
import { canvasDrag, subscribeCanvasDragPort, type CanvasDragState } from './ports'

function subscribe(listener: () => void): () => void {
  let stopPort = canvasDrag().subscribe(listener)
  const stopInstall = subscribeCanvasDragPort(() => {
    stopPort()
    stopPort = canvasDrag().subscribe(listener)
    listener()
  })
  return () => { stopInstall(); stopPort() }
}

/** A slice of the drag layer's state; re-renders when it changes. */
export function useCanvasDrag<T>(selector: (state: CanvasDragState) => T): T {
  const read = useCallback(() => selector(canvasDrag().getState()), [selector])
  return useSyncExternalStore(subscribe, read)
}

const selectDragging = (s: CanvasDragState) => s.dragging

export function useIsDragging(): boolean {
  return useCanvasDrag(selectDragging)
}

export function useIsDragSource(nodeId: string): boolean {
  return useCanvasDrag(useCallback((s: CanvasDragState) => s.sourceNodeId === nodeId, [nodeId]))
}
