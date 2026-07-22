// =============================================================================
// movePanelToNewWindow — the location-agnostic detach used by the sidebar
// workspace overview. Pins the removal matrix per source location:
//
//   • dock-located → undocked from the workspace dock store, record dropped;
//     when main REFUSES the detach (dragDetach → null) the source must be
//     completely untouched (detach-first, tear-down-after).
//   • canvas-located, sole occupant of its node → the node is removed.
//   • canvas-located but tabbed with siblings in the node's mini-dock → only
//     the target tab is undocked; the node (and siblings) remain.
//   • detaching the workspace's LAST canvas mints a fresh center canvas.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PanelState, WorkspaceState } from '../../../shared/types'

const h = vi.hoisted(() => ({
  releaseSpy: vi.fn(),
  disposeSpy: vi.fn(),
}))

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

vi.mock('../terminal/terminalRegistry', () => ({
  terminalRegistry: {
    ptyIdForPanel: () => null,
    panelIdForPty: () => null,
    workspaceIdForPty: () => undefined,
    dispose: (panelId: string) => h.disposeSpy(panelId),
    release: (panelId: string) => h.releaseSpy(panelId),
    disposeWorkspace: vi.fn(),
    has: () => false,
    getEntry: () => undefined,
    entries: () => [],
  },
}))

vi.mock('../../../cateAgent/renderer/codingSessionRegistry', () => ({
  disposeCateAgentPanel: vi.fn(),
  getCateAgentPanelSession: vi.fn(),
  saveCateAgentPanelSession: vi.fn(),
}))

import { useAppStore } from '../../stores/appStore'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../../stores/canvasStore'
import { createDockStore } from '../../stores/dockStore'
import { registerWorkspaceDockStore, releaseWorkspaceDockStore, getWorkspaceDockStore } from './dockRegistry'
import { registerNodeDockStore, unregisterNodeDockStore } from '../../panels/nodeDockRegistry'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { movePanelToNewWindow } from './movePanelToNewWindow'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dragDetach = vi.fn()

function panel(id: string, type: PanelState['type']): PanelState {
  return { id, type, title: id, isDirty: false } as PanelState
}

function seedWorkspace(wsId: string, panels: PanelState[]): void {
  useAppStore.setState({
    workspaces: [{
      id: wsId,
      name: 'W',
      color: '',
      rootPath: '/tmp/w',
      rootPathError: null,
      isRootPathPending: false,
      worktrees: [],
      panels: Object.fromEntries(panels.map((p) => [p.id, p])),
    } as unknown as WorkspaceState],
    selectedWorkspaceId: wsId,
  } as never)
}

function panelsOf(wsId: string): Record<string, PanelState> {
  return useAppStore.getState().workspaces.find((w) => w.id === wsId)?.panels ?? {}
}

const initialAppState = useAppStore.getState()

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  dragDetach.mockReset()
  h.releaseSpy.mockClear()
  h.disposeSpy.mockClear()
  const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
  g.window = g.window ?? {}
  g.window.electronAPI = { dragDetach }
})

// ---------------------------------------------------------------------------
// Dock-located panel
// ---------------------------------------------------------------------------

describe('movePanelToNewWindow — dock-located panel', () => {
  it('detach accepted → panel undocked and its record dropped', async () => {
    const ws = 'ws-dock-ok'
    seedWorkspace(ws, [panel('t1', 'terminal'), panel('t2', 'terminal')])
    const dock = createDockStore()
    dock.getState().dockPanel('t1', 'center')
    dock.getState().dockPanel('t2', 'center')
    registerWorkspaceDockStore(ws, dock)
    dragDetach.mockResolvedValue(3)

    const ok = await movePanelToNewWindow(ws, 't1')

    expect(ok).toBe(true)
    expect(dragDetach).toHaveBeenCalledTimes(1)
    expect(dragDetach).toHaveBeenCalledWith(expect.anything(), ws)
    const placed = collectPanelIds(dock.getState().zones.center.layout)
    expect(placed).not.toContain('t1')
    expect(placed).toContain('t2')
    expect(panelsOf(ws)['t1']).toBeUndefined()
    expect(panelsOf(ws)['t2']).toBeDefined()
    // Transfer, not close: the xterm is released, the PTY survives.
    expect(h.releaseSpy).toHaveBeenCalledWith('t1')
    expect(h.disposeSpy).not.toHaveBeenCalled()

    releaseWorkspaceDockStore(ws)
  })

  it('detach refused (dragDetach → null) → dock layout and record untouched', async () => {
    const ws = 'ws-dock-refused'
    seedWorkspace(ws, [panel('t1', 'terminal')])
    const dock = createDockStore()
    dock.getState().dockPanel('t1', 'center')
    registerWorkspaceDockStore(ws, dock)
    dragDetach.mockResolvedValue(null)

    const ok = await movePanelToNewWindow(ws, 't1')

    expect(ok).toBe(false)
    expect(collectPanelIds(dock.getState().zones.center.layout)).toContain('t1')
    expect(panelsOf(ws)['t1']).toBeDefined()
    expect(h.releaseSpy).not.toHaveBeenCalled()

    releaseWorkspaceDockStore(ws)
  })
})

