import React, { createContext, useCallback, useRef } from 'react'

interface SurfaceEntry {
  container: HTMLDivElement
  cleanup: (() => void) | null
  frame: number | null
}

const slots = new Map<string, HTMLDivElement>()
const surfaces = new Map<string, SurfaceEntry>()

function parkSurface(surface: SurfaceEntry): void {
  const { container } = surface
  container.dataset.browserSurfaceVisible = 'false'
  container.style.position = 'fixed'
  container.style.left = '-20000px'
  container.style.top = '0'
  container.style.width = '1200px'
  container.style.height = '800px'
  container.style.transform = 'none'
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
  const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule)
  for (let element: HTMLElement | null = slot; element; element = element.parentElement) {
    mutation?.observe(element, { attributes: true, attributeFilter: ['style', 'class', 'aria-hidden'] })
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
