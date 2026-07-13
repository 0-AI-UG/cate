// =============================================================================
// Regression: the cross-window panel report (setupWindowPanelSync) attributes a
// canvas's children to it via canvasChildMap, which the detached-window overview
// reads to nest each child under its canvas.
//
// 1. parentCanvasId must come from the per-node mini-dock's LIVE authority
//    (getLiveNodeDockLayout), not the canvas store's stale raw node.dockLayout
//    projection — otherwise a node whose seed panelId was cleared reports flat.
//
// 2. The report must RE-FIRE when canvas/dock layout changes, not only on
//    appStore changes. Dragging a dock tab ONTO a canvas (addNode + undockPanel)
//    mutates the canvas + dock stores while ws.panels is unchanged, so an
//    appStore-only subscription left the report stale and the moved terminal
//    rendered at base level instead of nested ("only the first terminal on a
//    canvas gets the indentation; the second is at root level").
//
// 3. The report contains only PLACED panels (same partition rules as the local
//    tree) and stamps the DERIVED row label — ghost records used to surface in
//    other windows as phantom rows, and titleless browser/editor panels
//    reported an empty title that rendered as the bare panel type.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

beforeEach(() => {
  const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
  g.window = g.window ?? {}
})

import { useAppStore } from '../../stores/appStore'
import { useStatusStore } from '../../stores/statusStore'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../../stores/canvasStore'
import { createDockStore } from '../../stores/dockStore'
import { registerWorkspaceDockStore, releaseWorkspaceDockStore } from './dockRegistry'
import { registerNodeDockStore, unregisterNodeDockStore } from '../../panels/nodeDockRegistry'
import { setupWindowPanelSync } from './windowPanelSync'
import type { WindowPanelReport, PanelState } from '../../../shared/types'

function panel(id: string, type: PanelState['type'], worktreeId?: string): PanelState {
  return { id, type, title: id, worktreeId } as PanelState
}

const tick = () => new Promise((r) => setTimeout(r, 50))

