;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CascadingMenu, MENU_EDGE_MARGIN, menuPosition, type CascadingMenuItem } from './CascadingMenu'

const viewport = { width: 1000, height: 700 }
const size = { width: 220, height: 160 }

describe('menuPosition', () => {
  it('opens down and to the right of the point when there is room', () => {
    expect(menuPosition(size, viewport, { point: { x: 100, y: 120 } })).toEqual({ left: 100, top: 120 })
  })

  it('flips to the left of the point near the right edge', () => {
    expect(menuPosition(size, viewport, { point: { x: 950, y: 120 } })).toEqual({ left: 730, top: 120 })
  })

  it('flips above the point near the bottom edge', () => {
    expect(menuPosition(size, viewport, { point: { x: 100, y: 680 } })).toEqual({ left: 100, top: 520 })
  })

  it('stays inside the window in a corner too small to flip into', () => {
    const tall = { width: 220, height: 690 }
    const at = menuPosition(tall, viewport, { point: { x: 2, y: 3 } })
    expect(at.left).toBe(MENU_EDGE_MARGIN)
    expect(at.top).toBe(MENU_EDGE_MARGIN)
  })

  it('opens a submenu on the right of its item, or on the left without room', () => {
    expect(menuPosition(size, viewport, { anchor: { left: 100, right: 300, top: 200 } })).toEqual({ left: 296, top: 194 })
    expect(menuPosition(size, viewport, { anchor: { left: 700, right: 900, top: 200 } })).toEqual({ left: 484, top: 194 })
  })

  it('moves a submenu up to fit above the bottom edge', () => {
    expect(menuPosition(size, viewport, { anchor: { left: 100, right: 300, top: 650 } }).top).toBe(viewport.height - MENU_EDGE_MARGIN - size.height)
  })
})

describe('CascadingMenu', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    vi.useFakeTimers()
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  const menus = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'))
  const item = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent === label)!

  const render = (items: CascadingMenuItem[], onClose = vi.fn()) => {
    act(() => root.render(<CascadingMenu x={10} y={10} items={items} onClose={onClose} />))
    return onClose
  }

  it('opens a submenu on hover and runs the picked item after closing', () => {
    const picked = vi.fn()
    const onClose = render([{ id: 'add', label: 'Add', submenu: [{ id: 'note', label: 'Note', onSelect: picked }] }])
    expect(menus()).toHaveLength(1)
    act(() => { item('Add').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    act(() => { vi.advanceTimersByTime(200) })
    expect(menus()).toHaveLength(2)
    expect(item('Add').getAttribute('aria-expanded')).toBe('true')
    act(() => item('Note').click())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(picked).toHaveBeenCalledTimes(1)
  })

  it('opens a submenu with ArrowRight and goes back with ArrowLeft', () => {
    render([{ id: 'add', label: 'Add', submenu: [{ id: 'text', label: 'Text' }] }, { id: 'fit', label: 'Zoom to Fit' }])
    const add = item('Add')
    add.focus()
    act(() => { add.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(menus()).toHaveLength(2)
    act(() => { item('Text').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(menus()).toHaveLength(1)
  })

  it('closes on Escape and on a press outside', () => {
    const onClose = render([{ id: 'fit', label: 'Zoom to Fit' }])
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('never runs a disabled item', () => {
    const picked = vi.fn()
    const onClose = render([{ id: 'x', label: 'Nothing', disabled: true, onSelect: picked }])
    act(() => item('Nothing').click())
    expect(picked).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
