import { useCallback, useEffect } from 'react'

export function useAutoGrowingTextarea(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  options: {
    maxHeight?: number
    observeWidth?: boolean
    onHeightChange?: (height: number) => void
  } = {},
): () => void {
  const { maxHeight = 160, observeWidth = false, onHeightChange } = options

  const resize = useCallback(() => {
    const element = ref.current
    if (!element) return
    element.style.height = '0px'
    const fullHeight = element.scrollHeight
    const height = Math.min(fullHeight, maxHeight)
    element.style.height = `${height}px`
    element.style.overflowY = fullHeight > maxHeight ? 'auto' : 'hidden'
    onHeightChange?.(height)
  }, [maxHeight, onHeightChange, ref])

  useEffect(resize, [resize, value])

  useEffect(() => {
    const element = ref.current
    if (!observeWidth || !element || typeof ResizeObserver === 'undefined') return
    let lastWidth = element.clientWidth
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth
      if (width === lastWidth) return
      lastWidth = width
      resize()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [observeWidth, ref, resize])

  return resize
}
