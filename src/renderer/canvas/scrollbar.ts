// Scrollbar hit-testing shared by the resize paths (native detectEdge cursor
// in useNodeResizeCursor and the NodeResizeOverlay strips). A panel's content
// scrollbar (e.g. the xterm viewport's) sits at the very right/bottom edge —
// exactly where the resize hit-bands are — so without this the resize cursor
// appears over the scrollbar and a click resizes instead of grabbing it (#159).

/**
 * Whether the point (client coords) lands on a vertical or horizontal
 * scrollbar of any scrollable descendant of `node`. Scrollbar thickness is
 * derived from offsetWidth/clientWidth so it tracks the real rendered width
 * (~6px here) rather than a hard-coded guess.
 */
export function isOverScrollbar(node: Element, x: number, y: number): boolean {
  const els = node.querySelectorAll<HTMLElement>('*')
  for (const el of els) {
    const vbar = el.offsetWidth - el.clientWidth // vertical scrollbar + borders
    const hbar = el.offsetHeight - el.clientHeight // horizontal scrollbar + borders
    if (vbar <= 0 && hbar <= 0) continue
    const r = el.getBoundingClientRect()
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
    if (vbar > 0 && x >= r.right - vbar) return true
    if (hbar > 0 && y >= r.bottom - hbar) return true
  }
  return false
}
