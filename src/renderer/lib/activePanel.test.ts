// =============================================================================
// activePanel — the canonical active-panel store and the placement derivation
// built on it (lib/workspace/canvasAccess). Replaces the old activeSurface test
// after the two parallel globals were folded into one activePanelId.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Heavy renderer modules whose import-time side effects explode under jsdom,
// pulled in transitively via appStore. Mirrors the hook tests.
vi.mock('./terminal/terminalRegistry', () => ({
  terminalRegistry: { release: vi.fn(), setPendingTransfer: vi.fn(), dispose: vi.fn() },
}))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import {
  setActivePanel,
  getActivePanelId,
  clearActivePanelIfMatches,
} from './activePanel'
import { placementForActivePanel } from '../stores/appStore'
import { useAppStore } from '../stores/appStore'
import { getOrCreateWorkspaceDockStore } from './workspace/dockRegistry'
import { registerCanvasOps, unregisterCanvasOps } from '../stores/appStore'
import { createCanvasOps } from './canvas/canvasBridge'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../stores/canvasStore'

beforeEach(() => {
  setActivePanel(null)
})

describe('activePanel store', () => {
  it('sets and reads the active panel id', () => {
    setActivePanel('p1')
    expect(getActivePanelId()).toBe('p1')
    setActivePanel('p2')
    expect(getActivePanelId()).toBe('p2')
  })

  it('clearActivePanelIfMatches only clears the matching panel', () => {
    setActivePanel('keep')
    clearActivePanelIfMatches('other')
    expect(getActivePanelId()).toBe('keep')
    clearActivePanelIfMatches('keep')
    expect(getActivePanelId()).toBeNull()
  })
})

describe('placementForActivePanel', () => {
  const wsId = 'ws-active-panel-test'

  beforeEach(() => {
    useAppStore.setState({ selectedWorkspaceId: wsId })
  })

  it('returns undefined when nothing is active', () => {
    expect(placementForActivePanel()).toBeUndefined()
  })

  it('targets the exact dock stack a docked active panel lives in', () => {
    const dock = getOrCreateWorkspaceDockStore(wsId)
    dock.getState().dockPanel('docked-1', 'left')
    const location = dock.getState().getPanelLocation('docked-1')
    expect(location?.type).toBe('dock')

    setActivePanel('docked-1')
    expect(placementForActivePanel()).toEqual({
      target: 'dock',
      zone: 'left',
      stackId: location?.type === 'dock' ? location.stackId : '',
    })
  })

  it('falls back to the default canvas placement for a non-docked active panel', () => {
    // A panel with no dock location (e.g. a canvas node, or the canvas itself)
    // → undefined, which placePanel reads as the default canvas placement.
    setActivePanel('not-docked')
    expect(placementForActivePanel()).toBeUndefined()
  })

  it('uses the default canvas placement when a CANVAS is active, despite its center-zone dock location', () => {
    // The canvas panel is itself docked in the center zone, so it has a dock
    // location — but a create while it's active must land ON the canvas, not as
    // a sibling tab. The canvas ops registry distinguishes it.
    const canvasId = 'canvas-1'
    const dock = getOrCreateWorkspaceDockStore(wsId)
    dock.getState().dockPanel(canvasId, 'center')
    expect(dock.getState().getPanelLocation(canvasId)?.type).toBe('dock')
    registerCanvasOps(canvasId, createCanvasOps(getOrCreateCanvasStoreForPanel(canvasId)))

    setActivePanel(canvasId)
    expect(placementForActivePanel()).toBeUndefined()

    unregisterCanvasOps(canvasId)
    releaseCanvasStoreForPanel(canvasId)
  })
})
