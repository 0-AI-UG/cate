// =============================================================================
// Pure placement geometry for the cate-control feature. No store / DOM access —
// callers pass in occupied rects + viewport so this stays unit-testable.
// All coordinates are canvas-space.
// =============================================================================

export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }

export type RelPosition = 'right' | 'left' | 'above' | 'below'
export type ArrangeLayout = 'tile' | 'grid' | 'cascade' | 'focus-one'

const GAP = 40
const CASCADE_STEP = 40

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

export interface PlacementInput {
  size: Size
  /** When omitted, places relative to the viewport center. */
  relativeTo?: Rect
  position?: RelPosition
  /** Existing node rects to avoid overlapping. */
  occupied: Rect[]
  /** Canvas-space point to center on when there is no relativeTo. */
  viewportCenter: Point
}

/** Compute a non-overlapping canvas-space rect for a new/moved panel. */
export function computePlacement(input: PlacementInput): Rect {
  const { size, relativeTo, position, occupied, viewportCenter } = input
  let x: number
  let y: number

  if (relativeTo && position) {
    switch (position) {
      case 'right': x = relativeTo.x + relativeTo.width + GAP; y = relativeTo.y; break
      case 'left': x = relativeTo.x - GAP - size.width; y = relativeTo.y; break
      case 'below': x = relativeTo.x; y = relativeTo.y + relativeTo.height + GAP; break
      case 'above': x = relativeTo.x; y = relativeTo.y - GAP - size.height; break
    }
  } else {
    x = viewportCenter.x - size.width / 2
    y = viewportCenter.y - size.height / 2
  }

  // Nudge right until no overlap (bounded to avoid runaway).
  let candidate: Rect = { x, y, width: size.width, height: size.height }
  for (let i = 0; i < 64 && occupied.some((o) => overlaps(candidate, o)); i++) {
    candidate = { ...candidate, x: candidate.x + size.width + GAP }
  }
  return candidate
}

/** Lay out `count` panels within the given viewport rect. */
export function computeArrange(layout: ArrangeLayout, count: number, viewport: Rect): Rect[] {
  if (count <= 0) return []
  if (layout === 'focus-one') {
    return [{ x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height }]
  }
  if (layout === 'cascade') {
    const w = Math.round(viewport.width * 0.6)
    const h = Math.round(viewport.height * 0.6)
    return Array.from({ length: count }, (_, i) => ({
      x: viewport.x + i * CASCADE_STEP,
      y: viewport.y + i * CASCADE_STEP,
      width: w,
      height: h,
    }))
  }
  // tile / grid: square-ish grid.
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const cellW = Math.floor(viewport.width / cols)
  const cellH = Math.floor(viewport.height / rows)
  return Array.from({ length: count }, (_, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    return { x: viewport.x + col * cellW, y: viewport.y + row * cellH, width: cellW, height: cellH }
  })
}
