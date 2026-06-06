// @vitest-environment jsdom
// =============================================================================
// Session round-trip regression: a canvas node whose mini-dock hosts two tabbed
// panels [A, B] must survive buildWorkspaceFile -> projectFilesToSnapshot with
// BOTH panel records intact and the layout tree preserved (modulo regenerated
// stack ids done later at restore). B must NOT be dropped.
//
// This is the core bug the refactor fixes: node.dockLayout was never persisted,
// so only the seed panel (A) round-tripped and B silently vanished on restart.
// =============================================================================

import { describe, expect, it } from 'vitest'
import type { SessionSnapshot, DockLayoutNode, PanelState } from '../../../shared/types'
import { buildWorkspaceFile, projectFilesToSnapshot, remapNodeDockLayout } from './session'

function twoTabLayout(): DockLayoutNode {
  return { type: 'tabs', id: 'stack-AB', panelIds: ['A', 'B'], activeIndex: 1 }
}

function makeSnapshot(): SessionSnapshot {
  const dockPanels: Record<string, PanelState> = {
    // The EXTRA tabbed panel (B) is persisted as a dock-record PanelState — the
    // seed panel (A) rides on its NodeSnapshot.
    B: { id: 'B', type: 'terminal', title: 'Terminal B', isDirty: false },
  }
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Test',
    rootPath: '/repo',
    zoomLevel: 1,
    viewportOffset: { x: 0, y: 0 },
    nodes: [
      {
        panelId: 'A',
        panelType: 'terminal',
        title: 'Terminal A',
        origin: { x: 10, y: 20 },
        size: { width: 400, height: 300 },
        dockLayout: twoTabLayout(),
      },
    ],
    dockPanels,
  }
}

describe('session dock-layout round-trip', () => {
  it('persists node.dockLayout through buildWorkspaceFile', () => {
    const ws = buildWorkspaceFile(makeSnapshot(), '/repo')
    expect(ws.canvas.nodes).toHaveLength(1)
    const node = ws.canvas.nodes[0]
    expect(node.dockLayout).toEqual(twoTabLayout())
    // The extra panel B survives as a dock-record ref.
    expect(ws.dockPanels?.B?.type).toBe('terminal')
  })

  it('round-trips dockLayout + both panel records (B not dropped)', () => {
    const ws = buildWorkspaceFile(makeSnapshot(), '/repo')
    const snap = projectFilesToSnapshot(ws, null, '/repo')

    // Seed node A still present with its two-tab layout.
    const nodeA = snap.nodes.find((n) => n.panelId === 'A')
    expect(nodeA).toBeDefined()
    expect(nodeA!.dockLayout).toEqual(twoTabLayout())
    expect((nodeA!.dockLayout as any).panelIds).toEqual(['A', 'B'])

    // Extra panel B survives as a dockPanels record (not as its own node).
    expect(snap.dockPanels?.B).toBeDefined()
    expect(snap.dockPanels?.B.title).toBe('Terminal B')
    expect(snap.nodes.find((n) => n.panelId === 'B')).toBeUndefined()
  })

  it('legacy session (no dockLayout) round-trips without crashing', () => {
    const legacy = makeSnapshot()
    legacy.nodes[0].dockLayout = undefined
    const ws = buildWorkspaceFile(legacy, '/repo')
    expect(ws.canvas.nodes[0].dockLayout).toBeUndefined()
    const snap = projectFilesToSnapshot(ws, null, '/repo')
    expect(snap.nodes[0].dockLayout).toBeUndefined()
  })

  it('restore remap mints fresh stack ids while preserving the panel set', () => {
    const ws = buildWorkspaceFile(makeSnapshot(), '/repo')
    const snap = projectFilesToSnapshot(ws, null, '/repo')
    const nodeA = snap.nodes.find((n) => n.panelId === 'A')!
    // Simulate restore: the seed panel A is remapped to a fresh id; B keeps its id.
    const map = new Map<string, string>([['A', 'A-new']])
    const remapped = remapNodeDockLayout(nodeA.dockLayout, map)!
    expect(remapped.type).toBe('tabs')
    expect((remapped as any).panelIds).toEqual(['A-new', 'B'])
    expect((remapped as any).activeIndex).toBe(1)
    // Stack id regenerated (no collision with other nodes' stacks).
    expect((remapped as any).id).not.toBe('stack-AB')
  })
})
