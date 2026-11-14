import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DiffRows } from './DiffRows'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.unstubAllGlobals())

it('bounds a long diff and mounts distant rows only when visible', () => {
  const observers = new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(el: Element) { observers.set(el, this.callback) }
    disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = () => act(() => root.render(<DiffRows count={5000} columns={100} wrap={false} renderRow={i => <div data-line={i}>Line {i}</div>} />))
  try {
    render()
    expect(host.querySelectorAll('[data-line]')).toHaveLength(40)
    const distant = host.querySelector('[data-diff-chunk="4000"]')!
    act(() => observers.get(distant)!([{ isIntersecting: true }]))
    expect(host.querySelector('[data-line="4000"]')).not.toBeNull()
    act(() => observers.get(distant)!([{ isIntersecting: false }]))
    expect(host.querySelector('[data-line="4000"]')).toBeNull()
    expect(host.querySelectorAll('[data-line]')).toHaveLength(40)
  } finally { act(() => root.unmount()); host.remove() }
})


it('releases an offscreen chunk after its protected keyboard focus leaves', async () => {
  const callbacks = new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(el: Element) { callbacks.set(el, this.callback) }
    disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div')
  const outside = document.createElement('button')
  document.body.append(host, outside)
  const root = createRoot(host)
  try {
    act(() => root.render(<DiffRows count={5000} columns={80} wrap={false} renderRow={i => <button data-line={i}>Line {i}</button>} />))
    act(() => host.querySelector<HTMLButtonElement>('[data-line="0"]')!.focus())
    const chunk = host.querySelector('[data-diff-chunk="0"]')!
    act(() => callbacks.get(chunk)!([{ isIntersecting: false }]))
    expect(host.querySelector('[data-line="0"]')).not.toBeNull()
    await act(async () => { outside.focus(); await Promise.resolve() })
    expect(host.querySelector('[data-line="0"]')).toBeNull()
  } finally { act(() => root.unmount()); host.remove(); outside.remove() }
})

it('retains every chunk in a multi-chunk selection until the selection clears', () => {
  const callbacks = new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(el: Element) { callbacks.set(el, this.callback) }
    disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const selection = window.getSelection()!
  try {
    act(() => root.render(<DiffRows count={200} columns={80} wrap={false} renderRow={i => <span data-line={i}>{`Line ${i}\n`}</span>} />))
    const middle = host.querySelector('[data-diff-chunk="40"]')!
    const last = host.querySelector('[data-diff-chunk="80"]')!
    act(() => {
      callbacks.get(middle)!([{ isIntersecting: true }])
      callbacks.get(last)!([{ isIntersecting: true }])
    })
    const range = document.createRange()
    range.setStartBefore(host.querySelector('[data-line="0"]')!)
    range.setEndAfter(host.querySelector('[data-line="119"]')!)
    selection.removeAllRanges()
    selection.addRange(range)
    const selected = selection.toString()
    act(() => callbacks.get(middle)!([{ isIntersecting: false }]))
    expect(selection.toString()).toBe(selected)
    expect(host.querySelector('[data-line="40"]')).not.toBeNull()
    act(() => {
      selection.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(host.querySelector('[data-line="40"]')).toBeNull()
  } finally { selection.removeAllRanges(); act(() => root.unmount()); host.remove() }
})
