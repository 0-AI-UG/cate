import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanelSurfaceSlot, registerBrowserSurface, syncBrowserSurfaces } from './browserSurfaceRegistry'

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
  act(() => root.render(<div data-layout><aside /><main><BrowserPanelSurfaceSlot panelId="browser" /></main></div>))
  const slot = host.querySelector<HTMLElement>('[data-browser-surface-slot]')!
  rect = new DOMRect(100, 40, 300, 200)
  vi.spyOn(slot, 'getBoundingClientRect').mockImplementation(() => rect)
  Object.defineProperties(slot, {
    offsetWidth: { get: () => 300 },
    offsetHeight: { get: () => 200 },
  })
  cleanup = registerBrowserSurface('browser', surface, null)
})

afterEach(() => {
  cleanup()
  act(() => root.unmount())
  host.remove()
  surface.remove()
  vi.unstubAllGlobals()
})

describe('browser surface layout tracking', () => {
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
    expect(surface.style.left).toBe('250px')
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

    syncBrowserSurfaces()
    await Promise.resolve()

    expect(surface.style.left).toBe('180px')
    expect(surface.style.top).toBe('70px')
    expect(surface.style.transform).toBe('scale(0.8, 0.8)')
    expect(frames.size).toBe(0)
  })

  it('follows sibling layout changes and ancestor child insertion', async () => {
    await frame()
    rect = new DOMRect(60, 70, 300, 200)
    host.querySelector('aside')!.style.width = '60px'
    await frame()
    expect(surface.style.left).toBe('60px')
    rect = new DOMRect(60, 100, 300, 200)
    host.querySelector('[data-layout]')!.prepend(document.createElement('header'))
    await frame()
    expect(surface.style.top).toBe('100px')
  })

  it('tracks animated transforms through the final frame without more DOM mutations', async () => {
    await frame()
    const ancestor = host.querySelector('main')!
    const animation = { playState: 'running', effect: { getKeyframes: () => [{ transform: 'scale(1)' }] } }
    Object.assign(ancestor, { getAnimations: () => [animation] })
    ancestor.dispatchEvent(new Event('transitionrun', { bubbles: true }))
    rect = new DOMRect(120, 50, 240, 160)
    await frame()
    expect(surface.style.transform).toBe('scale(0.8, 0.8)')
    expect(frames.size).toBe(1)
    rect = new DOMRect(150, 60, 150, 100)
    animation.playState = 'finished'
    await frame()
    expect(surface.style.left).toBe('150px')
    expect(surface.style.transform).toBe('scale(0.5, 0.5)')
    expect(frames.size).toBe(0)
  })

  it('does not poll layout for decorative T3 activity pulses', async () => {
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
      <div key={id} data-node-id={id} style={{ zIndex: i + 1 }}><BrowserPanelSurfaceSlot panelId={id} /></div>
    ))}</main>))
    for (const element of host.querySelectorAll<HTMLElement>('main, [data-node-id], [data-browser-surface-slot]')) {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect)
      Object.defineProperties(element, { offsetWidth: { get: () => 300 }, offsetHeight: { get: () => 200 } })
    }
    const extras = ids.slice(1).map((id) => {
      const container = document.createElement('div')
      document.body.append(container)
      return { container, dispose: registerBrowserSurface(id, container, null) }
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
    expect(surface.style.top).toBe('10px')
    rect = new DOMRect(110, 20, 300, 200)
    window.dispatchEvent(new Event('resize'))
    await frame()
    expect(surface.style.left).toBe('110px')
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
