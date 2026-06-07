// @vitest-environment jsdom
// =============================================================================
// Multi-canvas persistence round-trip: a workspace with TWO canvas panels, each
// holding distinct nodes, must persist BOTH under their canvas-panel ids in
// SessionSnapshot.canvases / ProjectWorkspaceFile.canvases and restore both — so
// a never-mounted / non-primary canvas no longer loses its node layout, and its
// children aren't misattributed to the primary.
//
// These tests cover the PURE persistence seam (buildWorkspaceFile <->
// projectFilesToSnapshot): the primary canvas is just another entry in
// `canvases`, handled identically to a secondary one.
// =============================================================================

import { describe, expect, it } from 'vitest'
import type { SessionSnapshot, CanvasSnapshot, CanvasNodeState } from '../../../shared/types'
import { buildWorkspaceFile, projectFilesToSnapshot } from './session'

const PRIMARY = 'canvas-primary'
const SECONDARY = 'canvas-secondary'

function node(id: string, panelId: string): CanvasNodeState {
  return {
    id,
    panelId,
    origin: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    zOrder: 0,
    creationIndex: 0,
  }
}

function makeTwoCanvasSnapshot(): SessionSnapshot {
  const canvases: Record<string, CanvasSnapshot> = {
    [PRIMARY]: {
      id: PRIMARY,
      canvasNodes: { np: node('np', 'p-prim') },
      zoomLevel: 1,
      viewportOffset: { x: 0, y: 0 },
    },
    [SECONDARY]: {
      id: SECONDARY,
      canvasNodes: { ns: node('ns', 'p-sec') },
      zoomLevel: 2.5,
      viewportOffset: { x: 11, y: 22 },
    },
  }
  return {
    workspaceId: 'ws-1',
    workspaceName: 'Test',
    rootPath: '/repo',
    // Every canvas child is a record, keyed by panel id — primary and secondary
    // alike (recreated on restore; geometry lives in `canvases`).
    panels: {
      'p-prim': { id: 'p-prim', type: 'terminal', title: 'Primary term', isDirty: false },
      'p-sec': { id: 'p-sec', type: 'terminal', title: 'Secondary term', isDirty: false },
    },
    canvases,
  }
}

describe('multi-canvas persistence round-trip', () => {
  it('persists BOTH canvases under their panel ids via buildWorkspaceFile', () => {
    const ws = buildWorkspaceFile(makeTwoCanvasSnapshot(), '/repo')
    expect(ws.canvases).toBeDefined()
    expect(Object.keys(ws.canvases!).sort()).toEqual([PRIMARY, SECONDARY].sort())
    expect(Object.keys(ws.canvases![SECONDARY].canvasNodes)).toEqual(['ns'])
    expect(ws.canvases![SECONDARY].zoomLevel).toBe(2.5)
    expect(ws.canvases![SECONDARY].viewportOffset).toEqual({ x: 11, y: 22 })
  })

  it('round-trips BOTH canvases back onto the restored SessionSnapshot', () => {
    const ws = buildWorkspaceFile(makeTwoCanvasSnapshot(), '/repo')
    const snap = projectFilesToSnapshot(ws, null, '/repo')

    expect(snap.canvases).toBeDefined()
    // Primary still carries its node.
    expect(Object.keys(snap.canvases![PRIMARY].canvasNodes)).toEqual(['np'])
    // Secondary's distinct node survives under its OWN canvas id (not the primary).
    expect(Object.keys(snap.canvases![SECONDARY].canvasNodes)).toEqual(['ns'])
    expect(snap.canvases![SECONDARY].canvasNodes.ns.panelId).toBe('p-sec')
    // Both canvases' child panel records survive so restore can recreate them.
    expect(snap.panels?.['p-prim']?.title).toBe('Primary term')
    expect(snap.panels?.['p-sec']?.title).toBe('Secondary term')
  })
})
