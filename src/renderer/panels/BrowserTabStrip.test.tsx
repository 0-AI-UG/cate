import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}))

import { BrowserTabStrip } from './BrowserTabStrip'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('BrowserTabStrip', () => {
  it('stays visible for one new tab and gives it the expected label', () => {
    act(() => {
      root.render(
        <BrowserTabStrip
          tabs={[{ id: 'tab-1', url: 'cate://newtab', title: '' }]}
          activeTabId="tab-1"
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onNewTab={vi.fn()}
          onTogglePin={vi.fn()}
        />,
      )
    })

    expect(host.querySelector('[aria-label="Browser tabs"]')).toBeTruthy()
    expect(host.textContent).toContain('New Tab')
    expect(host.querySelector('button[aria-label="New tab"]')).toBeTruthy()
  })

  it('scrolls horizontally by dragging without selecting the dragged tab', () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(
        <BrowserTabStrip
          tabs={[
            { id: 'tab-1', url: 'https://one.example', title: 'One' },
            { id: 'tab-2', url: 'https://two.example', title: 'Two' },
            { id: 'tab-3', url: 'https://three.example', title: 'Three' },
          ]}
          activeTabId="tab-1"
          onSelect={onSelect}
          onClose={vi.fn()}
          onNewTab={vi.fn()}
          onTogglePin={vi.fn()}
        />,
      )
    })

    const strip = host.querySelector('[aria-label="Browser tabs"]') as HTMLDivElement
    const firstTab = host.querySelector('[title^="One"]') as HTMLDivElement
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 600 })
    Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 })
    strip.scrollLeft = 40

    const pointer = (type: string, clientX: number): Event => Object.assign(
      new MouseEvent(type, { bubbles: true, button: 0, clientX }),
      { pointerId: 1 },
    )
    act(() => {
      firstTab.dispatchEvent(pointer('pointerdown', 120))
      strip.dispatchEvent(pointer('pointermove', 70))
      strip.dispatchEvent(pointer('pointerup', 70))
      firstTab.click()
    })

    expect(strip.scrollLeft).toBe(90)
    expect(onSelect).not.toHaveBeenCalled()

    act(() => firstTab.click())
    expect(onSelect).toHaveBeenCalledWith('tab-1')
  })

  it('does not capture close-button clicks when the strip overflows', () => {
    const onClose = vi.fn()
    act(() => {
      root.render(
        <BrowserTabStrip
          tabs={[
            { id: 'tab-1', url: 'https://one.example', title: 'One' },
            { id: 'tab-2', url: 'https://two.example', title: 'Two' },
          ]}
          activeTabId="tab-1"
          onSelect={vi.fn()}
          onClose={onClose}
          onNewTab={vi.fn()}
          onTogglePin={vi.fn()}
        />,
      )
    })

    const strip = host.querySelector('[aria-label="Browser tabs"]') as HTMLDivElement
    const close = host.querySelector('button[aria-label="Close tab"]') as HTMLButtonElement
    const setPointerCapture = vi.fn()
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 600 })
    Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 })
    Object.assign(strip, { setPointerCapture })

    act(() => {
      close.dispatchEvent(Object.assign(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        { pointerId: 1 },
      ))
      close.click()
    })

    expect(setPointerCapture).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledWith('tab-1')
  })
})
