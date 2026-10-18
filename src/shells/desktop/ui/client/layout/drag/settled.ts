// True once a drag has run for 50ms: zones animate their neighbours only then,
// so the dragged item leaving and its gap opening happen in one frame, unanimated.
import { useEffect, useState } from 'react'
import { useDragStore } from './store'

export function useDragSettled(): boolean {
  const dragging = useDragStore((s) => s.isDragging)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!dragging) return
    const timer = globalThis.setTimeout(() => setSettled(true), 50)
    return () => { globalThis.clearTimeout(timer); setSettled(false) }
  }, [dragging])
  return settled
}
