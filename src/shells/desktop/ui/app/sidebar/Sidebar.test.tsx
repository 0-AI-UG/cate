import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { WorkspaceEntry, WorkspaceList, WorkspaceListSnapshot } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../app'
import { INITIAL_UI_STATE, useUIStore } from '../state/uiStore'
import { Sidebar } from './Sidebar'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { createUiStateStore, installUiState, setUiState } from '../state/uiState'
import { noRuntimeUpdates } from '@client/connections/testing'
import { SidebarPage } from '../settings/pages/clientPages'

let host: HTMLDivElement
let root: Root

const entries: WorkspaceEntry[] = [
  { kind: 'local', id: 'local:/p/cate', root: '/p/cate', name: 'cate', lastOpenedAt: 2 },
  { kind: 'local', id: 'local:/p/site', root: '/p/site', name: 'site', lastOpenedAt: 1 },
  { kind: 'paired', id: 'paired:abc', runtimeId: 'abc', name: 'Shared', endpoints: [], pairedAt: 1, lastOpenedAt: null },
]

function fakeList() {
  let snapshot: WorkspaceListSnapshot = { entries, open: [] }
  const listeners = new Set<() => void>()
  const list = {
    getSnapshot: () => snapshot,
    subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) },
    get: (id: string) => snapshot.entries.find((e) => e.id === id),
    observe: vi.fn(),
    open: vi.fn(async (id: string) => {
      snapshot = { ...snapshot, open: [...snapshot.open, id] }
      for (const l of listeners) l()
    }),
    disconnect: vi.fn((id: string) => {
      snapshot = { ...snapshot, open: snapshot.open.filter((o) => o !== id) }
      for (const l of listeners) l()
    }),
    close: vi.fn(async (id: string) => {
      snapshot = { ...snapshot, entries: snapshot.entries.filter((e) => e.id !== id), open: snapshot.open.filter((o) => o !== id) }
      for (const l of listeners) l()
    }),
    reorder: vi.fn(async () => {}),
  }
  return list
}

let list: ReturnType<typeof fakeList>

const rowOf = (name: string) =>
  [...host.querySelectorAll('[role="treeitem"]')].find((el) => el.textContent?.includes(name)) as HTMLElement

const renderProjects = () => act(() => {
  setUiState('sidebarMode', 'projects')
  root.render(<Sidebar />)
})

beforeEach(async () => {
  const ui = createUiStateStore(createMemoryDeviceStore())
  await ui.load()
  installUiState(ui)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  list = fakeList()
  installClientApp({
    runtimeUpdates: noRuntimeUpdates,
    workspaces: list as unknown as WorkspaceList,
    connections: { get: () => undefined } as unknown as ClientApp['connections'],
    version: '2.1.0',
  })
  useUIStore.setState(INITIAL_UI_STATE)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  installClientApp(null)
  installUiState(null)
})

