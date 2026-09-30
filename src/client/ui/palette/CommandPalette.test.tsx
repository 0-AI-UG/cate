import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { WorkspaceList, WorkspaceListSnapshot } from '@client/workspaces'
import { installClientApp, type ClientApp } from '../app'
import { bindAction, registerCommand } from '../actions/registry'
import { INITIAL_UI_STATE, useUIStore } from '../state/uiStore'
import { CommandPalette } from './CommandPalette'

let host: HTMLDivElement
let root: Root
const stops: (() => void)[] = []

function fakeWorkspaces(snapshot: WorkspaceListSnapshot): WorkspaceList {
  return { getSnapshot: () => snapshot, subscribe: () => () => {}, get: (id: string) => snapshot.entries.find((e) => e.id === id) } as unknown as WorkspaceList
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(input: HTMLInputElement, k: string): void {
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  installClientApp({
    workspaces: fakeWorkspaces({
      entries: [{ kind: 'local', id: 'local:/p/cate', root: '/p/cate', name: 'cate', lastOpenedAt: 1 }],
      open: [],
    }),
    connections: {} as ClientApp['connections'],
    version: '2.1.0',
  })
  useUIStore.setState({ ...INITIAL_UI_STATE, commandPaletteOpen: true })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const stop of stops.splice(0)) stop()
  installClientApp(null)
})

describe('CommandPalette', () => {
  it('renders nothing while closed', () => {
    useUIStore.setState({ commandPaletteOpen: false })
    act(() => root.render(<CommandPalette />))
    expect(document.body.querySelector('[aria-label="Command palette"]')).toBeNull()
  })

  it('lists bound actions and workspaces, but not unbound or unavailable actions', () => {
    stops.push(bindAction('openSettings', { run: vi.fn() }))
    stops.push(bindAction('toggleMinimap', { run: vi.fn(), requires: ['canvas'] }))
    act(() => root.render(<CommandPalette />))
    const text = document.body.textContent ?? ''
    expect(text).toContain('Settings / Preferences…')
    expect(text).toContain('cate')
    expect(text).not.toContain('Toggle Minimap')
    expect(text).not.toContain('New Terminal')
  })

  it('filters by the query and runs the selected command on Enter, closing first', () => {
    const run = vi.fn(() => { expect(useUIStore.getState().commandPaletteOpen).toBe(false) })
    stops.push(bindAction('openSettings', { run: vi.fn() }))
    stops.push(registerCommand({ id: 'connect', title: 'Panels: Connect focused panel…', run }))
    act(() => root.render(<CommandPalette />))
    const input = document.body.querySelector('input') as HTMLInputElement
    type(input, 'connect')
    expect(document.body.textContent).not.toContain('Settings / Preferences…')
    key(input, 'Enter')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    act(() => root.render(<CommandPalette />))
    key(document.body.querySelector('input') as HTMLInputElement, 'Escape')
    expect(useUIStore.getState().commandPaletteOpen).toBe(false)
  })
})
