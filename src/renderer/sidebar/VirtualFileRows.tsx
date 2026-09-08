import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'

export interface VirtualFileRowsHandle { reveal(path: string): void }
interface Props {
  paths: string[]
  scrollRef: React.RefObject<HTMLDivElement>
  pinned: ReadonlySet<string>
  renderRow: (index: number) => React.ReactNode
}
const ROW_HEIGHT = 32
const OVERSCAN = 6

/** Variable row heights retain inline create/rename flows. Only the viewport,
 * overscan, and actively edited rows remain mounted. Keyboard ordering remains
 * owned by the explorer's full flat model. */
export const VirtualFileRows = forwardRef<VirtualFileRowsHandle, Props>(function VirtualFileRows({ paths, scrollRef, pinned, renderRow }, ref) {
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [heights, setHeights] = useState<Map<string, number>>(new Map())
  const elements = useRef(new Map<string, HTMLDivElement>())
  const observer = useRef<ResizeObserver | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const offsets = useMemo(() => {
    const result = [0]
    for (const path of paths) result.push(result[result.length - 1] + (heights.get(path) ?? ROW_HEIGHT))
    return result
  }, [paths, heights])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const update = () => setViewport({ top: Math.max(0, scroll.scrollTop - (list.current?.offsetTop ?? 0)), height: scroll.clientHeight || 600 })
    update()
    scroll.addEventListener('scroll', update, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    resize?.observe(scroll)
    return () => { scroll.removeEventListener('scroll', update); resize?.disconnect() }
  }, [scrollRef])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const resize = new ResizeObserver((entries) => {
      setHeights((previous) => {
        let next = previous
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.virtualPath!
          const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
          if (height > 0 && (previous.get(path) ?? ROW_HEIGHT) !== height) {
            if (next === previous) next = new Map(previous)
            next.set(path, height)
          }
        }
        return next
      })
    })
    observer.current = resize
    for (const element of elements.current.values()) resize.observe(element)
    return () => { resize.disconnect(); observer.current = null }
  }, [])

  useEffect(() => {
    const live = new Set(paths)
    setHeights((previous) => {
      if ([...previous.keys()].every((path) => live.has(path))) return previous
      return new Map([...previous].filter(([path]) => live.has(path)))
    })
  }, [paths])

  useImperativeHandle(ref, () => ({
    reveal(path) {
      const index = paths.indexOf(path)
      const scroll = scrollRef.current
      if (index < 0 || !scroll) return
      const base = list.current?.offsetTop ?? 0
      const top = offsets[index] + base
      const bottom = offsets[index + 1] + base
      if (top < scroll.scrollTop) scroll.scrollTop = top
      else if (bottom > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = Math.max(0, bottom - (scroll.clientHeight || 600))
      setViewport({ top: Math.max(0, scroll.scrollTop - base), height: scroll.clientHeight || 600 })
    },
  }), [paths, offsets, scrollRef])

  const register = useCallback((path: string, element: HTMLDivElement | null) => {
    const old = elements.current.get(path)
    if (old) observer.current?.unobserve(old)
    if (element) { elements.current.set(path, element); observer.current?.observe(element) }
    else elements.current.delete(path)
  }, [])
  // Binary-search the first row intersecting the viewport.
  let low = 0
  let high = paths.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (offsets[middle + 1] <= viewport.top) low = middle + 1
    else high = middle
  }
  const start = Math.max(0, low - OVERSCAN)
  let end = low
  while (end < paths.length && offsets[end] < viewport.top + viewport.height) end++
  end = Math.min(paths.length, end + OVERSCAN)
  const indices = new Set(Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i))
  for (const path of pinned) { const index = paths.indexOf(path); if (index >= 0) indices.add(index) }

  return <div ref={list} className="relative" style={{ height: offsets[offsets.length - 1] }} data-virtual-file-rows>
    {[...indices].sort((a, b) => a - b).map((index) => (
      <div key={paths[index]} ref={(element) => register(paths[index], element)} data-virtual-path={paths[index]}
        style={{ position: 'absolute', display: 'flow-root', top: offsets[index], left: 0, right: 0 }}>
        {renderRow(index)}
      </div>
    ))}
  </div>
})
