// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createCanvasStore } from '../../stores/canvasStore'
import { createDockStore } from '../../stores/dockStore'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import type { ProjectWorkspaceFile, ProjectSessionFile, PanelState } from '../../../shared/types'
import { projectFilesToSnapshot, buildWorkspaceFile } from './sessionSerialize'
import { dockWindowsFromSession } from './sessionLoad'

function legacyWorkspace(): ProjectWorkspaceFile {
  const canvas = createCanvasStore()
  canvas.getState().addNode('removed', 'browser', { x: 0, y: 0 }, { width: 300, height: 200 })
  canvas.getState().addNode('kept', 'editor', { x: 400, y: 0 }, { width: 300, height: 200 })
  const dock = createDockStore()
  dock.getState().dockPanel('removed', 'bottom')
  dock.getState().dockPanel('kept', 'bottom')
  return {
    version: 1, name: 'Old project', color: '',
    panels: { removed: { type: 'extension', title: 'Old extension' }, kept: { type: 'editor', title: 'Editor' } },
    canvases: { canvas: { id: 'canvas', canvasNodes: canvas.getState().nodes, zoomLevel: 1, viewportOffset: { x: 0, y: 0 } } },
    dockState: dock.getState().getSnapshot(),
  }
}

describe('removed panel restoration', () => {
  it('drops obsolete panels and empty canvas nodes, preserving the selected surviving dock tab', () => {
    const ws = legacyWorkspace()
    const restored = projectFilesToSnapshot(ws, null, '/repo')
    expect(Object.keys(restored.panels!)).toEqual(['kept'])
    const nodes = Object.values(restored.canvases!.canvas.canvasNodes)
    expect(nodes).toHaveLength(1)
    expect(collectPanelIds(nodes[0].dockLayout)).toEqual(['kept'])
    expect(restored.dockState!.zones.bottom.layout).toMatchObject({ panelIds: ['kept'], activeIndex: 0 })
    expect(JSON.stringify(buildWorkspaceFile(restored, '/repo'))).not.toContain('removed')
    expect(ws.panels!.removed.type).toBe('extension') // input is not mutated
  })

  it('cleans detached windows and skips windows containing only obsolete panels', () => {
    const ws = legacyWorkspace()
    const panels = Object.fromEntries(Object.entries(ws.panels!).map(([id, ref]) => [id, { ...ref, id, isDirty: false }])) as Record<string, PanelState>
    const mixed = {
      panels, workspaceId: 'ws', bounds: { x: 0, y: 0, width: 800, height: 600 },
      dockState: ws.dockState!,
      canvasStates: { canvas: { nodes: ws.canvases!.canvas.canvasNodes, zoomLevel: 1, viewportOffset: { x: 0, y: 0 } } },
    }
    const session: ProjectSessionFile = { version: 1, panels: {}, dockWindows: [mixed, { ...mixed, panels: { removed: panels.removed } }] }
    const windows = dockWindowsFromSession(session)
    expect(windows).toHaveLength(1)
    expect(Object.keys(windows[0].panels)).toEqual(['kept'])
    expect(Object.keys(windows[0].canvasStates.canvas.nodes)).toHaveLength(1)
    expect(collectPanelIds(windows[0].dockState.zones.bottom.layout)).toEqual(['kept'])
  })
})
