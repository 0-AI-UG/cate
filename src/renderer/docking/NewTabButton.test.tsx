import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { NewTabButton } from './NewTabButton'
import { CanvasTopOverlayContext } from '../canvas/CanvasTopOverlayContext'

vi.mock('../panels/registry', () => ({ PANEL_REGISTRY: new Proxy({}, { get: () => ({ label: 'Panel', icon: () => null }) }) }))

it.each([false, true])('tracks the plus button in its coordinate space and stops on close (canvas=%s)', (canvasAttached) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const frames = new Map<number, FrameRequestCallback>()
  let nextId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback)
    return nextId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const world = document.createElement('div')
  document.body.appendChild(world)
  Object.defineProperty(world, 'offsetWidth', { value: 1 })
  vi.spyOn(world, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 10, width: 2 } as DOMRect)
  const root = createRoot(host)
  try {
    act(() => root.render(<CanvasTopOverlayContext.Provider value={world}><NewTabButton canvasAttached={canvasAttached} items={[{ type: 'editor', label: 'Editor', Icon: () => null }]} onPick={() => {}} /></CanvasTopOverlayContext.Provider>))
    const button = host.querySelector('button')!
    let rect = { left: 100, bottom: 80 } as DOMRect
    vi.spyOn(button, 'getBoundingClientRect').mockImplementation(() => rect)
    act(() => button.click())
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.style.top).toBe(canvasAttached ? '39px' : '84px')
    expect(menu.parentElement).toBe(canvasAttached ? world : document.body)
    expect(menu.style.position).toBe(canvasAttached ? 'absolute' : 'fixed')
    const initialRight = menu.style.right
    rect = { left: 160, bottom: 130 } as DOMRect
    act(() => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(callback => callback(16))
    })
    expect(menu.style.top).toBe(canvasAttached ? '64px' : '134px')
    expect(parseFloat(menu.style.right)).toBe(parseFloat(initialRight) - (canvasAttached ? 30 : 60))
    act(() => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(frames.size).toBe(0)
  } finally {
    act(() => root.unmount())
    host.remove()
    world.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
