import React, { createContext, useCallback, useRef } from 'react'

interface SurfaceEntry {
  container: HTMLDivElement
  cleanup: (() => void) | null
  frame: number | null
}

const slots = new Map<string, HTMLDivElement>()
const surfaces = new Map<string, SurfaceEntry>()

interface SurfaceRect {
  left: number
  top: number
  right: number
  bottom: number
}

const CLIPPING_OVERFLOWS = new Set(['auto', 'clip', 'hidden', 'scroll'])

function intersectRects(a: SurfaceRect, b: SurfaceRect): SurfaceRect | null {
  const rect = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
  return rect.right > rect.left && rect.bottom > rect.top ? rect : null
}

function clippingRect(slot: HTMLElement, rect: DOMRect): SurfaceRect | null {
  let visible: SurfaceRect | null = intersectRects(rect, {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  })
  for (let element = slot.parentElement; visible && element; element = element.parentElement) {
    const style = getComputedStyle(element)
    const shorthand = style.overflow.trim().split(/\s+/)
    const overflowX = style.overflowX && style.overflowX !== 'visible'
      ? style.overflowX
      : shorthand[0]
    const overflowY = style.overflowY && style.overflowY !== 'visible'
      ? style.overflowY
      : (shorthand[1] ?? shorthand[0])
    const clipsX = CLIPPING_OVERFLOWS.has(overflowX)
    const clipsY = CLIPPING_OVERFLOWS.has(overflowY)
    if (!clipsX && !clipsY) continue
    const ancestor = element.getBoundingClientRect()
    visible = intersectRects(visible, {
      left: clipsX ? ancestor.left : visible.left,
      top: clipsY ? ancestor.top : visible.top,
      right: clipsX ? ancestor.right : visible.right,
      bottom: clipsY ? ancestor.bottom : visible.bottom,
    })
  }
  return visible
}

function cssNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000)
}

function surfaceClipPath(
  slot: HTMLElement,
  rect: DOMRect,
  logicalWidth: number,
  logicalHeight: number,
): string | null {
  const visible = clippingRect(slot, rect)
  if (!visible) return null

  const scaleX = rect.width / logicalWidth
  const scaleY = rect.height / logicalHeight
  const local = (screenRect: SurfaceRect): SurfaceRect => ({
    left: (screenRect.left - rect.left) / scaleX,
    top: (screenRect.top - rect.top) / scaleY,
    right: (screenRect.right - rect.left) / scaleX,
    bottom: (screenRect.bottom - rect.top) / scaleY,
  })
  const outer = local(visible)

  // The persistent surface lives outside the canvas transform, so matching the
  // node's z-index alone cannot interleave it with regular canvas children.
  // Punch out higher nodes and let their real DOM show through those regions.
  const node = slot.closest<HTMLElement>('[data-node-id]')
  const nodeLayer = node?.parentElement
  const nodeZIndex = node ? Number.parseFloat(getComputedStyle(node).zIndex) : Number.NaN
  const occluders = nodeLayer && Number.isFinite(nodeZIndex)
    ? Array.from(nodeLayer.children)
      .filter((element): element is HTMLElement => (
        element instanceof HTMLElement
        && element !== node
        && element.hasAttribute('data-node-id')
      ))
      .filter((element) => {
        const style = getComputedStyle(element)
        return Number.parseFloat(style.zIndex) > nodeZIndex
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number.parseFloat(style.opacity || '1') > 0
      })
      .map((element) => intersectRects(visible, element.getBoundingClientRect()))
      .filter((value): value is SurfaceRect => value !== null)
      .map(local)
    : []

  if (occluders.length === 0) {
    return `inset(${cssNumber(outer.top)}px ${cssNumber(logicalWidth - outer.right)}px ${cssNumber(logicalHeight - outer.bottom)}px ${cssNumber(outer.left)}px)`
  }

  const path = [
    `M ${cssNumber(outer.left)} ${cssNumber(outer.top)}`,
    `H ${cssNumber(outer.right)}`,
    `V ${cssNumber(outer.bottom)}`,
    `H ${cssNumber(outer.left)} Z`,
    ...occluders.map((hole) => (
      `M ${cssNumber(hole.left)} ${cssNumber(hole.top)} H ${cssNumber(hole.right)} V ${cssNumber(hole.bottom)} H ${cssNumber(hole.left)} Z`
    )),
  ].join(' ')
  return `path(evenodd, "${path}")`
}

function parkSurface(surface: SurfaceEntry): void {
  const { container } = surface
  container.dataset.browserSurfaceVisible = 'false'
  container.style.position = 'fixed'
  container.style.left = '-20000px'
  container.style.top = '0'
  container.style.width = '1200px'
  container.style.height = '800px'
  container.style.transform = 'none'
  container.style.clipPath = 'none'
  container.style.opacity = '0'
  container.style.pointerEvents = 'none'
}

