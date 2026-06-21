// @vitest-environment jsdom
// =============================================================================
// Tests for the single panel resolver/reveal: resolvePanelLocation + revealPanel.
//
// Before this module the same probe (dock lookup -> canvas nodeForPanel) was
// re-implemented ad hoc with a different order per call site. These tests pin the
// fixed order (dock first, then canvas) and that revealPanel makes the panel the
// canonical activePanelId.
//
// Clean exit: the non-retry reveal path arms no timers; teardown releases the
// dock store, unregisters canvas ops, clears caches/active panel, resets appStore.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePanelLocation, revealPanel, resolvePanelById } from './panelReveal'
import {
  registerCanvasOps,
  unregisterCanvasOps,
  invalidateWorkspaceCanvasCache,
} from './canvasAccess'
import {
  getOrCreateWorkspaceDockStore,
  releaseWorkspaceDockStore,
} from './dockRegistry'
import { useAppStore } from '../../stores/appStore'
import { getActivePanelId, setActivePanel } from '../activePanel'
import { applyCanvasChildPanels } from '../canvas/applyCanvasChildPanels'
import {
  registerNodeDockStore,
  unregisterNodeDockStore,
} from '../../panels/nodeDockRegistry'
import { createDockStore } from '../../stores/dockStore'
import { computeTerminalHasFocus } from '../../hooks/useShortcuts'

const WS = 'ws-reveal'
const CANVAS = 'canvas-1'
const CHILD = 'canvas-child'

function setWorkspace() {
  useAppStore.setState({
    selectedWorkspaceId: WS,
    workspaces: [
      {
        id: WS,
        rootPath: '/repo',
        panels: { [CANVAS]: { id: CANVAS, type: 'canvas', title: 'Canvas' } },
      } as any,
    ],
  } as any)
}

let focusSpy: ReturnType<typeof vi.fn>
function registerCanvasContaining(childPanelId: string) {
  focusSpy = vi.fn()
  registerCanvasOps(CANVAS, {
    focusPanelNode: focusSpy,
    storeApi: {
      getState: () => ({
        nodeForPanel: (id: string) => (id === childPanelId ? 'node-1' : undefined),
      }),
    },
  } as any)
}

beforeEach(() => {
  ;(window as any).electronAPI = {}
  setWorkspace()
})

afterEach(() => {
  unregisterCanvasOps(CANVAS)
  invalidateWorkspaceCanvasCache(WS)
  releaseWorkspaceDockStore(WS)
  setActivePanel(null)
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: null } as any)
  vi.restoreAllMocks()
})

describe('resolvePanelLocation', () => {
  it('resolves a docked panel to its zone + stack (dock probed first)', () => {
    const dock = getOrCreateWorkspaceDockStore(WS)
    dock.getState().dockPanel('p-term', 'left')

    const loc = resolvePanelLocation(WS, 'p-term')
    expect(loc?.kind).toBe('dock')
    if (loc?.kind === 'dock') {
      expect(loc.zone).toBe('left')
      expect(typeof loc.stackId).toBe('string')
    }
  })

  it('resolves a canvas-hosted panel via nodeForPanel when not docked', () => {
    registerCanvasContaining(CHILD)
    const loc = resolvePanelLocation(WS, CHILD)
    expect(loc).toEqual({ kind: 'canvas', canvasPanelId: CANVAS })
  })

  it('returns null when the panel lives nowhere', () => {
    registerCanvasContaining(CHILD)
    expect(resolvePanelLocation(WS, 'ghost')).toBeNull()
  })
})

