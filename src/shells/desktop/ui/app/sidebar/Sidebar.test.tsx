import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { WorkspaceEntry, WorkspaceList, WorkspaceListSnapshot } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../app'
import { INITIAL_UI_STATE, useUIStore } from '../state/uiStore'
import { Sidebar } from './Sidebar'

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
    open: vi.fn(async (id: string) => {
      snapshot = { ...snapshot, open: [...snapshot.open, id] }
      for (const l of listeners) l()
    }),
    close: vi.fn((id: string) => {
      snapshot = { ...snapshot, open: snapshot.open.filter((o) => o !== id) }
      for (const l of listeners) l()
    }),
    reorder: vi.fn(async () => {}),
  }
  return list
}

let list: ReturnType<typeof fakeList>

const rowOf = (name: string) =>
  [...host.querySelectorAll('[role="treeitem"]')].find((el) => el.textContent?.includes(name)) as HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  list = fakeList()
  installClientApp({
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
})

describe('Sidebar', () => {
  it('with no workspaces, offers buttons to open or join one', () => {
    const none: WorkspaceListSnapshot = { entries: [], open: [] }
    const empty = { ...list, getSnapshot: () => none }
    installClientApp({
      workspaces: empty as unknown as WorkspaceList,
      connections: { get: () => undefined } as unknown as ClientApp['connections'],
      version: '2.1.0',
    })
    act(() => root.render(<Sidebar />))
    const buttons = [...host.querySelectorAll('[data-sidebar-empty] button')]
    expect(buttons.map((b) => b.textContent)).toContain('Join a Workspace')
    act(() => (buttons.find((b) => b.textContent === 'Join a Workspace') as HTMLButtonElement).click())
    expect(useUIStore.getState().joinDialogOpen).toBe(true)
  })

  it('lists local and paired workspaces', () => {
    act(() => root.render(<Sidebar />))
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(3)
    expect(host.textContent).toContain('Shared')
  })

  it('opens and selects a workspace on click', async () => {
    act(() => root.render(<Sidebar />))
    await act(async () => { rowOf('site').click() })
    expect(list.open).toHaveBeenCalledWith('local:/p/site')
    expect(useUIStore.getState().selectedWorkspaceId).toBe('local:/p/site')
  })

  it('multi-selects with Cmd/Ctrl-click and closes the selection with Delete', async () => {
    act(() => root.render(<Sidebar />))
    await act(async () => { rowOf('cate').click() })
    await act(async () => { rowOf('site').click() })
    act(() => {
      rowOf('cate').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
      rowOf('site').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    })
    expect(rowOf('cate').className).toContain('ring-1')
    const container = host.querySelector('[data-sidebar-keynav]') as HTMLElement
    act(() => { container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })) })
    expect(list.close).toHaveBeenCalledWith('local:/p/cate')
    expect(list.close).toHaveBeenCalledWith('local:/p/site')
  })

  it('a workspace is draggable only while its own row is pressed (not its panel tree)', () => {
    act(() => root.render(<Sidebar />))
    const entry = rowOf('cate').closest('[draggable]') as HTMLElement
    expect(entry.draggable).toBe(false)
    act(() => { rowOf('cate').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(entry.draggable).toBe(true)
    const tree = document.createElement('div')
    tree.setAttribute('role', 'group')
    entry.append(tree)
    act(() => { tree.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(entry.draggable).toBe(false)
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
