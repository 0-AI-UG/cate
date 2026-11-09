import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelSurfaceSlot, registerPanelSurface, syncPanelSurfaces } from './surfaceRegistry'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let surface: HTMLDivElement
let root: Root
let cleanup: () => void
let rect: DOMRect
let frames: Map<number, FrameRequestCallback>
let observers: Array<{ targets: Set<Element>; callback: ResizeObserverCallback }>

async function frame() {
  await act(async () => { await Promise.resolve() })
  const pending = [...frames.values()]
  frames.clear()
  act(() => pending.forEach((callback) => callback(0)))
}

beforeEach(() => {
  frames = new Map()
  observers = []
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (frameId: number) => frames.delete(frameId))
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    constructor(public callback: ResizeObserverCallback) { observers.push(this) }
    observe(element: Element) { this.targets.add(element) }
    disconnect() { this.targets.clear() }
  })
  host = document.createElement('div')
  surface = document.createElement('div')
  document.body.append(host, surface)
  root = createRoot(host)
  act(() => root.render(<div data-layout><aside /><main><PanelSurfaceSlot panelId="browser" /></main></div>))
  const slot = host.querySelector<HTMLElement>('[data-browser-surface-slot]')!
  rect = new DOMRect(100, 40, 300, 200)
  vi.spyOn(slot, 'getBoundingClientRect').mockImplementation(() => rect)
  Object.defineProperties(slot, {
    offsetWidth: { get: () => 300 },
    offsetHeight: { get: () => 200 },
  })
  cleanup = registerPanelSurface('browser', surface, null)
})

afterEach(() => {
  cleanup()
  act(() => root.unmount())
  host.remove()
  surface.remove()
  vi.unstubAllGlobals()
})

