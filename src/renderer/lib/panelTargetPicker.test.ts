vi.mock('./terminal/terminalRegistry', () => ({ terminalRegistry: { dispose: vi.fn(), disposeWorkspace: vi.fn() } }))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../stores/appStore'
import { createDockStore } from '../stores/dockStore'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../stores/canvasStore'
import { registerWorkspaceDockStore, releaseWorkspaceDockStore } from './workspace/dockRegistry'
import { getActivePanelId, setActivePanel } from './activePanel'
import { requestPanelTarget } from './panelTargetPicker'
import { useSettingsStore } from '../stores/settingsStore'

const menu = vi.fn()
const ids = ['first', 'second', 'orphan']
let dock: ReturnType<typeof createDockStore>
let workspaceId: string
const originalSetting = useSettingsStore.getState().placementPicker

function addPanel(id: string, type: 'canvas' | 'terminal' | 'review' = 'terminal') {
  const ws = useAppStore.getState().workspaces[0]
  useAppStore.setState({ workspaces: [{ ...ws, panels: { ...ws.panels, [id]: { id, type, title: id, isDirty: false } } }] })
}
function addCanvas(id: string) {
  addPanel(id, 'canvas')
  dock.getState().dockPanel(id, 'center')
  const canvas = getOrCreateCanvasStoreForPanel(id)
  canvas.getState().setContainerSize({ width: 1200, height: 800 })
  return canvas
}
function addChild(canvasId: string, id: string) {
  addPanel(id)
  return getOrCreateCanvasStoreForPanel(canvasId).getState().addNode(id, 'terminal', { x: 0, y: 0 })
}
async function pending() {
  // requestPanelTarget awaits revealPanel before starting the transaction.
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  for (const id of ids) releaseCanvasStoreForPanel(id)
  releaseWorkspaceDockStore(workspaceId)
  setActivePanel(null)
  useSettingsStore.setState({ placementPicker: originalSetting })
  vi.unstubAllGlobals()
})

