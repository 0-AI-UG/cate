// @vitest-environment jsdom
// =============================================================================
// Session round-trip regression: a canvas node whose mini-dock hosts two tabbed
// panels [A, B] must survive buildWorkspaceFile -> projectFilesToSnapshot with
// BOTH panel records intact and the node's dockLayout tree preserved.
//
// Under the unified canvas model, node geometry + dockLayout live in
// `canvases[id].canvasNodes` and every placed panel (A and B alike) is a record
// in `panels`. There is no separate primary-canvas node list to drop B from.
// =============================================================================

import { describe, expect, it } from 'vitest'
import type { SessionSnapshot, DockLayoutNode, PanelState } from '../../../shared/types'
import { buildWorkspaceFile, projectFilesToSnapshot } from './session'

function twoTabLayout(): DockLayoutNode {
  return { type: 'tabs', id: 'stack-AB', panelIds: ['A', 'B'], activeIndex: 1 }
}

function makeSnapshot(): SessionSnapshot {
  const panels: Record<string, PanelState> = {
    A: { id: 'A', type: 'terminal', title: 'Terminal A', isDirty: false },
    B: { id: 'B', type: 'terminal', title: 'Terminal B', isDirty: false },
  }
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Test',
    rootPath: '/repo',
    panels,
    canvases: {
      cv: {
        id: 'cv',
        canvasNodes: {
          'node-A': {
            id: 'node-A',
            panelId: 'A',
            origin: { x: 10, y: 20 },
            size: { width: 400, height: 300 },
            zOrder: 0,
            creationIndex: 0,
            dockLayout: twoTabLayout(),
          },
        },
        zoomLevel: 1,
        viewportOffset: { x: 0, y: 0 },
      },
    },
  }
}

describe('session dock-layout round-trip', () => {
  it('persists node.dockLayout through buildWorkspaceFile', () => {
    const ws = buildWorkspaceFile(makeSnapshot(), '/repo')
    const node = ws.canvases?.cv.canvasNodes['node-A']
    expect(node?.dockLayout).toEqual(twoTabLayout())
    // Both panels survive as records.
    expect(ws.panels?.A?.type).toBe('terminal')
    expect(ws.panels?.B?.type).toBe('terminal')
  })

  it('round-trips dockLayout + both panel records (B not dropped)', () => {
    const ws = buildWorkspaceFile(makeSnapshot(), '/repo')
    const snap = projectFilesToSnapshot(ws, null, '/repo')

    // Node A still present with its two-tab layout.
    const nodeA = snap.canvases?.cv.canvasNodes['node-A']
    expect(nodeA).toBeDefined()
    expect(nodeA!.dockLayout).toEqual(twoTabLayout())
    expect((nodeA!.dockLayout as DockLayoutNode & { panelIds: string[] }).panelIds).toEqual(['A', 'B'])

    // Both panel records survive (A is the node's seed, B is its tabbed sibling).
    expect(snap.panels?.A).toBeDefined()
    expect(snap.panels?.B).toBeDefined()
    expect(snap.panels?.B.title).toBe('Terminal B')
  })

  it('legacy node (no dockLayout) round-trips without crashing', () => {
    const legacy = makeSnapshot()
    legacy.canvases!.cv.canvasNodes['node-A'].dockLayout = null
    const ws = buildWorkspaceFile(legacy, '/repo')
    expect(ws.canvases?.cv.canvasNodes['node-A'].dockLayout).toBeNull()
    const snap = projectFilesToSnapshot(ws, null, '/repo')
    expect(snap.canvases?.cv.canvasNodes['node-A'].dockLayout).toBeNull()
  })
})