// ---------------------------------------------------------------------------
// Canvas-located panel
// ---------------------------------------------------------------------------

describe('movePanelToNewWindow — canvas-located panel', () => {
  it('sole occupant of its node → the node is removed from the canvas store', async () => {
    const ws = 'ws-canvas-sole'
    seedWorkspace(ws, [panel('cv', 'canvas'), panel('t1', 'terminal')])
    const canvasStore = getOrCreateCanvasStoreForPanel('cv')
    const nodeId = canvasStore.getState().addNode('t1', 'terminal', { x: 0, y: 0 })
    dragDetach.mockResolvedValue(4)

    const ok = await movePanelToNewWindow(ws, 't1')

    expect(ok).toBe(true)
    expect(canvasStore.getState().nodes[nodeId]).toBeUndefined() // node gone
    expect(panelsOf(ws)['t1']).toBeUndefined()
    expect(panelsOf(ws)['cv']).toBeDefined() // the canvas itself stays

    releaseCanvasStoreForPanel('cv')
  })

  it('tabbed with a sibling in the node mini-dock → only the target tab is undocked, node remains', async () => {
    const ws = 'ws-canvas-tabs'
    seedWorkspace(ws, [panel('cv', 'canvas'), panel('t1', 'terminal'), panel('t2', 'terminal')])
    const canvasStore = getOrCreateCanvasStoreForPanel('cv')
    const nodeId = canvasStore.getState().addNode('t1', 'terminal', { x: 0, y: 0 })
    // The node's LIVE mini-dock hosts two tabbed panels.
    const nodeDock = createDockStore()
    nodeDock.getState().dockPanel('t1', 'center')
    nodeDock.getState().dockPanel('t2', 'center')
    registerNodeDockStore('cv', nodeId, nodeDock)
    dragDetach.mockResolvedValue(5)

    const ok = await movePanelToNewWindow(ws, 't1')

    expect(ok).toBe(true)
    expect(canvasStore.getState().nodes[nodeId]).toBeDefined() // node survives
    const placed = collectPanelIds(nodeDock.getState().zones.center.layout)
    expect(placed).not.toContain('t1')
    expect(placed).toContain('t2')
    expect(panelsOf(ws)['t1']).toBeUndefined()
    expect(panelsOf(ws)['t2']).toBeDefined()

    unregisterNodeDockStore('cv', nodeId)
    releaseCanvasStoreForPanel('cv')
  })

  it('canvas panel not placed anywhere → no detach, source untouched', async () => {
    const ws = 'ws-unplaced'
    seedWorkspace(ws, [panel('t1', 'terminal')]) // record only, no dock/canvas

    const ok = await movePanelToNewWindow(ws, 't1')

    expect(ok).toBe(false)
    expect(dragDetach).not.toHaveBeenCalled()
    expect(panelsOf(ws)['t1']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Last canvas
// ---------------------------------------------------------------------------

describe('movePanelToNewWindow — last canvas', () => {
  it('detaching the workspace\'s only canvas mints a fresh one', async () => {
    const ws = 'ws-last-canvas'
    seedWorkspace(ws, [panel('cv', 'canvas')])
    const dock = createDockStore()
    dock.getState().dockPanel('cv', 'center')
    registerWorkspaceDockStore(ws, dock)
    dragDetach.mockResolvedValue(6)

    const ok = await movePanelToNewWindow(ws, 'cv')

    expect(ok).toBe(true)
    expect(panelsOf(ws)['cv']).toBeUndefined()
    const canvases = Object.values(panelsOf(ws)).filter((p) => p.type === 'canvas')
    expect(canvases).toHaveLength(1) // a NEW canvas was minted
    expect(canvases[0].id).not.toBe('cv')
    for (const c of canvases) releaseCanvasStoreForPanel(c.id)

    releaseWorkspaceDockStore(ws)
    // getWorkspaceDockStore may have been recreated by placement — release again defensively.
    if (getWorkspaceDockStore(ws)) releaseWorkspaceDockStore(ws)
  })
})
