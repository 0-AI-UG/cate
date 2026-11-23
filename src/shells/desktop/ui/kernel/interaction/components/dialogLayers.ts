import { useLayoutEffect, useRef, useState } from 'react'

const layers: Array<{ order: number; key(event: KeyboardEvent): void }> = []
let nextOrder = 100002
function dispatch(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  layers.at(-1)?.key(event)
}

export function isTopDialogLayer(order: number): boolean {
  return layers.at(-1)?.order === order
}

/** Settings and its child dialogs share one Escape owner. */
export function useDialogLayer(onEscape?: (event: KeyboardEvent) => void): number {
  const callback = useRef(onEscape)
  callback.current = onEscape
  const [order] = useState(() => nextOrder++)
  useLayoutEffect(() => {
    const layer = { order, key: (event: KeyboardEvent) => callback.current?.(event) }
    if (!layers.length) document.addEventListener('keydown', dispatch, { capture: true })
    layers.push(layer)
    layers.sort((a, b) => a.order - b.order)
    return () => {
      layers.splice(layers.indexOf(layer), 1)
      if (!layers.length) document.removeEventListener('keydown', dispatch, { capture: true })
    }
  }, [order])
  return order
}
