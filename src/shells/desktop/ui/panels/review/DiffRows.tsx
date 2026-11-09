import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

const CHUNK_SIZE = 40

function protectsInput(el: HTMLElement): boolean {
  const selection = window.getSelection()
  if (el.contains(document.activeElement)) return true
  if (!selection || selection.isCollapsed) return false
  for (let i = 0; i < selection.rangeCount; i++) {
    if (selection.getRangeAt(i).intersectsNode(el)) return true
  }
  return false
}

/** Keep long hunks out of the DOM, including their per-line buttons and icons.
 * Heights are measured in layout pixels, so canvas zoom doesn't change them. */
function DiffChunk({ start, end, renderRow, keepMounted, wrap, columns }: {
  start: number
  end: number
  renderRow: (index: number) => React.ReactNode
  keepMounted: boolean
  wrap: boolean
  columns: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(start === 0 || typeof IntersectionObserver === 'undefined')
  const [retained, setRetained] = useState(false)
  const [height, setHeight] = useState<number | null>(null)
  const mounted = visible || keepMounted || retained
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting)
      setRetained(!entry.isIntersecting && protectsInput(el))
    }, { root: el.closest('[data-review-scroll]'), rootMargin: '400px 0px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // Release a protected offscreen chunk when focus/selection moves away;
  // otherwise repeatedly editing distant rows could retain the whole diff.
  useEffect(() => {
    const el = ref.current
    if (!retained || !el) return
    let live = true
    const refresh = () => { if (live) setRetained(protectsInput(el)) }
    const blur = () => queueMicrotask(refresh)
    refresh()
    document.addEventListener('selectionchange', refresh)
    document.addEventListener('focusin', refresh)
    document.addEventListener('focusout', blur)
    return () => {
      live = false
      document.removeEventListener('selectionchange', refresh)
      document.removeEventListener('focusin', refresh)
      document.removeEventListener('focusout', blur)
    }
  }, [retained, keepMounted])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !mounted) return
    const measure = () => { if (el.offsetHeight > 0) setHeight(el.offsetHeight) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [mounted, wrap, columns])
  return <div ref={ref} data-diff-chunk={start} style={mounted ? undefined : {
    height: height ?? `${(end - start) * 1.45}em`,
    // Reserve the longest line's width until it mounts, preserving horizontal
    // scroll range. Wrapped lines take their measured height on first display.
    minWidth: wrap ? undefined : `calc(${columns}ch + 116px)`,
  }}>
    {mounted && Array.from({ length: end - start }, (_, i) => <React.Fragment key={start + i}>{renderRow(start + i)}</React.Fragment>)}
  </div>
}

export function DiffRows({ count, renderRow, keepRow, wrap, columns }: {
  count: number
  renderRow: (index: number) => React.ReactNode
  keepRow?: (index: number) => boolean
  wrap: boolean
  columns: number
}) {
  // Small hunks retain their normal DOM and text selection behavior.
  if (count <= CHUNK_SIZE * 2) return <>{Array.from({ length: count }, (_, i) => <React.Fragment key={i}>{renderRow(i)}</React.Fragment>)}</>
  return <>{Array.from({ length: Math.ceil(count / CHUNK_SIZE) }, (_, chunk) => {
    const start = chunk * CHUNK_SIZE
    const end = Math.min(count, start + CHUNK_SIZE)
    let keepMounted = false
    for (let i = start; i < end && !keepMounted; i++) keepMounted = keepRow?.(i) ?? false
    return <DiffChunk key={start} start={start} end={end} renderRow={renderRow} keepMounted={keepMounted} wrap={wrap} columns={columns} />
  })}</>
}
