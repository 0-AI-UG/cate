import React, { createContext, useCallback, useRef } from 'react'
import { PERF_ENABLED, perfCount } from '../lib/perf/perfClient'

interface SurfaceEntry {
  container: HTMLDivElement
  styles: Partial<SurfaceStyles>
}

const slots = new Map<string, HTMLDivElement>()
const surfaces = new Map<string, SurfaceEntry>()

interface SurfaceRect {
  left: number
  top: number
  right: number
  bottom: number
}

// All surfaces share one read phase per frame. DOM reads are cached before any
// output styles are written, including ancestors shared by different slots.
function frameGeometry() {
  const rects = new Map<Element, DOMRect>()
  const styles = new Map<Element, CSSStyleDeclaration>()
  const layers = new Map<Element, Array<{ element: HTMLElement; z: number }>>()
  const overlays = new Map<string, HTMLElement[]>()
  for (const element of document.querySelectorAll<HTMLElement>('[data-browser-surface-overlay]')) {
    const panelId = element.dataset.browserSurfaceOverlay
    if (!panelId) continue
    const entries = overlays.get(panelId)
    if (entries) entries.push(element)
    else overlays.set(panelId, [element])
  }
  const rect = (element: Element): DOMRect => {
    if (!rects.has(element)) {
      perfCount('browserGeometryRect')
      rects.set(element, element.getBoundingClientRect())
    }
    return rects.get(element)!
  }
  const style = (element: Element): CSSStyleDeclaration => {
    if (!styles.has(element)) {
      perfCount('browserGeometryStyle')
      styles.set(element, getComputedStyle(element))
    }
    return styles.get(element)!
  }
  const nodes = (layer: Element) => {
    if (!layers.has(layer)) {
      const entries = Array.from(layer.children).flatMap((element) => {
        if (!(element instanceof HTMLElement) || !element.hasAttribute('data-node-id')) return []
        const css = style(element)
        if (css.display === 'none' || css.visibility === 'hidden' || Number.parseFloat(css.opacity || '1') <= 0) return []
        return [{ element, z: Number.parseFloat(css.zIndex) }]
      })
      layers.set(layer, entries)
    }
    return layers.get(layer)!
  }
  return { rect, style, nodes, overlays }
}
type FrameGeometry = ReturnType<typeof frameGeometry>

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

