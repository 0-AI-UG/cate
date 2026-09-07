import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanelSurfaceSlot, registerBrowserSurface } from './browserSurfaceRegistry'

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
