import { describe, it, expect, afterEach } from 'vitest'
import {
  registerDropZone,
  getDropZoneEntries,
  resolveDropEdge,
  type DropZoneEntry,
} from './registry'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON() {
      return {}
    },
  } as DOMRect
}

const cleanups: Array<() => void> = []

function register(entry: Partial<DropZoneEntry> & Pick<DropZoneEntry, 'getRect'>): DropZoneEntry {
  const full: DropZoneEntry = {
    id: entry.id ?? `e-${Math.random()}`,
    zone: entry.zone ?? 'left',
    stackId: entry.stackId,
    getRect: entry.getRect,
    dockStoreApi: entry.dockStoreApi,
    acceptsPanelType: entry.acceptsPanelType,
  }
  const cleanup = registerDropZone(full)
  cleanups.push(cleanup)
  return full
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

// -----------------------------------------------------------------------------
// resolveDropEdge
// -----------------------------------------------------------------------------

describe('resolveDropEdge', () => {
  const r = rect(0, 0, 500, 400)

  it('returns center for the top tab-bar strip (< 38px)', () => {
    expect(resolveDropEdge(250, 10, r)).toBe('center')
    expect(resolveDropEdge(250, 37, r)).toBe('center')
  })

  it('returns top for cursor in the top edge band (just below the tab-bar)', () => {
    expect(resolveDropEdge(250, 40, r)).toBe('top')
  })

  it('returns bottom for cursor in the bottom edge band', () => {
    expect(resolveDropEdge(250, 380, r)).toBe('bottom')
  })

  it('returns left for cursor in the left edge band (not in top tab-bar)', () => {
    expect(resolveDropEdge(20, 200, r)).toBe('left')
  })

  it('returns right for cursor in the right edge band', () => {
    expect(resolveDropEdge(470, 200, r)).toBe('right')
  })

  it('returns null for body center', () => {
    expect(resolveDropEdge(250, 200, r)).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// registerDropZone / cleanup
// -----------------------------------------------------------------------------

describe('registerDropZone', () => {
  it('adds the entry to getDropZoneEntries', () => {
    const before = getDropZoneEntries().length
    register({ getRect: () => rect(0, 0, 100, 100), zone: 'left' })
    expect(getDropZoneEntries().length).toBe(before + 1)
  })

  it('cleanup function removes the entry', () => {
    const before = getDropZoneEntries().length
    const cleanup = registerDropZone({
      id: 'one',
      zone: 'left',
      getRect: () => rect(0, 0, 100, 100),
    })
    expect(getDropZoneEntries().length).toBe(before + 1)
    cleanup()
    expect(getDropZoneEntries().length).toBe(before)
  })
})