describe('Sidebar', () => {
  it('with no workspaces, the sidebar only says so: no headers, no "+"', () => {
    const none: WorkspaceListSnapshot = { entries: [], open: [] }
    const empty = { ...list, getSnapshot: () => none }
    installClientApp({
      runtimeUpdates: noRuntimeUpdates,
      workspaces: empty as unknown as WorkspaceList,
      connections: { get: () => undefined } as unknown as ClientApp['connections'],
      version: '2.1.0',
    })
    act(() => root.render(<Sidebar />))
    expect(host.querySelectorAll('[data-machine], [role="treeitem"]')).toHaveLength(0)
    expect(host.textContent).toContain('No workspaces yet')
    expect(host.querySelector('[aria-label="Open Workspace…"]')).not.toBeNull()
  })

  it('lists local and paired workspaces together with remote location context', () => {
    renderProjects()
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(3)
    expect(host.textContent).toContain('Shared')
    expect(host.querySelectorAll('[data-machine]')).toHaveLength(0)
    expect(rowOf('Shared').textContent).toContain('Remote computer')
    expect(host.querySelector('[aria-label="Open Workspace…"]')).not.toBeNull()
  })

  it('reconnects remembered local projects for threads without selecting them or dialing remote projects', async () => {
    await act(async () => { root.render(<Sidebar />) })
    expect(list.observe.mock.calls.map(([id]) => id)).toEqual(['local:/p/cate', 'local:/p/site'])
    expect(list.open).not.toHaveBeenCalled()
    expect(useUIStore.getState().selectedWorkspaceId).toBeNull()
  })

  it('defaults to Threads and restores the Projects choice from device UI state', async () => {
    const device = createMemoryDeviceStore()
    const ui = createUiStateStore(device)
    await ui.load()
    act(() => {
      installUiState(ui)
      root.render(<><Sidebar /><SidebarPage /></>)
    })
    expect(host.querySelector('[aria-label="Search threads"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Filter threads by project"]')?.textContent).toContain('All projects')
    expect(host.querySelector('[aria-label="Settled threads"]')).not.toBeNull()
    expect(host.querySelector('[role="tree"][aria-label="Workspaces"]')).toBeNull()
    const select = host.querySelector<HTMLSelectElement>('select')!
    act(() => {
      select.value = 'projects'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(host.querySelector('[aria-label="Search threads"]')).toBeNull()
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(3)

    const reloaded = createUiStateStore(device)
    await reloaded.load()
    act(() => installUiState(reloaded))
    expect(reloaded.getSnapshot().sidebarMode).toBe('projects')
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(3)
    reloaded.dispose()
    ui.dispose()
  })

  it('reorders a paired workspace across local workspaces', () => {
    renderProjects()
    const source = rowOf('Shared').parentElement!
    const target = rowOf('cate').parentElement!
    const data = new Map<string, string>()
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: '', dropEffect: '' }
    const drag = (element: HTMLElement, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientY: { value: 0 } })
      act(() => element.dispatchEvent(event))
    }
    drag(source, 'dragstart')
    drag(target, 'dragover')
    drag(target, 'drop')
    expect(list.reorder).toHaveBeenCalledWith(['paired:abc', 'local:/p/cate', 'local:/p/site'])
  })

  it('opens and selects a workspace on click', async () => {
    renderProjects()
    await act(async () => { rowOf('site').click() })
    expect(list.open).toHaveBeenCalledWith('local:/p/site')
    expect(useUIStore.getState().selectedWorkspaceId).toBe('local:/p/site')
  })

  it('multi-selects with Cmd/Ctrl-click and closes the selection with Delete', async () => {
    renderProjects()
    await act(async () => { rowOf('cate').click() })
    await act(async () => { rowOf('site').click() })
    act(() => {
      rowOf('cate').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
      rowOf('site').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    })
    expect(rowOf('cate').closest('[data-workspace-id]')!.className).toContain('--surface-2')
    const container = host.querySelector('[data-sidebar-keynav]') as HTMLElement
    await act(async () => { container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })) })
    expect(list.close).toHaveBeenCalledWith('local:/p/cate')
    expect(list.close).toHaveBeenCalledWith('local:/p/site')
  })

  it('closing the shown workspace with its neighbour shows the next one left', async () => {
    renderProjects()
    await act(async () => { rowOf('cate').click() })
    act(() => {
      rowOf('cate').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
      rowOf('site').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    })
    const container = host.querySelector('[data-sidebar-keynav]') as HTMLElement
    await act(async () => { container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })) })
    expect(list.close).toHaveBeenCalledTimes(2)
    expect(useUIStore.getState().selectedWorkspaceId).toBe('paired:abc')
  })

  it('hides itself and toggles settings', () => {
    act(() => root.render(<Sidebar />))
    act(() => { (host.querySelector('[aria-label="Settings"]') as HTMLButtonElement).click() })
    expect(useUIStore.getState().overlay).toEqual({ view: 'settings' })
    act(() => { (host.querySelector('[aria-label="Hide sidebar"]') as HTMLButtonElement).click() })
    expect(useUIStore.getState().sidebarHidden).toBe(true)
    expect((host.querySelector('[data-app-sidebar]') as HTMLElement).style.width).toBe('0px')
  })

  it('shows buttons only for registered overlay views', () => {
    act(() => root.render(<Sidebar />))
    expect(host.querySelector('[aria-label="Skills"]')).toBeNull()
  })
})