describe('windowPanelSync — canvas child parentCanvasId', () => {
  it('attributes a node whose panel lives only in the LIVE per-node dock (stale raw projection)', async () => {
    const reports: WindowPanelReport[][] = []
    ;(window as any).electronAPI = {
      reportWindowPanels: vi.fn(async (r: WindowPanelReport[]) => { reports.push(r) }),
    }

    const ws = 'ws-livedock'
    useAppStore.setState({
      workspaces: [{
        id: ws, name: 'W', color: '', rootPath: '/x', rootPathError: null,
        isRootPathPending: false, worktrees: [],
        panels: { cv: panel('cv', 'canvas'), t1: panel('t1', 'terminal'), t2: panel('t2', 'terminal') },
      } as any],
      selectedWorkspaceId: ws,
    } as any)

    const store = getOrCreateCanvasStoreForPanel('cv')
    store.getState().addNode('t1', 'terminal', { x: 0, y: 0 })
    // Node whose seed panelId was cleared; its real panel lives in the live mini-dock.
    store.setState((s: any) => ({
      nodes: { ...s.nodes, n2: { id: 'n2', panelId: '', origin: { x: 200, y: 0 }, size: { width: 100, height: 100 }, zOrder: 5, creationIndex: 5, dockLayout: null } },
    }))
    const nodeDock = createDockStore()
    nodeDock.getState().dockPanel('t2', 'center')
    registerNodeDockStore('cv', 'n2', nodeDock)

    const stop = setupWindowPanelSync()
    await tick()

    const byId = Object.fromEntries(reports[reports.length - 1].filter((r) => r.workspaceId === ws).map((r) => [r.panelId, r]))
    expect(byId.t1?.parentCanvasId).toBe('cv')
    expect(byId.t2?.parentCanvasId).toBe('cv')

    stop()
    unregisterNodeDockStore('cv', 'n2')
    releaseCanvasStoreForPanel('cv')
  })

  it('carries each panel\'s worktreeId so the overview can tint detached rows', async () => {
    const reports: WindowPanelReport[][] = []
    ;(window as any).electronAPI = {
      reportWindowPanels: vi.fn(async (r: WindowPanelReport[]) => { reports.push(r) }),
    }

    const ws = 'ws-wt'
    useAppStore.setState({
      workspaces: [{
        id: ws, name: 'W', color: '', rootPath: '/x', rootPathError: null,
        isRootPathPending: false, worktrees: [],
        panels: { t1: panel('t1', 'terminal', 'wt-feature'), t2: panel('t2', 'terminal') },
      } as any],
      selectedWorkspaceId: ws,
    } as any)

    const stop = setupWindowPanelSync()
    await tick()

    const byId = Object.fromEntries(reports[reports.length - 1].filter((r) => r.workspaceId === ws).map((r) => [r.panelId, r]))
    expect(byId.t1?.worktreeId).toBe('wt-feature')
    expect(byId.t2?.worktreeId).toBeUndefined()

    stop()
  })

  it('carries live agent state + name, and re-reports when it changes (no appStore change)', async () => {
    const reports: WindowPanelReport[][] = []
    ;(window as any).electronAPI = {
      reportWindowPanels: vi.fn(async (r: WindowPanelReport[]) => { reports.push(r) }),
    }

    const ws = 'ws-agent'
    useAppStore.setState({
      workspaces: [{
        id: ws, name: 'W', color: '', rootPath: '/x', rootPathError: null,
        isRootPathPending: false, worktrees: [],
        panels: { a1: panel('a1', 'agent'), t2: panel('t2', 'terminal') },
      } as any],
      selectedWorkspaceId: ws,
    } as any)
    const status = useStatusStore.getState()
    status.setAgentState(ws, 'a1', 'running', 'Claude Code')
    status.setAgentPresent(ws, 'a1', true)

    const stop = setupWindowPanelSync()
    await tick()

    let byId = Object.fromEntries(reports[reports.length - 1].filter((r) => r.workspaceId === ws).map((r) => [r.panelId, r]))
    expect(byId.a1?.agentState).toBe('running')
    expect(byId.a1?.agentName).toBe('Claude Code')
    expect(byId.t2?.agentState).toBeUndefined()

    // A status-only change (agent goes from running → awaiting) must re-fire the
    // report even though ws.panels is untouched.
    reports.length = 0
    useStatusStore.getState().setAgentState(ws, 'a1', 'waitingForInput', 'Claude Code')
    await new Promise((r) => setTimeout(r, 300)) // past the 200ms report debounce
    expect(reports.length).toBeGreaterThan(0)
    byId = Object.fromEntries(reports[reports.length - 1].filter((r) => r.workspaceId === ws).map((r) => [r.panelId, r]))
    expect(byId.a1?.agentState).toBe('waitingForInput')

    stop()
  })

  it('re-reports when a panel is moved ONTO the canvas (canvas/dock change, no appStore change)', async () => {
    const reports: WindowPanelReport[][] = []
    ;(window as any).electronAPI = {
      reportWindowPanels: vi.fn(async (r: WindowPanelReport[]) => { reports.push(r) }),
    }

    const ws = 'ws-move'
    useAppStore.setState({
      workspaces: [{
        id: ws, name: 'W', color: '', rootPath: '/x', rootPathError: null,
        isRootPathPending: false, worktrees: [],
        panels: { cv: panel('cv', 'canvas'), t1: panel('t1', 'terminal'), t2: panel('t2', 'terminal') },
      } as any],
      selectedWorkspaceId: ws,
    } as any)

    // Canvas starts with t1 on it; t2 lives as a top-level dock tab (sibling to the canvas).
    const store = getOrCreateCanvasStoreForPanel('cv')
    store.getState().addNode('t1', 'terminal', { x: 0, y: 0 })
    const dock = createDockStore()
    dock.getState().dockPanel('cv', 'center')
    dock.getState().dockPanel('t2', 'center')
    registerWorkspaceDockStore(ws, dock)

    const stop = setupWindowPanelSync()
    await tick()

    // Initial: t1 nested, t2 top-level.
    let byId = Object.fromEntries(reports[reports.length - 1].filter((r) => r.workspaceId === ws).map((r) => [r.panelId, r]))
    expect(byId.t1?.parentCanvasId).toBe('cv')
    expect(byId.t2?.parentCanvasId).toBeUndefined()

    const before = reports.length

    // User drags the t2 dock tab onto the canvas: addNode + undockPanel. NEITHER
    // touches the appStore (ws.panels is unchanged), so an appStore-only
    // subscription would never re-report.
    store.getState().addNode('t2', 'terminal', { x: 300, y: 0 })
    dock.getState().undockPanel('t2')
    await new Promise((r) => setTimeout(r, 300)) // past the 200ms report debounce

    expect(reports.length).toBeGreaterThan(before) // a re-report actually fired
    byId = Object.fromEntries(reports[reports.length - 1].filter((r) => r.workspaceId === ws).map((r) => [r.panelId, r]))
    expect(byId.t2?.parentCanvasId).toBe('cv') // now nested under the canvas

    stop()
    releaseWorkspaceDockStore(ws)
    releaseCanvasStoreForPanel('cv')
  })
})

