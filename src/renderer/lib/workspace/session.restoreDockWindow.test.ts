// @vitest-environment jsdom
// =============================================================================
// FIX: Session restore of a detached DOCK window must reconstruct the FULL
// window — every top-level tab from dw.dockState.zones (not just the first) —
// with each terminal tab seeded for scrollback replay and each canvas tab's
// children hydrated. buildDockWindowRestoreInit is the pure, testable core:
// given a DetachedDockWindowSnapshot it returns the top-level panel ids + the
// DockWindowInitPayload that DockWindowShell.onDockWindowInit replays.
// =============================================================================

import { describe, expect, it } from 'vitest'
import type { DetachedDockWindowSnapshot, PanelState, DockStateSnapshot, WindowDockState } from '../../../shared/types'
import { buildDockWindowRestoreInit } from './session'

const emptyZone = (position: 'left' | 'right' | 'bottom' | 'center') => ({
  position,
  visible: false,
  size: 0,
  layout: null,
})

/** A center zone whose single tab stack hosts the given panelIds (multi-tab). */
function multiTabDockState(panelIds: string[]): DockStateSnapshot {
  const zones: WindowDockState = {
    left: emptyZone('left'),
    right: emptyZone('right'),
    bottom: emptyZone('bottom'),
    center: {
      position: 'center',
      visible: true,
      size: 0,
      layout: { type: 'tabs', id: 'center-stack', panelIds, activeIndex: 0 },
    },
  }
  return { zones }
}

function makeMultiTabSnapshot(): DetachedDockWindowSnapshot {
  // Three top-level tabs: terminal, editor, canvas. The canvas has its own
  // children (a terminal + an editor) that live in dw.panels WITHOUT a zone ref.
  const panels: Record<string, PanelState> = {
    'top-term': { id: 'top-term', type: 'terminal', title: 'zsh', isDirty: false },
    'top-editor': { id: 'top-editor', type: 'editor', title: 'a.ts', isDirty: false },
    'top-canvas': { id: 'top-canvas', type: 'canvas', title: 'Board', isDirty: false },
    'canvas-child-term': { id: 'canvas-child-term', type: 'terminal', title: 'child-zsh', isDirty: false },
    'canvas-child-editor': { id: 'canvas-child-editor', type: 'editor', title: 'b.ts', isDirty: false },
  }
  return {
    dockState: multiTabDockState(['top-term', 'top-editor', 'top-canvas']),
    panels,
    bounds: { x: 100, y: 50, width: 900, height: 700 },
    workspaceId: 'ws-9',
    terminalCwds: {
      'top-term': '/work/top',
      'canvas-child-term': '/work/child',
    },
    canvasStates: {
      'top-canvas': {
        nodes: {
          'node-1': {
            id: 'node-1',
            panelId: 'canvas-child-term',
            origin: { x: 0, y: 0 },
            size: { width: 200, height: 150 },
          } as never,
        },
        viewportOffset: { x: 3, y: 4 },
        zoomLevel: 0.9,
      },
    },
  }
}

