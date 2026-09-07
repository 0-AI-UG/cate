// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../../stores/CanvasStoreContext', () => ({ useCanvasStoreApi: () => ({ subscribe: () => () => {} }) }))
vi.mock('../../stores/uiStore', () => ({ useUIStore: { subscribe: () => () => {} } }))
vi.mock('../../drag', () => ({ useDragStore: { subscribe: () => () => {} } }))
vi.mock('./useWorktreeMembership', () => ({ useWorktreeMembership: () => ({ groups: [] }) }))
vi.mock('./territoryGL', () => ({ createTerritoryGL: () => ({ resize: vi.fn(), dispose: vi.fn() }), buildPrimitives: vi.fn() }))
import WorktreeTerritoryLayer from './WorktreeTerritoryLayer'
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
  } finally { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})
