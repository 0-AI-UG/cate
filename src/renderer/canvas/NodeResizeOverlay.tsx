// Invisible resize hotspots layered above the panel content. Needed
// because `<webview>` (BrowserPanel) eats pointer events inside its
// rectangle, so detectEdge-on-mousemove never fires for browser panels.
// Only covers the bottom corners + left/right/bottom edges — the top
// strip is owned by the tab bar (close X, maximize, drag).

import React from 'react'
import type { ResizeEdge } from '../hooks/useNodeResize'

interface NodeResizeOverlayProps {
  onResizeStart: (e: React.MouseEvent, edge: ResizeEdge) => void
  cornerSize?: number
  edgeSize?: number
  /** Title-bar height so the side edges start where panel content begins. */
  topInset?: number
  /**
   * Width of the panel content's vertical scrollbar. The right edge strip is
   * shifted left by this much so it sits just inside the scrollbar instead of
   * on top of it — otherwise the strip swallows scrollbar clicks/drags and
   * shows a resize cursor over the scrollbar (#159). Matches the global
   * ::-webkit-scrollbar width in globals.css.
   */
  scrollbarInset?: number
}

const baseStyle: React.CSSProperties = {
  position: 'absolute',
  background: 'transparent',
  zIndex: 50,
  userSelect: 'none',
}

// A wheel delta in line/page mode is normalised to pixels with these
// fallbacks (a wheel "line" is ~1 text row; a "page" is roughly a viewport).
const LINE_HEIGHT_PX = 16
const PAGE_HEIGHT_PX = 400

function deltaToPixels(delta: number, mode: number): number {
  if (mode === 1) return delta * LINE_HEIGHT_PX // DOM_DELTA_LINE
  if (mode === 2) return delta * PAGE_HEIGHT_PX // DOM_DELTA_PAGE
  return delta // DOM_DELTA_PIXEL
}

function isScrollable(el: HTMLElement): boolean {
  const s = getComputedStyle(el)
  const y =
    (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
    el.scrollHeight > el.clientHeight
  const x =
    (s.overflowX === 'auto' || s.overflowX === 'scroll') &&
    el.scrollWidth > el.clientWidth
  return y || x
}

// The innermost scrollable element inside `root` whose box contains (x, y).
// We search the subtree by geometry rather than walking up from
// document.elementFromPoint, because the element under the cursor (e.g.
// xterm's `.xterm-screen`) is often a SIBLING of the actual scroller
// (`.xterm-viewport`), not an ancestor — so an ancestor walk misses it.
function scrollableUnderPoint(
  root: Element,
  x: number,
  y: number,
): HTMLElement | null {
  let best: HTMLElement | null = null
  let bestArea = Infinity
  root.querySelectorAll<HTMLElement>('*').forEach((el) => {
    if (!isScrollable(el)) return
    const r = el.getBoundingClientRect()
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return
    const area = r.width * r.height
    if (area < bestArea) {
      best = el
      bestArea = area
    }
  })
  return best
}

// The strips must stay pointer-events:auto so they can catch the resize
// mousedown that `<webview>` / xterm would otherwise swallow — but that also
// makes them eat wheel events, so content under a strip (e.g. an xterm
// viewport whose scrollbar sits under the right strip) can't scroll (#159).
// Forward the wheel to the scrollable beneath the strip by adjusting its
// scrollTop/scrollLeft directly: the xterm viewport is a native overflow
// div, and a synthetic WheelEvent wouldn't perform the browser's default
// scroll. Setting scrollTop still fires the 'scroll' event xterm syncs to.
function forwardWheel(e: React.WheelEvent<HTMLDivElement>) {
  const node = e.currentTarget.closest('[data-node-id]')
  if (!node) return
  const target = scrollableUnderPoint(node, e.clientX, e.clientY)
  if (!target) return
  target.scrollTop += deltaToPixels(e.deltaY, e.deltaMode)
  target.scrollLeft += deltaToPixels(e.deltaX, e.deltaMode)
}

export const NodeResizeOverlay: React.FC<NodeResizeOverlayProps> = ({
  onResizeStart,
  cornerSize = 12,
  edgeSize = 6,
  topInset = 26,
  scrollbarInset = 6,
}) => {
  const mk = (edge: ResizeEdge, style: React.CSSProperties, cursor: string) => (
    <div
      key={edge}
      data-resize-overlay={edge}
      style={{ ...baseStyle, ...style, cursor }}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        onResizeStart(e, edge)
      }}
      onWheel={forwardWheel}
    />
  )

  return (
    <>
      {mk('bottomLeft',  { bottom: 0, left: 0, width: cornerSize, height: cornerSize }, 'nesw-resize')}
      {mk('bottomRight', { bottom: 0, right: 0, width: cornerSize, height: cornerSize }, 'nwse-resize')}
      {mk('bottom', { bottom: 0, left: cornerSize, right: cornerSize, height: edgeSize }, 'ns-resize')}
      {mk('left',   { top: topInset, bottom: cornerSize, left: 0, width: edgeSize }, 'ew-resize')}
      {/* Inset off the scrollbar and widened a touch to stay easy to grab. */}
      {mk('right',  { top: topInset, bottom: cornerSize, right: scrollbarInset, width: edgeSize + 4 }, 'ew-resize')}
    </>
  )
}
