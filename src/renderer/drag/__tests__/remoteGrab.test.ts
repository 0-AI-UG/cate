// Regression: when a panel is dragged from a detached window into the main
// Cate window, the in-renderer ghost must anchor near the cursor's top-left
// (matching the native OS ghost) rather than at the ghost's center. The grab
// offset must therefore be a small fixed value, independent of ghost size.
import { describe, it, expect } from 'vitest'
import type { PanelTransferSnapshot } from '../../../shared/types'
import { remoteDragGrab } from '../remoteGrab'

function snap(width: number, height: number): PanelTransferSnapshot {
  return {
    panel: { id: 'p', type: 'editor', title: 't' },
    geometry: { origin: { x: 0, y: 0 }, size: { width, height } },
    sourceLocation: { kind: 'detached', windowId: 0 },
  } as unknown as PanelTransferSnapshot
}

describe('remoteDragGrab', () => {
  it('tiny ghost stays near top-left', () => {
    const g = remoteDragGrab(snap(100, 50))
    expect(g.x).toBeLessThanOrEqual(20)
    expect(g.y).toBeLessThanOrEqual(20)
  })

  it('medium ghost does not anchor at center', () => {
    const g = remoteDragGrab(snap(320, 200))
    expect(g.x).toBeLessThanOrEqual(20)
    expect(g.y).toBeLessThanOrEqual(20)
  })

  it('huge ghost does not anchor at center', () => {
    const g = remoteDragGrab(snap(1200, 900))
    expect(g.x).toBeLessThanOrEqual(20)
    expect(g.y).toBeLessThanOrEqual(20)
  })

  it('grab is independent of ghost size', () => {
    const a = remoteDragGrab(snap(100, 50))
    const b = remoteDragGrab(snap(1200, 900))
    expect(a).toEqual(b)
  })
})