// Detached renderers have a window-local workspace and register their own dock.
// Exercise the same public request against both owning-window configurations.
describe.each(['main', 'detached'])('%s window target routing', (owner) => {
  beforeEach(() => {
    workspaceId = `${owner}-workspace`
    useAppStore.setState({ selectedWorkspaceId: workspaceId, workspaces: [{ id: workspaceId, name: owner, color: '', rootPath: '/repo', panels: {} }] })
    dock = createDockStore()
    registerWorkspaceDockStore(workspaceId, dock)
    setActivePanel(null)
    menu.mockReset()
    vi.stubGlobal('window', { electronAPI: { showContextMenu: menu } })
  })

  it.each(['new', 'both', 'existing'] as const)('uses and reveals the source canvas for %s requests', async (availability) => {
    const first = addCanvas('first')
    addCanvas('second')
    const sourceNode = addChild('first', 'source')
    addChild('second', 'other-canvas')
    addPanel('docked')
    dock.getState().dockPanel('docked', 'right')
    setActivePanel('second')
    const result = requestPanelTarget({ workspaceId, sourcePanelId: 'source', panelType: 'terminal', availability })
    await pending()
    expect(getActivePanelId()).toBe('first')
    expect(first.getState().nodeForPanel('source')).toBe(sourceNode)
    expect(first.getState().pendingPanelTarget?.existing.map(p => p.panelId)).toEqual(availability === 'new' ? [] : ['source'])
    expect(first.getState().pendingPanelTarget!.candidates.length > 0).toBe(availability !== 'existing')
    first.getState().cancelPanelTarget()
    expect(await result).toBeNull()
    expect(menu).not.toHaveBeenCalled()
  })

  it('routes a source tab in a canvas node to its containing canvas', async () => {
    const canvas = addCanvas('first')
    const node = addChild('first', 'source')
    addPanel('sibling')
    canvas.getState().setNodeDockLayout(node, { id: 'tabs', type: 'tabs', panelIds: ['source', 'sibling'], activeIndex: 1 })
    const result = requestPanelTarget({ workspaceId, sourcePanelId: 'sibling', panelType: 'terminal', availability: 'both' })
    await pending()
    expect(canvas.getState().pendingPanelTarget?.existing.map(p => p.panelId)).toEqual(['source', 'sibling'])
    canvas.getState().selectExistingPanelTarget('source')
    expect(await result).toEqual({ kind: 'existing', panelId: 'source' })
  })

  it('treats a docked canvas source as a canvas, including an empty canvas with the setting off', async () => {
    const canvas = addCanvas('first')
    useSettingsStore.setState({ placementPicker: false })
    const result = requestPanelTarget({ workspaceId, sourcePanelId: 'first', panelType: 'terminal', availability: 'new' })
    await pending()
    const candidate = canvas.getState().pendingPanelTarget!.candidates[0]
    canvas.getState().selectNewPanelTarget(0)
    expect(await result).toEqual({ kind: 'new', placement: { target: 'canvas', canvasPanelId: 'first', position: candidate.point, size: candidate.size } })
  })

  it.each([false, true])('uses the exact source dock stack (canvas present: %s)', async (withCanvas) => {
    if (withCanvas) addCanvas('first')
    addPanel('source')
    dock.getState().dockPanel('source', 'right')
    const location = dock.getState().getPanelLocation('source')!
    if (location.type !== 'dock') throw new Error('Source must be docked')
    const result = await requestPanelTarget({ workspaceId, sourcePanelId: 'source', panelType: 'terminal', availability: 'new' })
    expect(result).toEqual({ kind: 'new', placement: { target: 'dock', zone: 'right', stackId: location.stackId } })
    expect(menu).not.toHaveBeenCalled()
  })

  it.each(['both', 'existing'] as const)('offers dock selection consistently for %s', async (availability) => {
    addCanvas('first')
    addChild('first', 'canvas-terminal')
    addPanel('source', 'review')
    addPanel('terminal')
    dock.getState().dockPanel('source', 'right')
    dock.getState().dockPanel('terminal', 'center')
    menu.mockResolvedValue('terminal')
    expect(await requestPanelTarget({ workspaceId, sourcePanelId: 'source', panelType: 'terminal', availability })).toEqual({ kind: 'existing', panelId: 'terminal' })
    expect(menu).toHaveBeenCalledWith([
      ...(availability === 'both' ? [{ id: '__new', label: 'New Terminal' }] : []),
      { id: 'terminal', label: 'terminal' },
    ])
  })

  it('cancels a dock menu without creating a panel', async () => {
    addPanel('source')
    dock.getState().dockPanel('source', 'center')
    menu.mockResolvedValue(null)
    expect(await requestPanelTarget({ workspaceId, sourcePanelId: 'source', panelType: 'terminal', availability: 'both' })).toBeNull()
  })

  it('overlay chooses the first docked canvas, reveals it, and ignores prior focus', async () => {
    const first = addCanvas('first')
    const second = addCanvas('second')
    addChild('first', 'first-terminal')
    addChild('second', 'second-terminal')
    setActivePanel('second')
    const result = requestPanelTarget({ workspaceId, source: 'overlay', panelType: 'terminal', availability: 'both' })
    await pending()
    expect(getActivePanelId()).toBe('first')
    expect(first.getState().pendingPanelTarget?.existing.map(p => p.panelId)).toEqual(['first-terminal'])
    expect(second.getState().pendingPanelTarget).toBeNull()
    first.getState().selectExistingPanelTarget('first-terminal')
    expect(await result).toEqual({ kind: 'existing', panelId: 'first-terminal' })
  })

  it('reveals a hidden side-zone canvas when the center has none', async () => {
    addPanel('first', 'canvas')
    dock.getState().dockPanel('first', 'right')
    if (dock.getState().zones.right.visible) dock.getState().toggleZone('right')
    const result = requestPanelTarget({ workspaceId, source: 'overlay', panelType: 'terminal', availability: 'new' })
    await pending()
    expect(dock.getState().zones.right.visible).toBe(true)
    const canvas = getOrCreateCanvasStoreForPanel('first')
    expect(canvas.getState().pendingPanelTarget).not.toBeNull()
    canvas.getState().cancelPanelTarget()
    expect(await result).toBeNull()
  })

  it.each(['new', 'both'] as const)('overlay without a docked canvas creates directly for %s', async (availability) => {
    addPanel('orphan', 'canvas')
    addPanel('source')
    dock.getState().dockPanel('source', 'right')
    setActivePanel('source')
    expect(await requestPanelTarget({ workspaceId, source: 'overlay', panelType: 'terminal', availability })).toEqual({ kind: 'new', placement: { target: 'dock', zone: 'center' } })
    expect(menu).not.toHaveBeenCalled()
  })

  it('missing source and no canvas falls back to center dock', async () => {
    expect(await requestPanelTarget({ workspaceId, sourcePanelId: 'gone', panelType: 'terminal', availability: 'both' })).toEqual({ kind: 'new', placement: { target: 'dock', zone: 'center' } })
    expect(await requestPanelTarget({ workspaceId, panelType: 'terminal', availability: 'existing' })).toBeNull()
  })
})