describe('browser surface layout tracking', () => {
  it('moves cached portal cutouts with their companion viewport world', () => {
    const world = host.querySelector<HTMLElement>('main')!
    world.dataset.canvasWorld = ''
    vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1, 1))
    Object.defineProperties(world, { offsetWidth: { get: () => 1 }, offsetHeight: { get: () => 1 } })
    const companion = document.createElement('div')
    companion.dataset.canvasTopOverlayWorld = ''
    const overlay = document.createElement('div')
    overlay.dataset.browserSurfaceOverlay = 'browser'
    companion.append(overlay)
    document.body.append(companion)
    vi.spyOn(companion, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1, 1))
    Object.defineProperties(companion, { offsetWidth: { get: () => 1 }, offsetHeight: { get: () => 1 } })
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 60, 40, 20))
    try {
      syncPanelSurfaces({ world, companions: [companion], zoom: 1, offset: { x: 0, y: 0 } })
      const clip = surface.style.clipPath
      const styles = vi.spyOn(window, 'getComputedStyle')
      styles.mockClear()
      syncPanelSurfaces({ world, companions: [companion], zoom: .5, offset: { x: 10, y: 5 } })
      expect(surface.style.transform).toBe('translate(60px, 25px) scale(0.5, 0.5)')
      expect(surface.style.clipPath).toBe(clip)
      expect(styles).not.toHaveBeenCalled()
    } finally { companion.remove() }
  })

  it('derives pan and zoom from cached geometry and invalidates before a structural change', () => {
    act(() => root.render(<main style={{ overflow: 'hidden' }}><div data-canvas-world style={{ width: 1, height: 1 }}>
      <div data-node-id="browser" style={{ zIndex: 1 }}><PanelSurfaceSlot panelId="browser" /></div>
      <div data-node-id="other" style={{ zIndex: 2 }} />
    </div></main>))
    const world = host.querySelector<HTMLElement>('[data-canvas-world]')!
    const slot = host.querySelector<HTMLElement>('[data-browser-surface-slot]')!
    const other = host.querySelector<HTMLElement>('[data-node-id="other"]')!
    const bounds = new Map<Element, DOMRect>([
      [host.querySelector('main')!, new DOMRect(50, 20, 500, 400)],
      [world, new DOMRect(50, 20, 1, 1)],
      [slot.parentElement!, new DOMRect(70, 40, 300, 230)],
      [slot, new DOMRect(70, 70, 300, 200)],
      [other, new DOMRect(220, 120, 100, 100)],
    ])
    const reads = [...bounds.keys()].map(element => vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => bounds.get(element)!))
    Object.defineProperties(world, { offsetWidth: { get: () => 1 }, offsetHeight: { get: () => 1 } })
    Object.defineProperties(slot, { offsetWidth: { get: () => 300 }, offsetHeight: { get: () => 200 } })
    syncPanelSurfaces({ world, zoom: 1, offset: { x: 0, y: 0 } })
    reads.forEach(read => read.mockClear())
    const styles = vi.spyOn(window, 'getComputedStyle')

    world.style.transform = 'scale(.5) translate(40px,20px)'
    syncPanelSurfaces({ world, zoom: .5, offset: { x: 20, y: 10 } })

    expect(surface.style.transform).toBe('translate(80px, 55px) scale(0.5, 0.5)')
    expect(surface.style.clipPath).toContain('M 150 50 H 250 V 150 H 150 Z')
    expect(styles).not.toHaveBeenCalled()
    expect(reads.every(read => read.mock.calls.length === 0)).toBe(true)

    bounds.set(world, new DOMRect(70, 30, .5, .5))
    bounds.set(slot.parentElement!, new DOMRect(80, 40, 150, 115))
    bounds.set(slot, new DOMRect(80, 55, 150, 100))
    bounds.set(other, new DOMRect(180, 80, 50, 50))
    other.style.left = '260px'
    // Mutations are consumed synchronously, before their observer callback.
    syncPanelSurfaces({ world, zoom: .5, offset: { x: 20, y: 10 } })
    expect(styles).toHaveBeenCalled()
    expect(surface.style.clipPath).toContain('M 200 50 H 300 V 150 H 200 Z')
  })

  function cachedViewport() {
    const world = host.querySelector<HTMLElement>('main')!
    world.dataset.canvasWorld = ''
    vi.spyOn(world, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1, 1))
    Object.defineProperties(world, { offsetWidth: { get: () => 1 }, offsetHeight: { get: () => 1 } })
    const viewport = { world, zoom: 1, offset: { x: 0, y: 0 } }
    syncPanelSurfaces(viewport)
    return viewport
  }

  it('recomputes viewport-edge clipping from cached rectangles through repeated zoom and pan', () => {
    const viewport = cachedViewport()
    const slot = host.querySelector<HTMLElement>('[data-browser-surface-slot]')!
    vi.mocked(slot.getBoundingClientRect).mockClear()
    syncPanelSurfaces({ ...viewport, offset: { x: -150, y: 0 } })
    expect(surface.style.transform).toBe('translate(-50px, 40px) scale(1, 1)')
    expect(surface.style.clipPath).toBe('inset(0px 0px 0px 50px)')
    syncPanelSurfaces({ ...viewport, zoom: .5, offset: { x: -150, y: 0 } })
    expect(surface.style.transform).toBe('translate(-100px, 20px) scale(0.5, 0.5)')
    expect(surface.style.clipPath).toBe('inset(0px 0px 0px 200px)')
    syncPanelSurfaces(viewport)
    expect(surface.style.transform).toBe('translate(100px, 40px) scale(1, 1)')
    expect(surface.style.clipPath).toBe('inset(0px 0px 0px 0px)')
    expect(slot.getBoundingClientRect).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })

  it('discovers portal overlays inserted into an untracked subtree before the next input frame', () => {
    const portal = document.createElement('div')
    portal.innerHTML = '<div><div></div></div>'
    document.body.append(portal)
    try {
      const viewport = cachedViewport()
      const overlay = document.createElement('div')
      overlay.dataset.browserSurfaceOverlay = 'browser'
      vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(120, 60, 40, 20))
      portal.firstElementChild!.firstElementChild!.append(overlay)
      syncPanelSurfaces(viewport)
      expect(surface.style.clipPath).toContain('M 20 20 H 60 V 40 H 20 Z')
      overlay.style.visibility = 'hidden'
      syncPanelSurfaces(viewport)
      expect(surface.style.clipPath).toBe('inset(0px 0px 0px 0px)')
    } finally { portal.remove() }
  })

  it('ignores no-op canvas class mutations after direct sync but observes real class changes', async () => {
    const viewport = cachedViewport()
    viewport.world.classList.add('canvas-world-moving')
    syncPanelSurfaces(viewport)
    const slot = host.querySelector<HTMLElement>('[data-browser-surface-slot]')!
    vi.mocked(slot.getBoundingClientRect).mockClear()
    viewport.world.classList.add('canvas-world-moving')
    await Promise.resolve() // Real MutationObserver delivery, not a mock.
    expect(frames.size).toBe(0)
    syncPanelSurfaces(viewport)
    expect(slot.getBoundingClientRect).not.toHaveBeenCalled()
    rect = new DOMRect(180, 80, 300, 200)
    viewport.world.classList.add('layout-changed')
    await Promise.resolve()
    expect(frames.size).toBe(1)
    await frame()
    expect(surface.style.transform).toContain('translate(180px, 80px)')
    expect(slot.getBoundingClientRect).toHaveBeenCalledTimes(1)
  })

  it('invalidates selector-driven data attribute changes on source ancestors', () => {
    const viewport = cachedViewport()
    rect = new DOMRect(160, 90, 300, 200)
    viewport.world.dataset.layout = 'compact'
    syncPanelSurfaces(viewport)
    expect(surface.style.transform).toContain('translate(160px, 90px)')
  })

  it('invalidates ancestor clipping changes while keeping transform-only moves cached', () => {
    const viewport = cachedViewport()
    viewport.world.style.overflow = 'hidden'
    vi.mocked(viewport.world.getBoundingClientRect).mockReturnValue(new DOMRect(100, 40, 100, 80))
    syncPanelSurfaces(viewport)
    expect(surface.style.clipPath).toBe('inset(0px 200px 120px 0px)')
    viewport.world.style.overflow = 'visible'
    syncPanelSurfaces(viewport)
    expect(surface.style.clipPath).toBe('inset(0px 0px 0px 0px)')
  })

  it('refreshes cached geometry after stylesheet edits and source reparenting', () => {
    const viewport = cachedViewport()
    const stylesheet = document.createElement('style')
    try {
      document.head.append(stylesheet)
      rect = new DOMRect(150, 60, 300, 200)
      syncPanelSurfaces(viewport)
      expect(surface.style.transform).toContain('translate(150px, 60px)')
      const wrapper = document.createElement('section')
      viewport.world.append(wrapper)
      wrapper.append(host.querySelector('[data-browser-surface-slot]')!)
      rect = new DOMRect(170, 70, 300, 200)
      syncPanelSurfaces(viewport)
      expect(surface.style.transform).toContain('translate(170px, 70px)')
    } finally { stylesheet.remove() }
  })

  it('invalidates geometry when an untracked descendant changes ancestor focus state', () => {
    const input = document.createElement('textarea')
    const branch = document.createElement('div')
    branch.append(input)
    host.querySelector('main')!.append(branch)
    const viewport = cachedViewport()
    rect = new DOMRect(180, 80, 300, 200)
    input.dispatchEvent(new Event('focusin', { bubbles: true }))
    syncPanelSurfaces(viewport)
    expect(surface.style.transform).toContain('translate(180px, 80px)')
  })

  it('does not reuse geometry during WAAPI transforms started without CSS events', async () => {
    const viewport = cachedViewport()
    const animation = {
      playState: 'running',
      effect: { target: viewport.world, getKeyframes: () => [{ transform: 'scale(1)' }] },
    }
    Object.assign(viewport.world, { getAnimations: () => [animation] })
    Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => [animation] })
    try {
      rect = new DOMRect(120, 60, 240, 160)
      syncPanelSurfaces(viewport)
      expect(surface.style.transform).toBe('translate(120px, 60px) scale(0.8, 0.8)')
      rect = new DOMRect(140, 70, 150, 100)
      animation.playState = 'finished'
      syncPanelSurfaces(viewport)
      expect(surface.style.transform).toBe('translate(140px, 70px) scale(0.5, 0.5)')
      await frame()
      expect(frames.size).toBe(0)
    } finally { Reflect.deleteProperty(document, 'getAnimations') }
  })

  it('subtracts overlapping canvas occluders without reopening their intersection', async () => {
    const node = host.querySelector('main')!
    node.dataset.nodeId = 'browser-node'
    node.style.zIndex = '1'
    const rectangles = [new DOMRect(110, 50, 80, 80), new DOMRect(130, 70, 20, 20)]
    const occluders = rectangles.map((bounds, index) => {
      const other = document.createElement('div')
      other.dataset.nodeId = `other-${index}`
      other.style.zIndex = String(index + 2)
      vi.spyOn(other, 'getBoundingClientRect').mockReturnValue(bounds)
      node.parentElement!.append(other)
      return other
    })
    await frame()
    expect(surface.style.clipPath).toBe('path(evenodd, "M 0 0 H 300 V 200 H 0 Z M 10 10 H 90 V 90 H 10 Z")')
    occluders.forEach((element) => element.remove())
  })

  it('leaves panel chrome clickable above a scaled persistent guest', async () => {
    const overlay = document.createElement('div')
    overlay.dataset.browserSurfaceOverlay = 'browser'
    host.querySelector('main')!.append(overlay)
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 45, 40, 10))
    rect = new DOMRect(100, 40, 150, 100)
    await frame()
    expect(surface.style.clipPath).toBe('path(evenodd, "M 0 0 H 300 V 200 H 0 Z M 200 10 H 280 V 30 H 200 Z")')
    const overlapping = overlay.cloneNode() as HTMLElement
    vi.spyOn(overlapping, 'getBoundingClientRect').mockReturnValue(new DOMRect(210, 45, 20, 10))
    overlay.parentElement!.append(overlapping)
    await frame()
    // An overlapping cutout must not turn the guest back on in the overlap.
    expect(surface.style.clipPath).toBe('path(evenodd, "M 0 0 H 300 V 200 H 0 Z M 200 10 H 280 V 30 H 200 Z")')
    overlapping.remove()
    overlay.remove()
    await frame()
    expect(surface.style.clipPath).toBe('inset(0px 0px 0px 0px)')
  })

  it('follows sidebar-driven ancestor resize while the slot size stays unchanged', async () => {
    await frame()
    rect = new DOMRect(250, 40, 300, 200)
    const ancestor = host.querySelector('main')!
    const watching = observers.filter((observer) => observer.targets.has(ancestor))
    expect(watching).toHaveLength(1)
    watching.forEach((observer) => observer.callback([], {} as ResizeObserver))
    await frame()
    expect(surface.style.left).toBe('0px')
    expect(surface.style.transform).toBe('translate(250px, 40px) scale(1, 1)')
    expect(surface.style.width).toBe('300px')
  })

  it('can align a canvas-driven surface before the next animation frame', async () => {
    await frame()
    rect = new DOMRect(180, 70, 240, 160)
    const transformed = host.querySelector('main')!
    transformed.dataset.canvasWorld = ''
    transformed.style.transform = 'translate(80px, 30px)'
    const grid = host.querySelector('aside')!
    grid.dataset.canvasGrid = ''
    grid.style.backgroundPosition = '80px 30px'

    syncPanelSurfaces()
    await Promise.resolve()

    expect(surface.style.transform).toContain('translate(180px, 70px)')
    expect(surface.style.transform).toContain('translate(180px, 70px)')
    expect(surface.style.transform).toContain('scale(0.8, 0.8)')
    expect(frames.size).toBe(0)
  })

  it('follows sibling layout changes and ancestor child insertion', async () => {
    await frame()
    rect = new DOMRect(60, 70, 300, 200)
    host.querySelector('aside')!.style.width = '60px'
    await frame()
    expect(surface.style.transform).toContain('translate(60px, 70px)')
    rect = new DOMRect(60, 100, 300, 200)
    host.querySelector('[data-layout]')!.prepend(document.createElement('header'))
    await frame()
    expect(surface.style.transform).toContain('translate(60px, 100px)')
  })

  it('tracks animated transforms through the final frame without more DOM mutations', async () => {
    await frame()
    const ancestor = host.querySelector('main')!
    const animation = { playState: 'running', effect: { getKeyframes: () => [{ transform: 'scale(1)' }] } }
    Object.assign(ancestor, { getAnimations: () => [animation] })
    ancestor.dispatchEvent(new Event('transitionrun', { bubbles: true }))
    rect = new DOMRect(120, 50, 240, 160)
    await frame()
    expect(surface.style.transform).toContain('scale(0.8, 0.8)')
    expect(frames.size).toBe(1)
    rect = new DOMRect(150, 60, 150, 100)
    animation.playState = 'finished'
    await frame()
    expect(surface.style.transform).toContain('translate(150px, 60px)')
    expect(surface.style.transform).toContain('scale(0.5, 0.5)')
    expect(frames.size).toBe(0)
  })

  it('does not poll layout for decorative activity pulses', async () => {
    await frame()
    const ancestor = host.querySelector('main')!
    const getAnimations = vi.fn(() => [{ playState: 'running', effect: { getKeyframes: () => [{ offset: 0, computedOffset: 0, easing: 'linear', outlineColor: 'red' }] } }])
    Object.assign(ancestor, { getAnimations })
    ancestor.dispatchEvent(new Event('animationstart', { bubbles: true }))
    await frame()
    expect(getAnimations).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
  })

  it('shares observers and layout reads across eight surfaces, with no idle writes', async () => {
    const ids = ['browser', ...Array.from({ length: 7 }, (_, i) => `extra-${i}`)]
    act(() => root.render(<main style={{ overflow: 'hidden' }}>{ids.map((id, i) => (
      <div key={id} data-node-id={id} style={{ zIndex: i + 1 }}><PanelSurfaceSlot panelId={id} /></div>
    ))}</main>))
    for (const element of host.querySelectorAll<HTMLElement>('main, [data-node-id], [data-browser-surface-slot]')) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect)
      Object.defineProperties(element, { offsetWidth: { get: () => 300 }, offsetHeight: { get: () => 200 } })
    }
    const extras = ids.slice(1).map((id) => {
      const container = document.createElement('div')
      document.body.append(container)
      return { container, dispose: registerPanelSurface(id, container, null) }
    })
    try {
      await frame()
      await frame()
      expect(observers.filter((observer) => observer.targets.size)).toHaveLength(1)
      expect(frames.size).toBe(0)
      for (const element of host.querySelectorAll<HTMLElement>('[data-node-id]')) vi.mocked(element.getBoundingClientRect).mockClear()
      const styles = vi.spyOn(window, 'getComputedStyle')
      const writes: MutationRecord[] = []
      const mutation = new MutationObserver((records) => writes.push(...records))
      for (const container of [surface, ...extras.map((entry) => entry.container)]) mutation.observe(container, { attributes: true })
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
      expect(frames.size).toBe(1)
      await frame()
      const targets = styles.mock.calls.map(([element]) => element)
      expect(targets.length).toBeGreaterThan(8)
      expect(new Set(targets).size).toBe(targets.length)
      for (const element of host.querySelectorAll<HTMLElement>('[data-node-id]')) {
        expect(vi.mocked(element.getBoundingClientRect).mock.calls.length).toBeLessThanOrEqual(1)
      }
      await Promise.resolve()
      expect(writes).toHaveLength(0)
      expect(frames.size).toBe(0)
      mutation.disconnect()
    } finally {
      for (const entry of extras) { entry.dispose(); entry.container.remove() }
    }
  })

  it('updates on scroll and window resize, and cancels pending work on cleanup', async () => {
    await frame()
    rect = new DOMRect(100, 10, 300, 200)
    host.querySelector('main')!.dispatchEvent(new Event('scroll'))
    await frame()
    expect(surface.style.transform).toContain('translate(100px, 10px)')
    rect = new DOMRect(110, 20, 300, 200)
    window.dispatchEvent(new Event('resize'))
    await frame()
    expect(surface.style.transform).toContain('translate(110px, 20px)')
    window.dispatchEvent(new Event('resize'))
    cleanup()
    expect(frames.size).toBe(0)
    expect(observers.every((observer) => observer.targets.size === 0)).toBe(true)
  })
})

it('parks a mounted guest without changing its logical viewport size', async () => {
  await frame()
  const width = surface.style.width, height = surface.style.height
  act(() => root.render(<div />))
  expect(surface.dataset.browserSurfaceVisible).toBe('false')
  expect(surface.style.width).toBe(width)
  expect(surface.style.height).toBe(height)
})
