// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { disposeGL, drawGL, resizeGL, setViewGL, canvasListeners, canvasApi } = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    disposeGL: vi.fn(),
    drawGL: vi.fn(),
    resizeGL: vi.fn(),
    setViewGL: vi.fn(),
    canvasListeners: listeners,
    canvasApi: {
      getState: () => ({ zoomLevel: 1, viewportOffset: { x: 0, y: 0 }, nodes: {} }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
})
vi.mock('../../stores/CanvasStoreContext', () => ({ useCanvasStoreApi: () => canvasApi }))
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ focusedWorktreeId: null }), subscribe: () => () => {} } }))
vi.mock('../../drag', () => ({ useDragStore: { getState: () => ({ source: null, pendingDetach: [] }), subscribe: () => () => {} } }))
vi.mock('./useWorktreeMembership', () => ({ useWorktreeMembership: () => ({ groups: [] }) }))
vi.mock('./territoryGL', () => ({
  createTerritoryGL: () => ({
    resize: resizeGL,
    setView: setViewGL,
    uploadGeometry: vi.fn(),
    uploadMask: vi.fn(),
    draw: drawGL,
    dispose: disposeGL,
  }),
  buildPrimitives: vi.fn(),
}))
import WorktreeTerritoryLayer from './WorktreeTerritoryLayer'

it('resizes and repaints when moving between display scales without a container resize', () => {
  const frames: FrameRequestCallback[] = []
  const queries: { listener?: () => void; removeEventListener: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('devicePixelRatio', 1)
  const matchMedia = vi.fn(() => {
    const query = {
      listener: undefined as (() => void) | undefined,
      addEventListener: vi.fn((_event: string, listener: () => void) => { query.listener = listener }),
      removeEventListener: vi.fn(),
    }
    queries.push(query)
    return query
  })
  vi.stubGlobal('matchMedia', matchMedia)
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() => root.render(<WorktreeTerritoryLayer containerWidth={800} containerHeight={600} />))
    act(() => frames.shift()?.(0))
    const canvas = host.querySelector<HTMLCanvasElement>('[data-worktree-territory]')!
    for (const dpr of [2, 1, 1.5]) {
      vi.stubGlobal('devicePixelRatio', dpr)
      const previousQuery = queries.at(-1)!
      act(() => previousQuery?.listener?.())
      expect(frames).toHaveLength(1)
      act(() => frames.shift()?.(16))
      expect(canvas.width).toBe(800 * dpr)
      expect(canvas.height).toBe(600 * dpr)
      expect(resizeGL).toHaveBeenLastCalledWith(800 * dpr, 600 * dpr)
      expect(setViewGL).toHaveBeenLastCalledWith(1, 0, 0, dpr)
      expect(matchMedia).toHaveBeenLastCalledWith(`(resolution: ${dpr}dppx)`)
      expect(previousQuery?.removeEventListener).toHaveBeenCalledWith('change', previousQuery.listener)
    }
  } finally {
    act(() => root.unmount())
    if (queries.length) expect(queries.at(-1)?.removeEventListener).toHaveBeenCalled()
    vi.clearAllMocks()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('allocates the backing store once during setup and only resizes changed dimensions', () => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('devicePixelRatio', 1)
  const widths = vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set')
  const heights = vi.spyOn(HTMLCanvasElement.prototype, 'height', 'set')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<WorktreeTerritoryLayer containerWidth={800} containerHeight={600} />))
    expect(widths.mock.calls.filter(([value]) => value === 800)).toHaveLength(1)
    expect(heights.mock.calls.filter(([value]) => value === 600)).toHaveLength(1)
    act(() => root.render(<WorktreeTerritoryLayer containerWidth={900} containerHeight={600} />))
    expect(widths.mock.calls.filter(([value]) => value === 900)).toHaveLength(1)
    expect(heights.mock.calls.filter(([value]) => value === 600)).toHaveLength(1)
  } finally {
    act(() => root.unmount())
    expect(disposeGL).toHaveBeenCalledTimes(1)
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('coalesces repeated canvas changes into one territory frame', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('devicePixelRatio', 1)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<WorktreeTerritoryLayer containerWidth={800} containerHeight={600} />))
    const initialFrame = frames.get(1)
    expect(initialFrame).toBeDefined()
    act(() => initialFrame?.(0))
    requestFrame.mockClear()
    drawGL.mockClear()

    act(() => {
      for (const listener of canvasListeners) {
        listener()
        listener()
        listener()
      }
    })
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(drawGL).not.toHaveBeenCalled()

    const coalescedFrame = frames.get(2)
    expect(coalescedFrame).toBeDefined()
    act(() => coalescedFrame?.(16))
    expect(drawGL).toHaveBeenCalledTimes(1)
  } finally {
    act(() => root.unmount())
    host.remove()
    canvasListeners.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
