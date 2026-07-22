// =============================================================================
// closeDockWindowPanel — the detached shell's close-tab flow. Regression tests
// for the confirmation matrix, in particular the canvas branch: closing a
// canvas tab in a detached window MUST route through confirmCloseCanvas (the
// move/delete/cancel child fan-out) exactly like closePanelWithConfirm does in
// the main window. Before this helper existed the shell ran only the dirty /
// running-terminal gates, so a canvas tab's children were torn down silently.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PanelState, WorkspaceState } from '../../shared/types'

const h = vi.hoisted(() => ({
  releaseSpy: vi.fn(),
  disposeSpy: vi.fn(),
}))

vi.mock('../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

vi.mock('../lib/terminal/terminalRegistry', () => ({
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

vi.mock('../../cateAgent/renderer/codingSessionRegistry', () => ({
  disposeCateAgentPanel: vi.fn(),
  getCateAgentPanelSession: vi.fn(),
  saveCateAgentPanelSession: vi.fn(),
}))

import { useAppStore } from '../stores/appStore'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../stores/canvasStore'
import { createDockStore } from '../stores/dockStore'
import { collectPanelIds } from '../../shared/collectPanelIds'
import { closeDockWindowPanel } from './dockWindowClosePanel'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const confirmCloseCanvasDialog = vi.fn()
const confirmUnsavedChanges = vi.fn()

function panel(id: string, type: PanelState['type'], extra?: Partial<PanelState>): PanelState {
  return { id, type, title: id, isDirty: false, ...extra } as PanelState
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
  confirmCloseCanvasDialog.mockReset()
  confirmUnsavedChanges.mockReset()
  h.releaseSpy.mockClear()
  h.disposeSpy.mockClear()
  const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
  g.window = g.window ?? {}
  g.window.electronAPI = {
    confirmCloseCanvas: confirmCloseCanvasDialog,
    confirmUnsavedChanges,
  }
})

// ---------------------------------------------------------------------------
// Canvas tab — the regression
// ---------------------------------------------------------------------------

describe('closeDockWindowPanel — canvas tab', () => {
  it('routes through the confirmCloseCanvas dialog and cancel aborts everything', async () => {
    const ws = 'dwc-canvas-cancel'
    seedWorkspace(ws, [panel('cv', 'canvas'), panel('t1', 'terminal')])
    const canvasStore = getOrCreateCanvasStoreForPanel('cv')
    canvasStore.getState().addNode('t1', 'terminal', { x: 0, y: 0 })
    const dock = createDockStore()
    dock.getState().dockPanel('cv', 'center')
    confirmCloseCanvasDialog.mockResolvedValue('cancel')

    const ok = await closeDockWindowPanel(ws, 'cv', dock)

    expect(ok).toBe(false)
    // The dialog saw the child and the fact this is the only canvas here.
    expect(confirmCloseCanvasDialog).toHaveBeenCalledWith({ panelCount: 1, isLast: true })
    // Nothing torn down: canvas still docked, both records intact, PTY alive.
    expect(collectPanelIds(dock.getState().zones.center.layout)).toContain('cv')
    expect(panelsOf(ws)['cv']).toBeDefined()
    expect(panelsOf(ws)['t1']).toBeDefined()
    expect(h.disposeSpy).not.toHaveBeenCalled()

    releaseCanvasStoreForPanel('cv')
  })

  it('close choice tears down the canvas AND its children (records dropped, PTYs killed)', async () => {
    const ws = 'dwc-canvas-close'
    seedWorkspace(ws, [panel('cv', 'canvas'), panel('t1', 'terminal')])
    const canvasStore = getOrCreateCanvasStoreForPanel('cv')
    canvasStore.getState().addNode('t1', 'terminal', { x: 0, y: 0 })
    const dock = createDockStore()
    dock.getState().dockPanel('cv', 'center')
    confirmCloseCanvasDialog.mockResolvedValue('close')

    const ok = await closeDockWindowPanel(ws, 'cv', dock)

    expect(ok).toBe(true)
    expect(collectPanelIds(dock.getState().zones.center.layout)).not.toContain('cv')
    expect(panelsOf(ws)['cv']).toBeUndefined()
    expect(panelsOf(ws)['t1']).toBeUndefined()
    // Close semantics, not transfer: the child terminal's PTY is disposed.
    expect(h.disposeSpy).toHaveBeenCalledWith('t1')
    expect(h.releaseSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Non-canvas tabs — the pre-existing gates still apply
// ---------------------------------------------------------------------------

describe('closeDockWindowPanel — non-canvas tabs', () => {
  it('dirty editor: cancel in the unsaved-changes dialog aborts the close', async () => {
    const ws = 'dwc-dirty-cancel'
    seedWorkspace(ws, [panel('e1', 'editor', { isDirty: true })])
    const dock = createDockStore()
    dock.getState().dockPanel('e1', 'center')
    confirmUnsavedChanges.mockResolvedValue('cancel')

    const ok = await closeDockWindowPanel(ws, 'e1', dock)

    expect(ok).toBe(false)
    expect(confirmUnsavedChanges).toHaveBeenCalledTimes(1)
    expect(collectPanelIds(dock.getState().zones.center.layout)).toContain('e1')
    expect(panelsOf(ws)['e1']).toBeDefined()
  })

  it('idle terminal closes without prompting: undocked, record dropped, PTY disposed', async () => {
    const ws = 'dwc-terminal-close'
    seedWorkspace(ws, [panel('t1', 'terminal')])
    const dock = createDockStore()
    dock.getState().dockPanel('t1', 'center')

    const ok = await closeDockWindowPanel(ws, 't1', dock)

    expect(ok).toBe(true)
    expect(confirmCloseCanvasDialog).not.toHaveBeenCalled()
    expect(collectPanelIds(dock.getState().zones.center.layout)).not.toContain('t1')
    expect(panelsOf(ws)['t1']).toBeUndefined()
    expect(h.disposeSpy).toHaveBeenCalledWith('t1')
    expect(h.releaseSpy).not.toHaveBeenCalled()
  })

  it('ghost tab with no panel record: still undocks and reports closed', async () => {
    const ws = 'dwc-ghost'
    seedWorkspace(ws, [])
    const dock = createDockStore()
    dock.getState().dockPanel('ghost', 'center')

    const ok = await closeDockWindowPanel(ws, 'ghost', dock)

    expect(ok).toBe(true)
    expect(collectPanelIds(dock.getState().zones.center.layout)).not.toContain('ghost')
  })
})
