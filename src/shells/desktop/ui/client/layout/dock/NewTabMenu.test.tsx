;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NewTabButton } from './NewTabMenu'

let frames: FrameRequestCallback[] = []
const runFrame = () => act(() => {
  const due = frames
  frames = []
  for (const callback of due) callback(0)
})

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => { frames = [] })
})
afterEach(() => vi.unstubAllGlobals())

it('follows its button while it moves and stops looking once it is still', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<NewTabButton items={[{ type: 'terminal', label: 'Terminal', icon: 'terminal' }]} onPick={() => {}} />))
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="New Tab"]')!
    let bottom = 20
    button.getBoundingClientRect = () => ({ left: 100, bottom, top: bottom - 20, right: 120, width: 20, height: 20, x: 100, y: bottom - 20, toJSON: () => ({}) })
    act(() => button.click())
    const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu().style.top).toBe('24px')

    // A pan moves the button: the menu follows.
    bottom = 60
    runFrame()
    expect(menu().style.top).toBe('64px')

    // Still: the loop ends instead of reading layout every frame.
    for (let i = 0; i < 40 && frames.length; i++) runFrame()
    expect(frames).toHaveLength(0)

    // Input that can move the canvas wakes it.
    bottom = 90
    window.dispatchEvent(new WheelEvent('wheel'))
    expect(frames).toHaveLength(1)
    runFrame()
    expect(menu().style.top).toBe('94px')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
