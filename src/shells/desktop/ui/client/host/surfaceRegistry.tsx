// Native surfaces (webviews) that must outlive their slot: the persistent host
// renders each once into a container that never moves; the visible view
// contributes only a geometry slot, and this registry aligns the container to
// it every frame (including the canvas transform) or parks it off-screen.

import React, { useCallback, useRef } from 'react'

type PerfCounter = (name: string, amount?: number) => void
let perfCount: PerfCounter = () => {}
let PERF_ENABLED = false

/** The desktop shell's perf HUD counts geometry work through this. */
export function setSurfacePerfCounter(counter: PerfCounter | null): void {
  perfCount = counter ?? (() => {})
  PERF_ENABLED = !!counter
}

const visibilityListeners = new Map<string, Set<() => void>>()

/** Whether the panel's surface is aligned to a visible slot. */
export function isSurfaceVisible(panelId: string): boolean {
  return surfaces.get(panelId)?.container.dataset.browserSurfaceVisible === 'true'
}

export function subscribeSurfaceVisibility(panelId: string, listener: () => void): () => void {
  let set = visibilityListeners.get(panelId)
  if (!set) visibilityListeners.set(panelId, set = new Set())
  set.add(listener)
  return () => {
    set!.delete(listener)
    if (set!.size === 0) visibilityListeners.delete(panelId)
  }
}

function notifyVisibility(panelId: string): void {
  for (const listener of [...(visibilityListeners.get(panelId) ?? [])]) listener()
}

interface SurfaceEntry {
  panelId: string
  container: HTMLDivElement
  styles: Partial<SurfaceStyles>
  backgroundRoot: HTMLDivElement | null
  /** Page operations that need the parked surface rendered (`stageSurface`). */
  staged: number
}

const slots = new Map<string, HTMLDivElement>()
const surfaces = new Map<string, SurfaceEntry>()

function hasSurfaces(): boolean {
  return surfaces.size > 0
}

interface SurfaceRect {
  left: number
  top: number
  right: number
  bottom: number
}

// All surfaces share one read phase per frame. DOM reads are cached before any
// output styles are written, including ancestors shared by different slots.
/** Canvas worlds use scale(zoom) translate(offset / zoom), with origin 0 0.
 * Only that known transform can reuse the previous DOM measurement. */
export interface SurfaceViewport {
  world: HTMLElement
  companions?: HTMLElement[]
  zoom: number
  offset: { x: number; y: number }
}

type GeometryStyle = Pick<CSSStyleDeclaration,
  'display' | 'visibility' | 'opacity' | 'zIndex' | 'overflow' | 'overflowX' | 'overflowY' | 'pointerEvents'
  | 'borderTopWidth' | 'borderRightWidth' | 'borderBottomWidth' | 'borderLeftWidth'
  | 'borderRadius' | 'borderTopLeftRadius' | 'borderTopRightRadius' | 'borderBottomRightRadius' | 'borderBottomLeftRadius'>
const STYLE_PROPERTIES: Array<keyof GeometryStyle> = [
  'display', 'visibility', 'opacity', 'zIndex', 'overflow', 'overflowX', 'overflowY', 'pointerEvents',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
]

