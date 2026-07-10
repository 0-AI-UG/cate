// @vitest-environment jsdom
// =============================================================================
// Cold-restart restore of a detached CANVAS window: buildRestoredCanvasState
// must reconstruct the canvas's layout + children from a DetachedDockWindowSnapshot
// so the window restores populated (not empty). Child terminal scrollback replay
// is NOT wired here — the shell arms every terminal panel (children included) by
// its stable panelId on restore, identical to the main window.
//
// Identifies the canvas as the TOP-LEVEL dock panel (the one in dockState.zones)
// and treats every OTHER dw.panels entry as a child.
// =============================================================================

import { describe, expect, it } from 'vitest'
import type { DetachedDockWindowSnapshot, PanelState, DockStateSnapshot } from '../../../shared/types'
import { buildRestoredCanvasState } from './session'

function dockStateWith(panelId: string): DockStateSnapshot {
  return {
    zones: {
      center: { layout: { type: 'tabs', id: 'stack-center', panelIds: [panelId], activeIndex: 0 } },
    } as DockStateSnapshot['zones'],
  }
}

function makeSnapshot(): DetachedDockWindowSnapshot {
  const canvasId = 'canvas-1'
  const panels: Record<string, PanelState> = {
    [canvasId]: { id: canvasId, type: 'canvas', title: 'Sub-canvas', isDirty: false },
    'child-term': { id: 'child-term', type: 'terminal', title: 'zsh', isDirty: false },
    'child-editor': { id: 'child-editor', type: 'editor', title: 'file.ts', isDirty: false },
  }
  return {
    dockState: dockStateWith(canvasId),
    panels,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    workspaceId: 'ws-1',
    terminalCwds: { 'child-term': '/work/child' },
    canvasStates: {
      [canvasId]: {
        nodes: {
          'node-1': {
            id: 'node-1',
            panelId: 'child-term',
            origin: { x: 10, y: 20 },
            size: { width: 300, height: 200 },
          } as never,
        },
        viewportOffset: { x: 5, y: 6 },
        zoomLevel: 1.25,
      },
    },
  }
}

describe('buildRestoredCanvasState', () => {
  it('reconstructs nodes/viewport + child panels for the canvas (no replay hints here)', () => {
    const dw = makeSnapshot()
    const topLevelIds = new Set(['canvas-1'])
    const result = buildRestoredCanvasState(dw, dw.panels['canvas-1'], topLevelIds)

    expect(result).toBeDefined()
    expect(result!.zoomLevel).toBe(1.25)
    expect(result!.viewportOffset).toEqual({ x: 5, y: 6 })
    expect(Object.keys(result!.nodes)).toEqual(['node-1'])

    // Children = everything in dw.panels EXCEPT the top-level canvas panel.
    expect(Object.keys(result!.childPanels).sort()).toEqual(['child-editor', 'child-term'])
    expect(result!.childPanels['canvas-1' as string]).toBeUndefined()

    // Scrollback replay is armed by the shell (by panelId), not encoded here.
    expect(result!.childTerminals).toBeUndefined()
  })

  it('returns undefined when the top-level panel is not a canvas', () => {
    const dw = makeSnapshot()
    const nonCanvas: PanelState = { id: 'term-top', type: 'terminal', title: 'zsh', isDirty: false }
    expect(buildRestoredCanvasState(dw, nonCanvas, new Set(['term-top']))).toBeUndefined()
  })

})