function updateSurface(panelId: string): void {
  const surface = surfaces.get(panelId)
  const slot = slots.get(panelId)
  if (!surface || !slot?.isConnected) {
    if (surface) parkSurface(surface)
    return
  }

  const rect = slot.getBoundingClientRect()
  const logicalWidth = slot.offsetWidth || rect.width
  const logicalHeight = slot.offsetHeight || rect.height
  const visible = rect.width > 0
    && rect.height > 0
    && getComputedStyle(slot).visibility !== 'hidden'
  if (!visible || logicalWidth <= 0 || logicalHeight <= 0) {
    parkSurface(surface)
    return
  }

  const clipPath = surfaceClipPath(slot, rect, logicalWidth, logicalHeight)
  if (!clipPath) {
    parkSurface(surface)
    return
  }

  const node = slot.closest<HTMLElement>('[data-node-id]')
  const nodeZIndex = node ? getComputedStyle(node).zIndex : 'auto'
  const { container } = surface
  container.dataset.browserSurfaceVisible = 'true'
  container.style.position = 'fixed'
  container.style.left = '0'
  container.style.top = '0'
  container.style.width = `${logicalWidth}px`
  container.style.height = `${logicalHeight}px`
  container.style.transformOrigin = '0 0'
  container.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0) scale(${rect.width / logicalWidth}, ${rect.height / logicalHeight})`
  container.style.clipPath = clipPath
  container.style.zIndex = nodeZIndex === 'auto' ? '1' : nodeZIndex
  container.style.opacity = '1'
  container.style.pointerEvents = 'auto'
}

function watchSurface(panelId: string): void {
  const surface = surfaces.get(panelId)
  if (!surface) return
  surface.cleanup?.()
  surface.cleanup = null
  const slot = slots.get(panelId)
  updateSurface(panelId)
  if (!slot) return

  const schedule = (): void => {
    if (surface.frame !== null) return
    surface.frame = requestAnimationFrame(() => {
      surface.frame = null
      updateSurface(panelId)
    })
  }
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
  resize?.observe(slot)
  const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
    // A new/removed canvas node changes the occlusion set. Rebuild observers so
    // subsequent z-order and geometry changes on the new siblings are tracked.
    if (records.some((record) => record.type === 'childList')) {
      watchSurface(panelId)
      return
    }
    schedule()
  })
  for (let element: HTMLElement | null = slot; element; element = element.parentElement) {
    mutation?.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'aria-hidden'] })
  }
  const node = slot.closest<HTMLElement>('[data-node-id]')
  const nodeLayer = node?.parentElement
  if (nodeLayer) {
    mutation?.observe(nodeLayer, { childList: true })
    for (const sibling of Array.from(nodeLayer.children)) {
      if (!(sibling instanceof HTMLElement) || !sibling.hasAttribute('data-node-id')) continue
      mutation?.observe(sibling, { attributes: true, attributeFilter: ['style', 'class', 'aria-hidden'] })
      resize?.observe(sibling)
    }
  }
  window.addEventListener('resize', schedule)
  window.addEventListener('scroll', schedule, true)
  surface.cleanup = () => {
    resize?.disconnect()
    mutation?.disconnect()
    window.removeEventListener('resize', schedule)
    window.removeEventListener('scroll', schedule, true)
    if (surface.frame !== null) cancelAnimationFrame(surface.frame)
    surface.frame = null
  }
}

function registerSlot(panelId: string, element: HTMLDivElement): void {
  if (slots.get(panelId) === element) return
  slots.set(panelId, element)
  watchSurface(panelId)
}

function unregisterSlot(panelId: string, element: HTMLDivElement): void {
  if (slots.get(panelId) !== element) return
  slots.delete(panelId)
  watchSurface(panelId)
}

export const PersistentBrowserHostContext = createContext(false)

export function registerBrowserSurface(
  panelId: string,
  container: HTMLDivElement,
  backgroundRoot: HTMLDivElement | null,
): () => void {
  const existing = surfaces.get(panelId)
  existing?.cleanup?.()
  if (backgroundRoot && container.parentElement !== backgroundRoot) backgroundRoot.appendChild(container)
  const surface: SurfaceEntry = { container, cleanup: null, frame: null }
  surfaces.set(panelId, surface)
  watchSurface(panelId)
  return () => {
    if (surfaces.get(panelId) !== surface) return
    surface.cleanup?.()
    surfaces.delete(panelId)
  }
}

export function BrowserPanelSurfaceSlot({ panelId }: { panelId: string }): React.ReactElement {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      elementRef.current = element
      registerSlot(panelId, element)
    } else if (elementRef.current) {
      unregisterSlot(panelId, elementRef.current)
      elementRef.current = null
    }
  }, [panelId])

  return <div ref={ref} data-browser-surface-slot={panelId} className="relative h-full w-full" />
}