function frameGeometry() {
  const rects = new Map<Element, DOMRect>()
  const styles = new Map<Element, GeometryStyle>()
  const sizes = new Map<HTMLElement, { width: number; height: number }>()
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
      const world = element.closest<HTMLElement>('[data-canvas-world], [data-canvas-top-overlay-world], [data-canvas-relation-overlay-world]')
      if (world && world !== element) rect(world)
      else if (world) size(world)
    }
    return rects.get(element)!
  }
  const style = (element: Element): GeometryStyle => {
    if (!styles.has(element)) {
      perfCount('browserGeometryStyle')
      const computed = getComputedStyle(element)
      styles.set(element, Object.fromEntries(STYLE_PROPERTIES.map(key => [key, computed[key]])) as GeometryStyle)
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
  const size = (element: HTMLElement) => {
    if (!sizes.has(element)) sizes.set(element, { width: element.offsetWidth, height: element.offsetHeight })
    return sizes.get(element)!
  }
  const move = (before: SurfaceViewport, after: SurfaceViewport): boolean => {
    let moved = false
    for (const world of [after.world, ...(after.companions ?? [])]) {
      const bounds = rects.get(world)
      if (!bounds) continue
      const logical = size(world)
      if (!logical.width || !logical.height || before.zoom <= 0) return false
      const parentX = bounds.width / logical.width / before.zoom
      const parentY = bounds.height / logical.height / before.zoom
      const originX = bounds.left - before.offset.x * parentX
      const originY = bounds.top - before.offset.y * parentY
      const scale = after.zoom / before.zoom
      for (const [element, boundsOfElement] of rects) {
        if (element !== world && !world.contains(element)) continue
        rects.set(element, new DOMRect(
          originX + after.offset.x * parentX + (boundsOfElement.left - bounds.left) * scale,
          originY + after.offset.y * parentY + (boundsOfElement.top - bounds.top) * scale,
          boundsOfElement.width * scale, boundsOfElement.height * scale,
        ))
      }
      moved = true
    }
    return moved
  }
  return { rect, style, nodes, overlays, size, move }
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
  const border = (side: string): number => Number.parseFloat(style[`border${side[0].toUpperCase()}${side.slice(1)}Width` as keyof GeometryStyle]) || 0
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
  if (container.dataset.browserSurfaceVisible !== String(visible)) {
    container.dataset.browserSurfaceVisible = String(visible)
    notifyVisibility(surface.panelId)
  }
  for (const key of Object.keys(styles) as Array<keyof SurfaceStyles>) {
    const value = styles[key]!
    // Compare requested values; CSSOM normalizes e.g. scale(1, 1) to scale(1).
    if (surface.styles[key] === value) continue
    container.style[key] = value
    surface.styles[key] = value
  }
}

function parkSurface(surface: SurfaceEntry): void {
  // Chromium paints no frames for a guest that is hidden or off screen; a
  // staged one sits in the window, transparent and out of input's way.
  const staged = surface.staged > 0
  writeSurface(surface, false, {
    position: 'fixed', left: staged ? '0' : '-20000px', top: '0', width: surface.styles.width ?? '1200px', height: surface.styles.height ?? '800px',
    transform: 'none', clipPath: 'none', opacity: '0', pointerEvents: 'none', visibility: staged ? 'visible' : 'hidden',
  })
}

/** Renders the panel's surface while it is parked, still unseen, so a page
 *  operation can capture it. Returns the release. */
export function stageSurface(panelId: string): () => void {
  const surface = surfaces.get(panelId)
  if (!surface) return () => {}
  surface.staged++
  if (!isSurfaceVisible(panelId)) parkSurface(surface)
  let released = false
  return () => {
    if (released) return
    released = true
    surface.staged--
    if (surface.staged === 0 && surfaces.get(panelId) === surface && !isSurfaceVisible(panelId)) parkSurface(surface)
  }
}

function measureSurface(panelId: string, geometry: FrameGeometry): () => void {
  const surface = surfaces.get(panelId)
  const slot = slots.get(panelId)
  if (!surface || !slot?.isConnected) {
    return () => { if (surface) parkSurface(surface) }
  }

  const rect = geometry.rect(slot)
  const size = geometry.size(slot)
  const logicalWidth = size.width || rect.width
  const logicalHeight = size.height || rect.height
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
  // The surface sits above the canvas, so it takes input only where its slot
  // would: not while the slot is inert (hand tool) or an unfocused node's
  // overlay covers it. There the press, wheel or drag reaches the canvas, as
  // it does over every other panel.
  const cover = node?.querySelector<HTMLElement>('[data-unfocused-overlay]')
  const inert = geometry.style(slot).pointerEvents === 'none'
    || (!!cover && geometry.style(cover).pointerEvents !== 'none')
  return () => writeSurface(surface, true, {
    visibility: 'visible',
    // Keep layout geometry fixed during canvas gestures. Positioning via the
    // compositor avoids relaying out the guest host for every pan frame.
    position: 'fixed', left: '0px', top: '0px',
    width: `${logicalWidth}px`, height: `${logicalHeight}px`, transformOrigin: '0 0',
    transform: `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / logicalWidth}, ${rect.height / logicalHeight})`,
    borderRadius, overflow: 'hidden',
    clipPath, zIndex: nodeZIndex === 'auto' ? '1' : nodeZIndex,
    opacity: '1', pointerEvents: inert ? 'none' : 'auto',
  })
}

let cachedGeometry: FrameGeometry | null = null
const viewports = new WeakMap<HTMLElement, SurfaceViewport>()
let drainMutations: (() => void) | null = null
let frame: number | null = null
let cleanupTracking: (() => void) | null = null
let rebuildTracking = false
let tracked = new Set<HTMLElement>()
const animatedElements = new Set<Element>()
const geometryAnimations = new Map<Element, Animation[]>()

// Color, shadow and activity-pulse animations must never start a geometry loop.
const GEOMETRY_PROPERTIES = /^(transform|translate|rotate|scale|perspective|offsetPath|offsetDistance|offsetRotate|left|top|right|bottom|width|height|minWidth|maxWidth|minHeight|maxHeight|margin|padding|border.*Width|inset|flex|gap|rowGap|columnGap|grid|fontSize|lineHeight|display|visibility|opacity|clipPath|zIndex)/
function refreshAnimations(): void {
  // WAAPI animations do not emit CSS animation events. Discover relevant ones
  // before reusing geometry, including ones started between input events.
  for (const animation of document.getAnimations?.() ?? []) {
    const effect = animation.effect as KeyframeEffect | null
    const target = effect?.target
    if (!(target instanceof Element) || animation.playState !== 'running') continue
    const keyframes = effect?.getKeyframes() ?? []
    const properties = keyframes.flatMap(keyframe => Object.keys(keyframe)).filter(property => GEOMETRY_PROPERTIES.test(property))
    const affectsLayout = properties.some(property => !/^(transform|translate|rotate|scale|perspective|offset|visibility|opacity|clipPath|zIndex)/.test(property))
    if (properties.length && (affectsLayout || [...tracked].some(element => target === element || target.contains(element)))) {
      animatedElements.add(target)
    }
  }
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
  if (frame !== null || !hasSurfaces()) return
  frame = requestAnimationFrame(() => {
    frame = null
    syncPanelSurfaces()
    if (geometryAnimations.size) schedule()
  })
}

/**
 * Align persistent webview surfaces immediately after an imperative canvas
 * transform. Waiting for MutationObserver -> requestAnimationFrame puts the
 * fixed guest host one paint behind the canvas node that owns its slot.
 */
export function syncPanelSurfaces(viewport?: SurfaceViewport): void {
  const previous = viewport && viewports.get(viewport.world)
  if (viewport) viewports.set(viewport.world, { ...viewport, offset: { ...viewport.offset } })
  if (!hasSurfaces()) return
  const started = PERF_ENABLED ? performance.now() : 0
  drainMutations?.()
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
  const reused = viewport && previous && cachedGeometry && !geometryAnimations.size
    && cachedGeometry.move(previous, viewport)
  if (!reused) cachedGeometry = frameGeometry()
  const geometry = cachedGeometry!
  perfCount(reused ? 'browserGeometryCacheReuse' : 'browserGeometryCacheRebuild')
  const writes = activeIds.map((id) => measureSurface(id, geometry))
  for (const write of writes) write()
  // Animated transforms produce no further mutations or resize notifications.
  for (const [element, animations] of geometryAnimations) {
    if (!animations.some((animation) => animation.playState === 'running')) geometryAnimations.delete(element)
  }
  // The synchronous viewport pass consumed pending invalidations. Do not do
  // the same geometry work again on the next animation frame.
  if (frame !== null) { cancelAnimationFrame(frame); frame = null }
  if (geometryAnimations.size) schedule()
  if (PERF_ENABLED) perfCount('browserGeometryMicros', Math.round((performance.now() - started) * 1000))
}

function watchSurfaces(): void {
  cleanupTracking?.()
  cleanupTracking = null
  rebuildTracking = false
  tracked = new Set()
  animatedElements.clear()
  geometryAnimations.clear()
  if (!hasSurfaces()) {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    return
  }
  const invalidate = () => { cachedGeometry = null; schedule() }
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(invalidate)
  const onMutation = (records: MutationRecord[]) => {
    // Canvas owns these transforms and synchronously aligns the fixed guests.
    // Observing their style/class writes would repeat that work next frame.
    // Child changes still rebuild the tracked node set.
    const pending = records.filter((record) => {
      if (record.type !== 'attributes') return true
      const target = record.target as HTMLElement
      // DOMTokenList and style setters can emit records even when the final
      // attribute is unchanged. Those writes must not enqueue a second pass.
      if (record.attributeName && record.oldValue === target.getAttribute(record.attributeName)) return false
      if (record.attributeName !== 'style') return true
      if (target.hasAttribute('data-canvas-grid')) return false
      if (!target.matches('[data-canvas-world], [data-canvas-top-overlay-world], [data-canvas-relation-overlay-world]')) return true
      // Only the transform is owned by the imperative viewport pipeline. A
      // class, overflow, size or other style change still needs fresh reads.
      const previous = document.createElement('div')
      previous.style.cssText = record.oldValue ?? ''
      previous.style.removeProperty('transform')
      const properties = Array.from(target.style).filter(property => property !== 'transform')
      return properties.length !== previous.style.length || properties.some(property => (
        target.style.getPropertyValue(property) !== previous.style.getPropertyValue(property)
        || target.style.getPropertyPriority(property) !== previous.style.getPropertyPriority(property)
      ))
    })
    if (pending.length === 0) return
    if (pending.some((record) => record.type === 'childList')) rebuildTracking = true
    for (const record of pending) animatedElements.add(record.target as HTMLElement)
    invalidate()
  }
  const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(onMutation)
  const ancestors = new Set<HTMLElement>()
  const activeIds = [...slots.entries()]
    .filter(([id, slot]) => surfaces.has(id) && slot.isConnected)
    .map(([id]) => id)
  const sources = [
    ...activeIds.map(id => slots.get(id)!),
    ...document.querySelectorAll<HTMLElement>('[data-browser-surface-overlay]'),
  ]
  for (const source of sources) {
    for (let element: HTMLElement | null = source; element; element = element.parentElement) {
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
      attributes: true, attributeOldValue: true, childList,
    })
  }
  for (const element of ancestors) observe(element, true)
  for (const element of ancestors) {
    for (const sibling of Array.from(element.parentElement?.children ?? [])) {
      if (sibling instanceof HTMLElement && !outputs.some((output) => sibling.contains(output))) observe(sibling, false)
    }
  }
  // Portals can appear deep in a branch that did not contain a slot when
  // tracking was built. Ignore ordinary terminal/editor content mutations.
  const onStructure = (records: MutationRecord[]) => {
    const relevant = records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node => (
      node instanceof Element && (node.matches('[data-browser-surface-overlay]') || node.querySelector('[data-browser-surface-overlay]'))
    )))
    if (relevant) { rebuildTracking = true; invalidate() }
  }
  const structure = typeof MutationObserver === 'undefined' ? null : new MutationObserver(onStructure)
  structure?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-browser-surface-overlay'] })
  const stylesheet = typeof MutationObserver === 'undefined' ? null : new MutationObserver(invalidate)
  stylesheet?.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true })
  drainMutations = () => {
    if (mutation) onMutation(mutation.takeRecords())
    if (structure) onStructure(structure.takeRecords())
    if (stylesheet?.takeRecords().length) invalidate()
  }
  const onStylesheetLoad = (event: Event): void => {
    if (event.target instanceof HTMLLinkElement && event.target.rel === 'stylesheet') invalidate()
  }
  window.addEventListener('load', onStylesheetLoad, true)
  // Pseudo-class rules can change source geometry without a style mutation.
  const interactionEvents = ['focusin', 'focusout', 'pointerover', 'pointerout']
  const onInteraction = (event: Event): void => {
    if (event.target instanceof Element) invalidate()
  }
  for (const event of interactionEvents) window.addEventListener(event, onInteraction, true)
  const onAnimation = (event: Event): void => {
    const element = event.target as HTMLElement
    if (!tracked.has(element)) return
    animatedElements.add(element)
    invalidate()
  }
  const animationEvents = ['transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel']
  for (const event of animationEvents) window.addEventListener(event, onAnimation, true)
  window.addEventListener('resize', invalidate)
  window.addEventListener('scroll', invalidate, true)
  cleanupTracking = () => {
    resize?.disconnect()
    mutation?.disconnect()
    structure?.disconnect()
    stylesheet?.disconnect()
    window.removeEventListener('load', onStylesheetLoad, true)
    for (const event of interactionEvents) window.removeEventListener(event, onInteraction, true)
    for (const event of animationEvents) window.removeEventListener(event, onAnimation, true)
    window.removeEventListener('resize', invalidate)
    window.removeEventListener('scroll', invalidate, true)
    drainMutations = null
    cachedGeometry = null
  }
}

function refreshSurfaces(panelId: string): void {
  // Hide removed/new slots immediately, but measure all incoming slots together
  // before the next paint. Per-slot reads here bypassed the shared frame cache.
  const surface = surfaces.get(panelId)
  if (surface && (!slots.has(panelId) || !surface.styles.width)) parkSurface(surface)
  rebuildTracking = true
  cachedGeometry = null
  if (!hasSurfaces()) watchSurfaces()
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

export function registerPanelSurface(
  panelId: string,
  container: HTMLDivElement,
  backgroundRoot: HTMLDivElement | null,
): () => void {
  if (backgroundRoot && container.parentElement !== backgroundRoot) backgroundRoot.appendChild(container)
  const surface: SurfaceEntry = { panelId, container, styles: {}, backgroundRoot, staged: 0 }
  surfaces.set(panelId, surface)
  refreshSurfaces(panelId)
  return () => {
    if (surfaces.get(panelId) !== surface) return
    surfaces.delete(panelId)
    refreshSurfaces(panelId)
  }
}

export function PanelSurfaceSlot({ panelId }: { panelId: string }): React.ReactElement {
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
