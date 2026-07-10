import { describe, it, expect } from 'vitest'
import { sanitizeLoadedCanvasNodes } from './sanitizeNodes'

const valid = {
  id: 'n1',
  dockLayout: { type: 'tabs' as const, id: 'stack-p1', panelIds: ['p1'], activeIndex: 0 },
  origin: { x: 10, y: 20 },
  size: { width: 300, height: 200 },
  zOrder: 0,
  creationIndex: 0,
}

describe('sanitizeLoadedCanvasNodes', () => {
  it('passes valid nodes through untouched', () => {
    const { nodes, repaired, dropped } = sanitizeLoadedCanvasNodes({ n1: valid })
    expect(repaired).toEqual([])
    expect(dropped).toEqual([])
    expect(nodes.n1).toMatchObject(valid)
  })

  it('returns an empty result for null/garbage input', () => {
    for (const raw of [null, undefined, 'nope', 42] as unknown[]) {
      const r = sanitizeLoadedCanvasNodes(raw as Record<string, unknown>)
      expect(r.nodes).toEqual({})
    }
  })

  it('repairs a node missing its size (the reported crash) instead of dropping it', () => {
    const { nodes, repaired, dropped } = sanitizeLoadedCanvasNodes({
      n1: { ...valid, size: undefined },
    })
    expect(dropped).toEqual([])
    expect(repaired).toEqual(['n1'])
    expect(nodes.n1.size.width).toBeGreaterThan(0)
    expect(nodes.n1.size.height).toBeGreaterThan(0)
  })

  it('repairs invalid size values (zero/negative/NaN)', () => {
    for (const size of [{ width: 0, height: 100 }, { width: -5, height: 100 }, { width: NaN, height: 1 }, {}]) {
      const { nodes, repaired } = sanitizeLoadedCanvasNodes({ n1: { ...valid, size } })
      expect(repaired).toEqual(['n1'])
      expect(nodes.n1.size.width).toBeGreaterThan(0)
    }
  })

  it('repairs a missing/invalid origin to the canvas origin', () => {
    const { nodes, repaired } = sanitizeLoadedCanvasNodes({ n1: { ...valid, origin: { x: 'a', y: 2 } } })
    expect(repaired).toEqual(['n1'])
    expect(nodes.n1.origin).toEqual({ x: 0, y: 0 })
  })

  it('backfills missing z-order/creation counters above the highest valid ones', () => {
    const { nodes, repaired } = sanitizeLoadedCanvasNodes({
      a: { ...valid, id: 'a', zOrder: 5, creationIndex: 7 },
      b: { ...valid, id: 'b', dockLayout: { type: 'tabs', id: 'stack-p2', panelIds: ['p2'], activeIndex: 0 }, zOrder: undefined, creationIndex: undefined },
    })
    expect(repaired).toEqual(['b'])
    expect(nodes.b.zOrder).toBeGreaterThan(5)
    expect(nodes.b.creationIndex).toBeGreaterThan(7)
  })

  it('drops unrecoverable entries (non-object, or no dock layout)', () => {
    const { nodes, dropped } = sanitizeLoadedCanvasNodes({
      bad1: null,
      bad2: 'x',
      bad3: { ...valid, dockLayout: undefined },
      good: valid,
    })
    expect(dropped.sort()).toEqual(['bad1', 'bad2', 'bad3'])
    expect(Object.keys(nodes)).toEqual(['good'])
  })

  it('strips malformed pre-maximize geometry rather than risk a second crash', () => {
    const { nodes, repaired } = sanitizeLoadedCanvasNodes({
      n1: { ...valid, preMaximizeOrigin: { x: 1, y: 2 }, preMaximizeSize: { width: 0, height: 0 } },
    })
    expect(repaired).toEqual(['n1'])
    expect(nodes.n1.preMaximizeSize).toBeUndefined()
    expect(nodes.n1.preMaximizeOrigin).toEqual({ x: 1, y: 2 })
  })

  it('falls back to the map key when a node has no id', () => {
    const { nodes } = sanitizeLoadedCanvasNodes({ key1: { ...valid, id: undefined } })
    expect(nodes.key1.id).toBe('key1')
  })
})
