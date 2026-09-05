import { describe, expect, it, vi } from 'vitest'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { createCanvasStore } from '../canvasStore'

const CONTAINER = { width: 1200, height: 800 }
const SIZE = { width: 640, height: 400 }

function seededStore() {
  const store = createCanvasStore()
  store.getState().setContainerSize(CONTAINER)
  store.getState().addNode('terminal-existing', 'terminal', { x: 0, y: 0 }, SIZE)
  store.getState().addNode('editor-existing', 'editor', { x: 1800, y: 0 }, SIZE)
  store.getState().setZoomAndOffset(1.4, { x: 100, y: -20 })
  return store
}

function beginNewTarget(
  store: ReturnType<typeof seededStore>,
  panelId: string,
  onCancelled = vi.fn(),
) {
  return store.getState().beginPanelTarget({
    panelId,
    panelType: 'terminal',
    availability: 'new',
    existing: [],
    onCancelled,
  })
}

describe('panel target selection', () => {
  it('uses the same pending transaction for ordinary creation and target requests', () => {
    const store = seededStore()
    const placementCancelled = vi.fn()
    const targetCancelled = vi.fn()

    beginNewTarget(store, 'new-terminal', placementCancelled)
    expect(store.getState().pendingPanelTarget).toMatchObject({
      panelId: 'new-terminal',
      panelType: 'terminal',
      availability: 'new',
    })

    store.getState().beginPanelTarget({
      panelType: 'terminal',
      availability: 'existing',
      existing: [{ panelId: 'terminal-existing', title: 'Terminal 1' }],
      onSelected: vi.fn(),
      onCancelled: targetCancelled,
    })

    expect(placementCancelled).toHaveBeenCalledOnce()
    expect(store.getState().pendingPanelTarget).toMatchObject({
      panelId: undefined,
      panelType: 'terminal',
      availability: 'existing',
    })
    store.getState().cancelPanelTarget()
    expect(targetCancelled).toHaveBeenCalledOnce()
    expect(store.getState().pendingPanelTarget).toBeNull()
  })

  it('commits an ordinary create through the canonical new-target action', () => {
    const store = seededStore()
    beginNewTarget(store, 'new-terminal')
    const candidate = store.getState().pendingPanelTarget!.candidates[0]

    store.getState().selectNewPanelTarget(0)

    const node = Object.values(store.getState().nodes).find((item) =>
      collectPanelIds(item.dockLayout).includes('new-terminal'),
    )
    expect(node).toMatchObject({ origin: candidate.point, size: candidate.size })
    expect(store.getState().pendingPanelTarget).toBeNull()
  })

  it('combines recommended new positions with eligible existing panels', () => {
    const store = seededStore()
    const selected = vi.fn()

    expect(store.getState().beginPanelTarget({
      panelType: 'terminal',
      availability: 'both',
      existing: [
        { panelId: 'terminal-existing', title: 'Terminal 1' },
        { panelId: 'editor-existing', title: 'Editor 1' },
        { panelId: 'not-on-canvas', title: 'Terminal 2' },
      ],
      onSelected: selected,
      onCancelled: vi.fn(),
    })).toBe(true)

    const pending = store.getState().pendingPanelTarget!
    expect(pending.candidates.length).toBeGreaterThan(0)
    expect(pending.existing.map((candidate) => candidate.panelId)).toEqual([
      'terminal-existing',
      'editor-existing',
    ])
    expect(store.getState().zoomLevel).toBeLessThan(1.4)
  })

  it('supports new-only and existing-only requests', () => {
    const newStore = seededStore()
    newStore.getState().beginPanelTarget({
      panelType: 'browser',
      availability: 'new',
      existing: [{ panelId: 'terminal-existing', title: 'Terminal 1' }],
      onSelected: vi.fn(),
      onCancelled: vi.fn(),
    })
    expect(newStore.getState().pendingPanelTarget?.candidates.length).toBeGreaterThan(0)
    expect(newStore.getState().pendingPanelTarget?.existing).toEqual([])

    const existingStore = seededStore()
    existingStore.getState().beginPanelTarget({
      panelType: 'terminal',
      availability: 'existing',
      existing: [{ panelId: 'terminal-existing', title: 'Terminal 1' }],
      onSelected: vi.fn(),
      onCancelled: vi.fn(),
    })
    expect(existingStore.getState().pendingPanelTarget?.candidates).toEqual([])
    expect(existingStore.getState().pendingPanelTarget?.existing).toHaveLength(1)
  })

  it('returns the selected target and restores the previous camera', () => {
    const store = seededStore()
    const selected = vi.fn()
    store.getState().beginPanelTarget({
      panelType: 'terminal',
      availability: 'both',
      existing: [{ panelId: 'terminal-existing', title: 'Terminal 1' }],
      onSelected: selected,
      onCancelled: vi.fn(),
    })

    store.getState().selectExistingPanelTarget('terminal-existing')

    expect(selected).toHaveBeenCalledWith({ kind: 'existing', panelId: 'terminal-existing' })
    expect(store.getState().pendingPanelTarget).toBeNull()
    expect(store.getState().zoomLevel).toBe(1.4)
    expect(store.getState().viewportOffset).toEqual({ x: 100, y: -20 })
  })

  it('cancels cleanly and resolves a recommended new position', () => {
    const store = seededStore()
    const selected = vi.fn()
    const cancelled = vi.fn()
    store.getState().beginPanelTarget({
      panelType: 'terminal',
      availability: 'new',
      existing: [],
      onSelected: selected,
      onCancelled: cancelled,
    })
    store.getState().cancelPanelTarget()
    expect(cancelled).toHaveBeenCalledOnce()

    store.getState().beginPanelTarget({
      panelType: 'terminal',
      availability: 'new',
      existing: [],
      onSelected: selected,
      onCancelled: cancelled,
    })
    store.getState().selectNewPanelTarget(0)
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'new',
      point: expect.any(Object),
      size: SIZE,
    }))
  })

  it('cancels an older request before starting a replacement', () => {
    const store = seededStore()
    const firstCancelled = vi.fn()
    const request = (onCancelled: () => void) => store.getState().beginPanelTarget({
      panelType: 'terminal',
      availability: 'new',
      existing: [],
      onSelected: vi.fn(),
      onCancelled,
    })
    request(firstCancelled)
    request(vi.fn())
    expect(firstCancelled).toHaveBeenCalledOnce()
  })
})
