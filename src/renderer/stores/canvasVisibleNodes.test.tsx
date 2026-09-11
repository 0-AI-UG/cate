import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCanvasStore, useVisibleNodeIds } from './canvasStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useVisibleNodeIds zoom settling', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('holds mount membership during zoom and reconciles after it settles', () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 800, height: 600 })
    const near = store.getState().addNode('near', 'editor', { x: 100, y: 100 }, { width: 100, height: 100 })
    const farther = store.getState().addNode('farther', 'editor', { x: 2500, y: 100 }, { width: 100, height: 100 })
    const Probe = () => {
      const ids = useVisibleNodeIds(store, new Set())
      return <div data-ids={ids.join(',')} />
    }
    act(() => root.render(<Probe />))
    expect(host.firstElementChild?.getAttribute('data-ids')).toBe(near)

    act(() => store.getState().setZoom(0.25))
    expect(host.firstElementChild?.getAttribute('data-ids')).toBe(near)
    act(() => vi.advanceTimersByTime(119))
    expect(host.firstElementChild?.getAttribute('data-ids')).toBe(near)
    act(() => vi.advanceTimersByTime(1))
    expect(host.firstElementChild?.getAttribute('data-ids')).toBe(`${near},${farther}`)
  })

  it('publishes node creation immediately while a zoom reconciliation is pending', () => {
    const store = createCanvasStore()
    store.getState().setContainerSize({ width: 800, height: 600 })
    const first = store.getState().addNode('first', 'editor', { x: 100, y: 100 }, { width: 100, height: 100 })
    const Probe = () => <div data-ids={useVisibleNodeIds(store, new Set()).join(',')} />
    act(() => root.render(<Probe />))
    act(() => store.getState().setZoom(0.5))
    let second = ''
    act(() => { second = store.getState().addNode('second', 'editor', { x: 200, y: 100 }, { width: 100, height: 100 }) })
    expect(host.firstElementChild?.getAttribute('data-ids')).toBe(`${first},${second}`)
  })

})
