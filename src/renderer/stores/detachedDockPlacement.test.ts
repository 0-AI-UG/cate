// =============================================================================
// Detached dock window placement — integration.
//
// A panel created while a detached dock window is focused must land in THAT
// window's own dock store. The window registers its local dock store under its
// (stub) workspace id, so the shared placement code (placePanel via
// createTerminal, and placementForActivePanel) targets it instead of an orphan.
// These tests drive the real appStore create flow + canvasAccess placement
// resolution against a registered store.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))
vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { dispose: vi.fn(), disposeWorkspace: vi.fn(), getEntry: vi.fn(), has: vi.fn(() => false) },
}))

import { useAppStore } from './appStore'
import { createDockStore } from './dockStore'
import { registerWorkspaceDockStore, releaseWorkspaceDockStore } from '../lib/workspace/dockRegistry'
import { placementForActivePanel, placementForPanel } from '../lib/workspace/canvasAccess'
import { setActivePanel } from '../lib/activePanel'
import { useWindowPanelStore } from './windowPanelStore'
import type { DockStore } from './dockStore'
import type { WindowPanelInfo } from '../../shared/types'

/** getPanelLocation narrowed to the dock case (throws if not docked). */
function dockLoc(store: ReturnType<typeof createDockStore>, panelId: string) {
  const loc = (store.getState() as DockStore).getPanelLocation(panelId)
  if (loc?.type !== 'dock') throw new Error(`expected ${panelId} to be docked, got ${loc?.type}`)
  return loc
}

describe('detached dock window panel placement', () => {
  const wsId = 'detached-dock-window'
  let localDock: ReturnType<typeof createDockStore>

  beforeEach(() => {
    const g = globalThis as unknown as { window?: { electronAPI?: unknown } }
    g.window = g.window ?? {}
    g.window.electronAPI = {}

    // Seed a stub workspace + register THIS window's dock store, mirroring a dock
    // window after onDockWindowInit (ensurePanelsInAppStore + registration).
    useAppStore.setState({
      workspaces: [{ id: wsId, name: 'Detached', color: '', rootPath: '/tmp/proj', panels: {} } as never],
      selectedWorkspaceId: wsId,
    })
    releaseWorkspaceDockStore(wsId)
    localDock = createDockStore()
    registerWorkspaceDockStore(wsId, localDock)
    setActivePanel(null)
    useWindowPanelStore.setState({ panels: [] })
  })

  it('docks a newly-created terminal into the window-registered dock store', () => {
    const panelId = useAppStore.getState().createTerminal(wsId)

    expect(useAppStore.getState().workspaces[0].panels[panelId]?.type).toBe('terminal')
    // Docked into THIS window's store (center zone), not orphaned.
    expect(localDock.getState().getPanelLocation(panelId)?.type).toBe('dock')
  })

  it('tabs a new panel into the active panel\'s stack', () => {
    // First terminal lands (and docks) in the window; make it the active panel.
    const first = useAppStore.getState().createTerminal(wsId)
    const firstLoc = dockLoc(localDock, first)
    setActivePanel(first)

    // placementForActivePanel resolves the active panel's dock stack against the
    // registered store — the exact placement the keyboard/palette create path uses.
    const placement = placementForActivePanel()
    expect(placement).toMatchObject({ target: 'dock', zone: firstLoc.zone })

    const second = useAppStore.getState().createTerminal(wsId, undefined, undefined, placement)
    const secondLoc = dockLoc(localDock, second)
    // Same zone AND same stack — the new tab joined the active one.
    expect(secondLoc.zone).toBe(firstLoc.zone)
    expect(secondLoc.stackId).toBe(firstLoc.stackId)
  })

  it('resolves an explicit detached consumer to its exact dock stack', () => {
    const source = useAppStore.getState().createTerminal(wsId)
    const sourceLoc = dockLoc(localDock, source)

    expect(placementForPanel(wsId, source)).toEqual({
      target: 'dock',
      zone: sourceLoc.zone,
      stackId: sourceLoc.stackId,
    })
  })

  it('places several created terminals into the window and numbers them', () => {
    const a = useAppStore.getState().createTerminal(wsId)
    const b = useAppStore.getState().createTerminal(wsId)

    const panels = useAppStore.getState().workspaces[0].panels
    expect(panels[a].title).toBe('Terminal 1')
    expect(panels[b].title).toBe('Terminal 2')
    expect(localDock.getState().getPanelLocation(a)?.type).toBe('dock')
    expect(localDock.getState().getPanelLocation(b)?.type).toBe('dock')
  })

  it('numbers new terminals uniquely across windows (counts detached ones)', () => {
    // A "Terminal 2" already lives in ANOTHER window for this workspace.
    const detached: WindowPanelInfo = {
      panelId: 'x', type: 'terminal', title: 'Terminal 2', workspaceId: wsId,
      ownerWindowId: 9, ownerWindowType: 'dock',
    }
    useWindowPanelStore.setState({ panels: [detached] })

    // The local workspace has none, but numbering must skip past the detached 2.
    const id = useAppStore.getState().createTerminal(wsId)
    expect(useAppStore.getState().workspaces[0].panels[id].title).toBe('Terminal 3')
  })
})