function clippingRect(slot: HTMLElement, rect: DOMRect, geometry: FrameGeometry): SurfaceRect | null {
  let visible: SurfaceRect | null = intersectRects(rect, {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  })
  for (let element = slot.parentElement; visible && element; element = element.parentElement) {
    const style = geometry.style(element)
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
    const ancestor = geometry.rect(element)
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

function surfaceBorderRadius(slot: HTMLElement, rect: DOMRect, scale: number, geometry: FrameGeometry): string {
  const node = slot.closest<HTMLElement>('[data-node-id]')
  if (!node) return '0px'
  const bounds = geometry.rect(node)
  const style = geometry.style(node)
  const border = (side: string): number => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0
  const left = Math.abs((rect.left - bounds.left) / scale - border('left')) < 1
  const right = Math.abs((bounds.right - rect.right) / scale - border('right')) < 1
  const top = Math.abs((rect.top - bounds.top) / scale - border('top')) < 1
  const bottom = Math.abs((bounds.bottom - rect.bottom) / scale - border('bottom')) < 1
  const corner = (touches: boolean, radius: string, a: string, b: string): string => (
    `${cssNumber(touches ? Math.max(0, (Number.parseFloat(radius) || 0) - Math.max(border(a), border(b))) : 0)}px`
  )
  return [
    corner(top && left, style.borderTopLeftRadius || style.borderRadius, 'top', 'left'),
    corner(top && right, style.borderTopRightRadius || style.borderRadius, 'top', 'right'),
    corner(bottom && right, style.borderBottomRightRadius || style.borderRadius, 'bottom', 'right'),
    corner(bottom && left, style.borderBottomLeftRadius || style.borderRadius, 'bottom', 'left'),
  ].join(' ')
}

function surfaceClipPath(
  panelId: string,
  slot: HTMLElement,
  rect: DOMRect,
  logicalWidth: number,
  logicalHeight: number,
  geometry: FrameGeometry,
): string | null {
  const visible = clippingRect(slot, rect, geometry)
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
  const nodeZIndex = node ? Number.parseFloat(geometry.style(node).zIndex) : Number.NaN
  const nodeOccluders = nodeLayer && Number.isFinite(nodeZIndex)
    ? geometry.nodes(nodeLayer)
      .filter((entry) => entry.element !== node && entry.z > nodeZIndex)
      .map((entry) => intersectRects(visible, geometry.rect(entry.element)))
      .filter((value): value is SurfaceRect => value !== null)
      .map(local)
    : []

  // Every cutout uses the same subtraction: overlapping even-odd holes would
  // paint the browser again in their intersection.
  const occluders: SurfaceRect[] = []
  const addOccluder = (hole: SurfaceRect): void => {
    let remaining = [hole]
    for (const existing of occluders) {
      remaining = remaining.flatMap((part) => {
        const overlap = intersectRects(part, existing)
        if (!overlap) return [part]
        return [
          { ...part, bottom: overlap.top },
          { ...part, top: overlap.bottom },
          { left: part.left, right: overlap.left, top: overlap.top, bottom: overlap.bottom },
          { left: overlap.right, right: part.right, top: overlap.top, bottom: overlap.bottom },
        ].filter((piece) => piece.right > piece.left && piece.bottom > piece.top)
      })
    }
    occluders.push(...remaining)
  }
  nodeOccluders.forEach(addOccluder)
  // Dock chrome lives in the slot's stacking context, outside the guest host.
  for (const overlay of geometry.overlays.get(panelId) ?? []) {
    if (geometry.style(overlay).visibility === 'hidden') continue
    const hole = intersectRects(visible, geometry.rect(overlay))
    if (hole) addOccluder(local(hole))
  }

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

type SurfaceStyles = Pick<CSSStyleDeclaration,
  'position' | 'left' | 'top' | 'width' | 'height' | 'transform' | 'transformOrigin'
  | 'clipPath' | 'opacity' | 'pointerEvents' | 'zIndex' | 'visibility' | 'borderRadius' | 'overflow'>

function writeSurface(surface: SurfaceEntry, visible: boolean, styles: Partial<SurfaceStyles>): void {
  const { container } = surface
  if (container.dataset.browserSurfaceVisible !== String(visible)) container.dataset.browserSurfaceVisible = String(visible)
  for (const key of Object.keys(styles) as Array<keyof SurfaceStyles>) {
    const value = styles[key]!
    // Compare requested values; CSSOM normalizes e.g. scale(1, 1) to scale(1).
    if (surface.styles[key] === value) continue
    container.style[key] = value
    surface.styles[key] = value
  }
}

function parkSurface(surface: SurfaceEntry): void {
  writeSurface(surface, false, {
    position: 'fixed', left: '-20000px', top: '0', width: surface.styles.width ?? '1200px', height: surface.styles.height ?? '800px',
    transform: 'none', clipPath: 'none', opacity: '0', pointerEvents: 'none', visibility: 'hidden',
  })
}

function measureSurface(panelId: string, geometry: FrameGeometry): () => void {
  const surface = surfaces.get(panelId)
  const slot = slots.get(panelId)
  if (!surface || !slot?.isConnected) {
    return () => { if (surface) parkSurface(surface) }
  }

  const rect = geometry.rect(slot)
  const logicalWidth = slot.offsetWidth || rect.width
  const logicalHeight = slot.offsetHeight || rect.height
  const visible = rect.width > 0
    && rect.height > 0
    && geometry.style(slot).visibility !== 'hidden'
  if (!visible || logicalWidth <= 0 || logicalHeight <= 0) {
    return () => parkSurface(surface)
  }

  const clipPath = surfaceClipPath(panelId, slot, rect, logicalWidth, logicalHeight, geometry)
  if (!clipPath) {
    return () => parkSurface(surface)
  }

  const node = slot.closest<HTMLElement>('[data-node-id]')
  const nodeZIndex = node ? geometry.style(node).zIndex : 'auto'
  const borderRadius = surfaceBorderRadius(slot, rect, rect.width / logicalWidth, geometry)
  return () => writeSurface(surface, true, {
    visibility: 'visible',
    position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
    width: `${logicalWidth}px`, height: `${logicalHeight}px`, transformOrigin: '0 0',
    transform: `scale(${rect.width / logicalWidth}, ${rect.height / logicalHeight})`,
    borderRadius, overflow: 'hidden',
    clipPath, zIndex: nodeZIndex === 'auto' ? '1' : nodeZIndex,
    opacity: '1', pointerEvents: 'auto',
  })
}

let frame: number | null = null
let cleanupTracking: (() => void) | null = null
let rebuildTracking = false
let tracked = new Set<HTMLElement>()
const animatedElements = new Set<HTMLElement>()
const geometryAnimations = new Map<HTMLElement, Animation[]>()

// Color, shadow and activity-pulse animations must never start a geometry loop.
const GEOMETRY_PROPERTIES = /^(transform|translate|rotate|scale|perspective|offsetPath|offsetDistance|offsetRotate|left|top|right|bottom|width|height|minWidth|maxWidth|minHeight|maxHeight|margin|padding|border.*Width|inset|flex|gap|rowGap|columnGap|grid|fontSize|lineHeight|display|visibility|opacity|clipPath|zIndex)/
function refreshAnimations(): void {
  for (const element of animatedElements) {
    const animations = (element.getAnimations?.() ?? []).filter((animation) => (
      animation.playState === 'running'
      && (animation.effect as KeyframeEffect | null)?.getKeyframes().some((keyframe) => (
        Object.keys(keyframe).some((property) => GEOMETRY_PROPERTIES.test(property))
      ))
    ))
    if (animations.length) geometryAnimations.set(element, animations)
    else geometryAnimations.delete(element)
  }
  animatedElements.clear()
}

function schedule(): void {
  if (frame !== null || surfaces.size === 0) return
  frame = requestAnimationFrame(() => {
    frame = null
    syncBrowserSurfaces()
    if (geometryAnimations.size) schedule()
  })
}

/**
 * Align persistent webview surfaces immediately after an imperative canvas
 * transform. Waiting for MutationObserver -> requestAnimationFrame puts the
 * fixed guest host one paint behind the canvas node that owns its slot.
 */
export function syncBrowserSurfaces(): void {
  if (surfaces.size === 0) return
  const started = PERF_ENABLED ? performance.now() : 0
  if (rebuildTracking) watchSurfaces()
  refreshAnimations()
  // Background-workspace guests deliberately stay mounted so CLI/agent
  // control keeps their exact webContents and page state. They have no live
  // geometry slot, though, and are already parked by unregisterSlot. Exclude
  // them from the layout pass without changing their lifecycle.
  const activeIds = [...slots.entries()]
    .filter(([id, slot]) => surfaces.has(id) && slot.isConnected)
    .map(([id]) => id)
  if (activeIds.length === 0) {
    geometryAnimations.clear()
    return
  }
  perfCount('browserGeometryFrame')
  const geometry = frameGeometry()
  const writes = activeIds.map((id) => measureSurface(id, geometry))
  for (const write of writes) write()
  // Animated transforms produce no further mutations or resize notifications.
  for (const [element, animations] of geometryAnimations) {
    if (!animations.some((animation) => animation.playState === 'running')) geometryAnimations.delete(element)
  }
  if (PERF_ENABLED) perfCount('browserGeometryMicros', Math.round((performance.now() - started) * 1000))
}

function watchSurfaces(): void {
  cleanupTracking?.()
  cleanupTracking = null
  rebuildTracking = false
  tracked = new Set()
  animatedElements.clear()
  geometryAnimations.clear()
  if (surfaces.size === 0) {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    return
  }
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
  const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
    // Canvas owns these transforms and synchronously aligns the fixed guests.
    // Observing their style/class writes would repeat that work next frame.
    // Child changes still rebuild the tracked node set.
    const pending = records.filter((record) => record.type === 'childList' || !(
      (record.target as HTMLElement).hasAttribute('data-canvas-world')
      || (record.target as HTMLElement).hasAttribute('data-canvas-top-overlay-world')
      || (record.target as HTMLElement).hasAttribute('data-canvas-grid')
    ))
    if (pending.length === 0) return
    if (pending.some((record) => record.type === 'childList')) rebuildTracking = true
    for (const record of pending) animatedElements.add(record.target as HTMLElement)
    schedule()
  })
  const ancestors = new Set<HTMLElement>()
  const activeIds = [...slots.entries()]
    .filter(([id, slot]) => surfaces.has(id) && slot.isConnected)
    .map(([id]) => id)
  for (const id of activeIds) {
    for (let element: HTMLElement | null = slots.get(id) ?? null; element; element = element.parentElement) {
      if (ancestors.has(element)) break
      ancestors.add(element)
    }
  }
  const outputs = activeIds.map((id) => surfaces.get(id)!.container)
  const observe = (element: HTMLElement, childList: boolean): void => {
    if (tracked.has(element)) return
    tracked.add(element)
    animatedElements.add(element)
    resize?.observe(element)
    mutation?.observe(element, {
      attributes: true, attributeFilter: ['style', 'class', 'aria-hidden', 'hidden'], childList,
    })
  }
  for (const element of ancestors) observe(element, true)
  for (const element of ancestors) {
    for (const sibling of Array.from(element.parentElement?.children ?? [])) {
      if (sibling instanceof HTMLElement && !outputs.some((output) => sibling.contains(output))) observe(sibling, false)
    }
  }
  const onAnimation = (event: Event): void => {
    const element = event.target as HTMLElement
    if (!tracked.has(element)) return
    animatedElements.add(element)
    schedule()
  }
  const animationEvents = ['transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel']
  for (const event of animationEvents) window.addEventListener(event, onAnimation, true)
  window.addEventListener('resize', schedule)
  window.addEventListener('scroll', schedule, true)
  cleanupTracking = () => {
    resize?.disconnect()
    mutation?.disconnect()
    for (const event of animationEvents) window.removeEventListener(event, onAnimation, true)
    window.removeEventListener('resize', schedule)
    window.removeEventListener('scroll', schedule, true)
  }
}

function refreshSurfaces(panelId: string): void {
  // Hide removed/new slots immediately, but measure all incoming slots together
  // before the next paint. Per-slot reads here bypassed the shared frame cache.
  const surface = surfaces.get(panelId)
  if (surface && (!slots.has(panelId) || !surface.styles.width)) parkSurface(surface)
  rebuildTracking = true
  if (surfaces.size === 0) watchSurfaces()
  else schedule()
}

function registerSlot(panelId: string, element: HTMLDivElement): void {
  if (slots.get(panelId) === element) return
  slots.set(panelId, element)
  refreshSurfaces(panelId)
}

function unregisterSlot(panelId: string, element: HTMLDivElement): void {
  if (slots.get(panelId) !== element) return
  slots.delete(panelId)
  refreshSurfaces(panelId)
}

export const PersistentBrowserHostContext = createContext(false)

export function registerBrowserSurface(
  panelId: string,
  container: HTMLDivElement,
  backgroundRoot: HTMLDivElement | null,
): () => void {
  if (backgroundRoot && container.parentElement !== backgroundRoot) backgroundRoot.appendChild(container)
  const surface: SurfaceEntry = { container, styles: {} }
  surfaces.set(panelId, surface)
  refreshSurfaces(panelId)
  return () => {
    if (surfaces.get(panelId) !== surface) return
    surfaces.delete(panelId)
    refreshSurfaces(panelId)
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