describe('windowPanelSync — placed-only report + derived titles', () => {
  it('omits ghost records (in ws.panels but placed in no dock/canvas) and keeps placed ones', async () => {
    const reports: WindowPanelReport[][] = []
    ;(window as any).electronAPI = {
      reportWindowPanels: vi.fn(async (r: WindowPanelReport[]) => { reports.push(r) }),
    }

    const ws = 'ws-ghost'
    useAppStore.setState({
      workspaces: [{
        id: ws, name: 'W', color: '', rootPath: '/x', rootPathError: null,
        isRootPathPending: false, worktrees: [],
        panels: { cv: panel('cv', 'canvas'), t1: panel('t1', 'terminal'), ghost: panel('ghost', 'terminal') },
      } as any],
      selectedWorkspaceId: ws,
    } as any)

    // The workspace's dock store places cv + t1; `ghost` is referenced nowhere.
    const dock = createDockStore()
    dock.getState().dockPanel('cv', 'center')
    dock.getState().dockPanel('t1', 'center')
    registerWorkspaceDockStore(ws, dock)

    const stop = setupWindowPanelSync()
    await tick()

    const ids = reports[reports.length - 1].filter((r) => r.workspaceId === ws).map((r) => r.panelId)
    expect(ids).toContain('cv')
    expect(ids).toContain('t1')
    expect(ids).not.toContain('ghost')

    stop()
    releaseWorkspaceDockStore(ws)
  })

  it('stamps the derived label: a titleless browser reports its URL, a titleless editor its basename', async () => {
    const reports: WindowPanelReport[][] = []
    ;(window as any).electronAPI = {
      reportWindowPanels: vi.fn(async (r: WindowPanelReport[]) => { reports.push(r) }),
    }

    const ws = 'ws-titles'
    useAppStore.setState({
      workspaces: [{
        id: ws, name: 'W', color: '', rootPath: '/x', rootPathError: null,
        isRootPathPending: false, worktrees: [],
        panels: {
          b1: {
            id: 'b1', type: 'browser', title: '', isDirty: false,
            tabs: [{ id: 'tab1', url: 'https://example.com/docs', title: '' }],
            activeTabId: 'tab1',
          } as PanelState,
          e1: { id: 'e1', type: 'editor', title: '', isDirty: false, filePath: '/x/src/main.ts' } as PanelState,
        },
      } as any],
      selectedWorkspaceId: ws,
    } as any)

    const stop = setupWindowPanelSync()
    await tick()

    const byId = Object.fromEntries(reports[reports.length - 1].filter((r) => r.workspaceId === ws).map((r) => [r.panelId, r]))
    expect(byId.b1?.title).toBe('https://example.com/docs')
    expect(byId.e1?.title).toBe('main.ts')

    stop()
  })
})
