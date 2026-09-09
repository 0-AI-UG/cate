import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { createDockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import { useDockTabActions } from './useDockTabActions'
import { mergeRightDock, useNavigationPanels } from './useNavigationPanels'
import { findFirstTabStack } from '../stores/dockTreeUtils'
import { collectPanelIds } from '../../shared/collectPanelIds'
import DockZone from './DockZone'
import { registerWorkspaceDockStore, releaseWorkspaceDockStore } from '../lib/workspace/dockRegistry'
import SurfacePicker from '../panels/SurfacePicker'
import { getPanelDef } from '../panels/registry'
import { buildWorkspaceFile, buildSessionFile, projectFilesToSnapshot } from '../lib/workspace/sessionSerialize'

vi.mock('../canvas/WorktreePill', () => ({ WorktreePill: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const appBefore = useAppStore.getState()
const uiBefore = useUIStore.getState()
let root: Root
let host: HTMLDivElement
let dock: ReturnType<typeof createDockStore>
let actions: ReturnType<typeof useDockTabActions>
let stackId = 'initial'
function Harness({ localOnly = false }: { localOnly?: boolean }) {
  const panels = useAppStore((s) => s.workspaces[0].panels)
  const stack = dock.getState().zones.center.layout!
  const findStack = (node: typeof stack): ReturnType<typeof findFirstTabStack> => node.type === 'tabs'
    ? node.id === stackId ? node : null
    : node.children.map(findStack).find(Boolean) ?? null
  actions = useDockTabActions({
    stack: findStack(stack)!, zone: 'center', dockStoreApi: dock, workspaceId: 'test', localOnly,
    getPanelProp: (id) => panels[id],
    onClosePanel: (id) => {
      dock.getState().undockPanel(id)
      useAppStore.setState((state) => ({ workspaces: state.workspaces.map((ws) => ({ ...ws, panels: Object.fromEntries(Object.entries(ws.panels).filter(([key]) => key !== id)) })) }))
    },
  })
  return <SurfacePicker onSelect={actions.chooseSurface} excludePanelTypes={localOnly ? ['canvas'] : undefined} />
}
function NavigationHarness() { useNavigationPanels(); return null }
beforeEach(() => {
  useAppStore.setState({ selectedWorkspaceId: 'test', workspaces: [{ id: 'test', name: 'Test', rootPath: '/test', color: '', panels: { original: { id: 'original', type: 'canvas', title: 'Canvas', isDirty: false } } }] })
  useUIStore.setState({ requestedNavigationView: null })
  dock = createDockStore()
  registerWorkspaceDockStore('test', dock)
  dock.getState().dockPanel('original', 'center')
  stackId = findFirstTabStack(dock.getState().zones.center.layout)!.id
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount()); host.remove()
  releaseWorkspaceDockStore('test')
  useAppStore.setState(appBefore, true); useUIStore.setState(uiBefore, true)
})

it.each([false, true])('splits into a picker and replaces it in place with a Files panel (local=%s)', (localOnly) => {
  act(() => root.render(<Harness localOnly={localOnly} />))
  act(() => actions.splitPanel())
  const layout = dock.getState().zones.center.layout!
  expect(layout.type).toBe('split')
  if (layout.type !== 'split') throw new Error('Expected split')
  const pickerStack = findFirstTabStack(layout.children[1])!
  const placeholder = pickerStack.panelIds[0]
  expect(useAppStore.getState().workspaces[0].panels[placeholder].type).toBe('surface')
  expect(collectPanelIds(layout)).toEqual(['original', placeholder])
  stackId = pickerStack.id
  act(() => root.render(<Harness localOnly={localOnly} />))
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Canvas')).toBe(!localOnly)
  act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Files')!.click())
  const ids = collectPanelIds(dock.getState().zones.center.layout)
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBe('original')
  expect(useAppStore.getState().workspaces[0].panels[ids[1]].type).toBe('editor')
  expect(useAppStore.getState().workspaces[0].panels[placeholder]).toBeUndefined()
  const updated = dock.getState().zones.center.layout!
  expect(updated.type === 'split' && findFirstTabStack(updated.children[1])!.id).toBe(pickerStack.id)
})

it('migrates the complete right layout and opens shortcuts in the center without duplicates', () => {
  dock.getState().dockPanel('legacy', 'right')
  const rightLayout = dock.getState().zones.right.layout
  act(() => root.render(<DockStoreProvider store={dock}><NavigationHarness /></DockStoreProvider>))
  const zones = dock.getState().zones
  expect(zones.right.layout).toBeNull()
  expect(zones.center.layout?.type === 'split' && zones.center.layout.children[1]).toBe(rightLayout)
  expect(mergeRightDock(zones)).toBe(zones)
  act(() => useUIStore.getState().requestNavigationView('search'))
  act(() => useUIStore.getState().requestNavigationView('search'))
  const panels = Object.values(useAppStore.getState().workspaces[0].panels)
  expect(panels.filter((p) => p.type === 'search')).toHaveLength(0)
  expect(panels.filter((p) => p.type === 'editor')).toHaveLength(1)
  expect(panels.find((p) => p.type === 'editor')?.sidebarView).toBe('search')
  act(() => useUIStore.getState().requestNavigationView('explorer'))
  expect(Object.values(useAppStore.getState().workspaces[0].panels).find((p) => p.type === 'editor')?.sidebarView).toBe('explorer')
  expect(dock.getState().zones.right.layout).toBeNull()
})

it('persists picker, Files, Search and Source Control as movable panel records', () => {
  for (const type of ['surface', 'navigation', 'search', 'sourceControl'] as const) {
    expect(getPanelDef(type).canLiveOnCanvas).toBe(true)
    const id = getPanelDef(type).create({ workspaceId: 'test', placement: { target: 'none' } })!
    dock.getState().dockPanel(id, 'center')
  }
  const workspace = useAppStore.getState().workspaces[0]
  const snapshot = { workspaceName: 'Test', rootPath: '/test', panels: workspace.panels, dockState: dock.getState().getSnapshot() }
  const restored = projectFilesToSnapshot(JSON.parse(JSON.stringify(buildWorkspaceFile(snapshot, '/test'))), JSON.parse(JSON.stringify(buildSessionFile(snapshot))), '/test')
  expect(Object.values(restored.panels!).map((p) => p.type)).toEqual(['canvas', 'surface', 'editor', 'search', 'sourceControl'])
  expect(restored.dockState).toEqual(snapshot.dockState)
})

function FullDock() {
  const workspace = useAppStore((s) => s.workspaces[0])
  return <DockStoreProvider store={dock}>
    <DockZone position="center" workspaceId="test"
      renderPanel={(id) => <div>{workspace.panels[id]?.title} content</div>}
      getPanelTitle={(id) => workspace.panels[id]?.title ?? ''}
      onClosePanel={(id) => useAppStore.getState().closePanel('test', id)}
    />
  </DockStoreProvider>
}

it('opens the picker from the split button and closes its placeholder through the panel lifecycle', () => {
  act(() => root.render(<FullDock />))
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Split Right"]')!.click())
  expect(host.querySelector('[role="group"][aria-label="Open a surface"]')).not.toBeNull()
  act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Source Control'))!.click())
  expect(host.textContent).toContain('Source Control content')
  expect(host.querySelector('[role="group"][aria-label="Open a surface"]')).toBeNull()
  const panels = Object.values(useAppStore.getState().workspaces[0].panels)
  expect(panels.map((panel) => panel.type)).toEqual(['canvas', 'sourceControl'])
  expect(collectPanelIds(dock.getState().zones.center.layout)).toHaveLength(2)
})

it('places the new-tab menu after the last tab and creates only the selected type', () => {
  act(() => root.render(<FullDock />))
  const button = host.querySelector<HTMLButtonElement>('[aria-label="New Tab"]')!
  const tab = host.querySelector('[data-tab-panel-id="original"]')!
  expect(tab.parentElement).toBe(button.parentElement)
  expect(tab.nextElementSibling).toBe(button)
  act(() => button.click())
  expect(collectPanelIds(dock.getState().zones.center.layout)).toEqual(['original'])
  const menu = document.querySelector('[role="menu"]')!
  expect(menu).not.toBeNull()
  expect([...menu.querySelectorAll('button')].some((item) => item.textContent === 'Search')).toBe(false)
  const files = [...menu.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Files')!
  act(() => files.click())
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(Object.values(useAppStore.getState().workspaces[0].panels).map((panel) => panel.type)).toEqual(['canvas', 'editor'])
  act(() => button.click())
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(button)
  act(() => button.click())
  act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('refreshes canvas chrome when panel records settle without a layout change', async () => {
  const { default: DockTabStack } = await import('./DockTabStack')
  const stack = findFirstTabStack(dock.getState().zones.center.layout)!
  const canvas = useAppStore.getState().workspaces[0].panels.original
  useAppStore.setState((state) => ({ workspaces: [{ ...state.workspaces[0], panels: {} }] }))
  act(() => root.render(<DockStoreProvider store={dock}>
    <DockTabStack stack={stack} zone="center" getPanelTitle={() => 'Canvas'} renderPanel={() => <div>Canvas content</div>} />
  </DockStoreProvider>))
  expect(host.querySelector('.dock-tab-bar-floating')).toBeNull()
  act(() => useUIStore.getState().setShowUsage(true))
  act(() => useAppStore.getState().addPanel('test', canvas))
  act(() => useUIStore.getState().setShowUsage(false))
  expect(host.querySelector('.dock-tab-bar-floating')).not.toBeNull()
  expect(host.querySelector('.dock-tab-bar')?.classList.contains('border-b')).toBe(false)
})

it('offers maximize and restore in each split header', () => {
  act(() => root.render(<FullDock />))
  expect(host.querySelector('[aria-label="Maximize split"]')).toBeNull()
  act(() => (host.querySelector('[aria-label="Split Right"]') as HTMLButtonElement).click())
  const buttons = host.querySelectorAll<HTMLButtonElement>('[aria-label="Maximize split"]')
  expect(buttons).toHaveLength(2)
  const layout = dock.getState().zones.center.layout
  act(() => buttons[1].click())
  const restore = host.querySelector<HTMLButtonElement>('[aria-label="Restore split"]')!
  expect(restore.getAttribute('aria-pressed')).toBe('true')
  expect(dock.getState().zones.center.layout).toBe(layout)
  act(() => restore.click())
  expect(dock.getState().maximizedStackId).toBeNull()
  expect(host.querySelectorAll('[aria-label="Maximize split"]')).toHaveLength(2)
})


it('splitting a maximized pane reveals the new pane', () => {
  act(() => root.render(<FullDock />))
  act(() => (host.querySelector('[aria-label="Split Right"]') as HTMLButtonElement).click())
  act(() => (host.querySelector('[aria-label="Maximize split"]') as HTMLButtonElement).click())
  expect(dock.getState().maximizedStackId).not.toBeNull()
  act(() => (host.querySelector('[aria-label="Split Right"]') as HTMLButtonElement).click())
  expect(dock.getState().maximizedStackId).toBeNull()
  expect(host.querySelectorAll('[aria-label="Maximize split"]')).toHaveLength(3)
})
