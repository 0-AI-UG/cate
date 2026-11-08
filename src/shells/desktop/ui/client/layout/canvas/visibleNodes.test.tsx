import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useStagedVisibleNodeIds } from './visibleNodes'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('budgets new mounts after both expansion and equal-sized visibility swaps', () => {
  const pending = new Map<number, FrameRequestCallback>()
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { pending.set(++sequence, cb); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id))
  const host = document.createElement('div')
  const root = createRoot(host)
  function Nodes({ ids }: { ids: string[] }) { return <>{useStagedVisibleNodeIds(ids).map(id => <span key={id}>{id}</span>)}</> }
  const render = (ids: string[]) => act(() => root.render(<Nodes ids={ids} />))
  const frame = () => act(() => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(cb => cb(0)) })
  try {
    render(['a', 'b', 'c'])
    expect(host.textContent).toBe('a')
    frame(); frame()
    expect(host.textContent).toBe('abc')
    render(['a', 'b', 'c', 'd', 'e'])
    expect(host.textContent).toBe('abc')
    frame()
    expect(host.textContent).toBe('abcd')
    frame()
    render(['a', 'd', 'f', 'g', 'h'])
    expect(host.textContent).toBe('ad')
    frame()
    expect(host.textContent).toBe('adf')
    frame(); frame()
    expect(host.textContent).toBe('adfgh')
  } finally { act(() => root.unmount()); vi.unstubAllGlobals() }
})

it('replenishes overscan after a pan settles but publishes newly exposed content immediately', async () => {
  const { createCanvasView } = await import('./store')
  const { fakeDocument, canvasDocument } = await import('./testing.canvas')
  const { rect } = await import('@workspace/canvas/contract')
  const { useVisibleNodeIds } = await import('./visibleNodes')
  vi.useFakeTimers()
  const document = fakeDocument(canvasDocument([0, 1800, 2200, 5000].map((x, i) => ({ nodeId: `n${i}`, panelId: `p${i}`, rect: rect(x, 0, 200, 200) }))))
  const store = createCanvasView({ workspaceId: 'test', canvasId: 'c1', document, animate: false })
  store.getState().setContainerSize({ width: 1000, height: 800 })
  const host = globalThis.document.createElement('div')
  const root = createRoot(host)
  const keep = new Set<string>()
  function Nodes() { return <>{useVisibleNodeIds(store, keep).join(',')}</> }
  try {
    act(() => root.render(<Nodes />))
    expect(host.textContent).toBe('n0,n1')
    act(() => store.getState().setViewportOffset({ x: -500, y: 0 }))
    expect(host.textContent).toBe('n0,n1')
    act(() => vi.advanceTimersByTime(120))
    expect(host.textContent).toBe('n0,n1,n2')
    act(() => store.getState().setViewportOffset({ x: -4500, y: 0 }))
    expect(host.textContent).toContain('n3')
  } finally { act(() => root.unmount()); store.getState().dispose(); vi.useRealTimers() }
})