describe('buildDockWindowRestoreInit', () => {
  it('reconstructs ALL top-level tabs from the dock zones (not just the first)', () => {
    const dw = makeMultiTabSnapshot()
    const { topLevelPanelIds, initPayload } = buildDockWindowRestoreInit(dw)

    expect(topLevelPanelIds).toEqual(['top-term', 'top-editor', 'top-canvas'])
    // The full original layout is preserved (the multi-tab center stack).
    expect(initPayload.dockState).toEqual(dw.dockState.zones)
    // Every persisted panel record (top-level AND canvas children) is sent.
    expect(Object.keys(initPayload.panels).sort()).toEqual([
      'canvas-child-editor',
      'canvas-child-term',
      'top-canvas',
      'top-editor',
      'top-term',
    ])
    expect(initPayload.workspaceId).toBe('ws-9')
  })

  it('flags a cold restore and passes through per-panel cwds (replay is by panelId)', () => {
    const dw = makeMultiTabSnapshot()
    const { initPayload } = buildDockWindowRestoreInit(dw)

    // The shell arms scrollback replay for EVERY terminal panel by its stable
    // panelId when `restore` is set — no ptyId map. cwds (top-level AND canvas
    // children) ride along so respawned terminals land where they were.
    expect(initPayload.restore).toBe(true)
    expect(initPayload.terminalCwds).toEqual({
      'top-term': '/work/top',
      'canvas-child-term': '/work/child',
    })
  })

  it('hydrates each top-level canvas tab with its nodes + child panels', () => {
    const dw = makeMultiTabSnapshot()
    const { initPayload } = buildDockWindowRestoreInit(dw)

    const cs = initPayload.canvasStates?.['top-canvas']
    expect(cs).toBeDefined()
    expect(cs!.zoomLevel).toBe(0.9)
    expect(cs!.viewportOffset).toEqual({ x: 3, y: 4 })
    expect(Object.keys(cs!.nodes)).toEqual(['node-1'])
    // Canvas children = dw.panels NOT referenced by the zones.
    expect(Object.keys(cs!.childPanels).sort()).toEqual(['canvas-child-editor', 'canvas-child-term'])
    // Child terminal scrollback replay is NOT wired into the canvas state — the
    // shell arms every terminal panel (children included) by its panelId.
    expect(cs!.childTerminals).toBeUndefined()
  })

  it('identifies top-level panels from the zones, not Object.keys(panels)[0]', () => {
    // Put a canvas CHILD first in the panels map; it must NOT be treated as a tab.
    const dw = makeMultiTabSnapshot()
    const reordered: Record<string, PanelState> = {
      'canvas-child-term': dw.panels['canvas-child-term'],
      ...dw.panels,
    }
    dw.panels = reordered
    const { topLevelPanelIds } = buildDockWindowRestoreInit(dw)
    expect(topLevelPanelIds).not.toContain('canvas-child-term')
    expect(topLevelPanelIds).toEqual(['top-term', 'top-editor', 'top-canvas'])
  })

  it('does not synthesize placement for panels orphaned by an empty dock layout', () => {
    const dw = makeMultiTabSnapshot()
    dw.dockState = {
      zones: {
        left: emptyZone('left'),
        right: emptyZone('right'),
        bottom: emptyZone('bottom'),
        center: { position: 'center', visible: true, size: 0, layout: null },
      },
    }
    const { topLevelPanelIds } = buildDockWindowRestoreInit(dw)
    expect(topLevelPanelIds).toEqual([])
  })

  it('tolerates zones referencing a panel with no record (stale layout after an incomplete flush)', () => {
    const dw = makeMultiTabSnapshot()
    dw.dockState = multiTabDockState(['top-term', 'ghost-panel', 'top-canvas'])

    const { topLevelPanelIds, initPayload } = buildDockWindowRestoreInit(dw)

    // No throw, and no canvas state is fabricated for the missing record.
    expect(initPayload.canvasStates?.['ghost-panel']).toBeUndefined()
    expect(initPayload.canvasStates?.['top-canvas']).toBeDefined()
    expect(topLevelPanelIds).toContain('top-term')
  })

  // Asserts the DESIRED behavior and is marked `.fails`: a zone entry whose
  // panel record is gone currently rides through into topLevelPanelIds and the
  // restored layout, so the shell renders a tab backed by nothing. It should be
  // pruned at restore. Remove the marker when fixed.
  it.fails('prunes zone entries whose panel record is missing', () => {
    const dw = makeMultiTabSnapshot()
    dw.dockState = multiTabDockState(['top-term', 'ghost-panel', 'top-editor', 'top-canvas'])

    const { topLevelPanelIds, initPayload } = buildDockWindowRestoreInit(dw)

    expect(topLevelPanelIds).not.toContain('ghost-panel')
    const center = initPayload.dockState.center.layout
    expect(center && 'panelIds' in center ? center.panelIds : []).not.toContain('ghost-panel')
  })

  it('normalizes an empty terminalCwds map to undefined', () => {
    const dw = makeMultiTabSnapshot()
    dw.terminalCwds = {}
    const { initPayload } = buildDockWindowRestoreInit(dw)
    expect(initPayload.terminalCwds).toBeUndefined()
  })

  it('omits canvasStates entirely when no top-level tab is a canvas', () => {
    const dw = makeMultiTabSnapshot()
    dw.dockState = multiTabDockState(['top-term', 'top-editor'])

    const { topLevelPanelIds, initPayload } = buildDockWindowRestoreInit(dw)

    expect(topLevelPanelIds).toEqual(['top-term', 'top-editor'])
    expect(initPayload.canvasStates).toEqual({})
  })

  it('returns no top-level ids for a genuinely empty window (no panels)', () => {
    const dw = makeMultiTabSnapshot()
    dw.dockState = {
      zones: {
        left: emptyZone('left'),
        right: emptyZone('right'),
        bottom: emptyZone('bottom'),
        center: emptyZone('center'),
      },
    }
    dw.panels = {}
    const { topLevelPanelIds, initPayload } = buildDockWindowRestoreInit(dw)
    expect(topLevelPanelIds).toEqual([])
    expect(initPayload.canvasStates).toEqual({})
  })
})
