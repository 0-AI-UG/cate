// The canvas container carries its identity as data attributes, so DOM hit
// tests (drops, the toolbar's drag-to-spawn) can find the canvas under a point.

const CANVAS_CONTAINER_ATTR = 'data-canvas-container'

export interface CanvasAtPoint {
  workspaceId: string
  canvasId: string
  canvasPanelId: string
  element: HTMLElement
  rect: DOMRect
}

function describe(element: HTMLElement | null): CanvasAtPoint | null {
  if (!element) return null
  const workspaceId = element.dataset.workspaceId
  const canvasId = element.dataset.canvasId
  const canvasPanelId = element.dataset.canvasPanelId
  if (!workspaceId || !canvasId || !canvasPanelId) return null
  return { workspaceId, canvasId, canvasPanelId, element, rect: element.getBoundingClientRect() }
}

function containers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${CANVAS_CONTAINER_ATTR}]`))
}

export function canvasContainerFor(canvasId: string): HTMLElement | null {
  return containers().find((el) => el.dataset.canvasId === canvasId) ?? null
}

/** The canvas under a client point: the hit element's canvas, else any
 *  canvas whose box holds the point (a guest surface may be on top). */
export function canvasAtPoint(clientX: number, clientY: number): CanvasAtPoint | null {
  const hit = document.elementFromPoint?.(clientX, clientY) as HTMLElement | null
  const direct = hit?.closest<HTMLElement>(`[${CANVAS_CONTAINER_ATTR}]`) ?? null
  if (direct) return describe(direct)
  const boxed = containers().find((el) => {
    const r = el.getBoundingClientRect()
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
  })
  return describe(boxed ?? null)
}