describe('revealPanel', () => {
  it('reveals a docked panel and makes it the active panel', async () => {
    const dock = getOrCreateWorkspaceDockStore(WS)
    dock.getState().dockPanel('p-term', 'left')

    const ok = await revealPanel(WS, 'p-term')
    expect(ok).toBe(true)
    expect(dock.getState().zones.left.visible).toBe(true)
    expect(getActivePanelId()).toBe('p-term')
  })

  it('reveals a canvas-hosted panel by focusing its node', async () => {
    registerCanvasContaining(CHILD)
    const ok = await revealPanel(WS, CHILD)
    expect(ok).toBe(true)
    expect(focusSpy).toHaveBeenCalledWith(CHILD)
    expect(getActivePanelId()).toBe(CHILD)
  })

  // Regression: revealing a child of a canvas that is NOT the active center tab
  // used to focus the node but leave the other canvas on screen, so the click
  // did nothing visible. Revealing the child must bring its hosting canvas's own
  // dock tab to the front first.
  it('brings the hosting canvas tab to front when a different canvas is active', async () => {
    registerCanvasContaining(CHILD)
    const dock = getOrCreateWorkspaceDockStore(WS)
    // Two canvases share the center stack; the OTHER one is active (docked last).
    dock.getState().dockPanel(CANVAS, 'center')
    dock.getState().dockPanel('canvas-other', 'center')
    const stackId = (dock.getState().zones.center.layout as any).id as string
    expect((dock.getState().zones.center.layout as any).panelIds).toEqual([CANVAS, 'canvas-other'])
    expect((dock.getState().zones.center.layout as any).activeIndex).toBe(1) // canvas-other

    const ok = await revealPanel(WS, CHILD)
    expect(ok).toBe(true)
    expect(focusSpy).toHaveBeenCalledWith(CHILD)
    // The hosting canvas tab (CANVAS, index 0) is now the active center tab.
    const stack = dock.getState().zones.center.layout as any
    expect(stack.panelIds[stack.activeIndex]).toBe(CANVAS)
    expect(stackId).toBeTypeOf('string')
    expect(getActivePanelId()).toBe(CHILD)
  })

  it('returns false (non-retry) when the panel cannot be located', async () => {
    registerCanvasContaining(CHILD)
    expect(await revealPanel(WS, 'ghost')).toBe(false)
    expect(getActivePanelId()).toBeNull()
  })
})

describe('resolvePanelById', () => {
  it('resolves a panel from the selected workspace', () => {
    expect(resolvePanelById(CANVAS)).toMatchObject({ id: CANVAS, type: 'canvas' })
  })

  it('resolves a child seeded via applyCanvasChildPanels (detached-window sim)', () => {
    // Detached windows have no bootstrapped workspace; applyCanvasChildPanels
    // merges child PanelState records into the (stub) selected workspace.
    applyCanvasChildPanels(WS, {
      'child-term': { id: 'child-term', type: 'terminal', title: 'T', isDirty: false },
    })
    expect(resolvePanelById('child-term')).toMatchObject({ id: 'child-term', type: 'terminal' })
  })

  it('returns undefined for an unknown id', () => {
    expect(resolvePanelById('nope')).toBeUndefined()
  })
})

describe('computeTerminalHasFocus', () => {
  const NODE = 'node-tf'

  afterEach(() => {
    unregisterNodeDockStore(CANVAS, NODE)
  })

  function seedPanels(panels: Record<string, any>) {
    useAppStore.setState((s: any) => ({
      workspaces: s.workspaces.map((w: any) =>
        w.id === WS ? { ...w, panels: { ...w.panels, ...panels } } : w,
      ),
    }))
  }

  it('returns false when nothing is active', () => {
    setActivePanel(null)
    expect(computeTerminalHasFocus()).toBe(false)
  })

  it('returns true when the active panel is a terminal', () => {
    seedPanels({ t1: { id: 't1', type: 'terminal', title: 'T', isDirty: false } })
    setActivePanel('t1')
    expect(computeTerminalHasFocus()).toBe(true)
  })

  it('returns false when the active panel is an editor', () => {
    seedPanels({ e1: { id: 'e1', type: 'editor', title: 'E', isDirty: false } })
    setActivePanel('e1')
    expect(computeTerminalHasFocus()).toBe(false)
  })

  it('descends into the focused node dock when a canvas container is active', () => {
    // Active panel is the CANVAS container; the focused node holds a terminal
    // tab. The old node.panelId (seed) path would miss this — the dock active
    // leaf is the source of truth.
    seedPanels({ 'node-term': { id: 'node-term', type: 'terminal', title: 'T', isDirty: false } })

    // Canvas ops: registry membership makes getActiveCanvasPanelId resolve to
    // CANVAS, and the (derived) focused node points at our node — an active
    // single-node selection.
    registerCanvasOps(CANVAS, {
      storeApi: { getState: () => ({ selection: [NODE], selectionActive: true }) },
    } as any)

    const nodeDock = createDockStore()
    nodeDock.getState().dockPanel('node-term', 'center')
    registerNodeDockStore(CANVAS, NODE, nodeDock)

    setActivePanel(CANVAS)
    expect(computeTerminalHasFocus()).toBe(true)
  })
})
