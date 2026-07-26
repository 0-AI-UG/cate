// =============================================================================
// CommandPalette — detached-window integration (rendered).
//
// Covers two behaviors end to end through the real component:
//   • Part 1 gating — sidebar-only commands are hidden in a detached window.
//   • Part 3 discovery — panels living in other windows are listed (in the MAIN
//     window only) and activating one asks main to focus that window.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

// Tell React we drive renders inside act() so effects flush synchronously.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { entries: () => [], panelIdForPty: () => null, getEntry: vi.fn(), has: () => false },
}))

import { CommandPalette } from './CommandPalette'
import { WindowTypeContext } from '../stores/WindowTypeContext'
import { useUIStore } from '../stores/uiStore'
import { useAppStore } from '../stores/appStore'
import { useWindowPanelStore } from '../stores/windowPanelStore'
import type { CateWindowType, WindowPanelInfo } from '../../shared/types'

let host: HTMLDivElement
let root: Root

const detached: WindowPanelInfo = {
  panelId: 'remote-1',
  type: 'terminal',
  title: 'Remote Term',
  workspaceId: 'ws-A',
  ownerWindowId: 7,
  ownerWindowType: 'dock',
}

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView, which the palette calls to keep the
  // selected row visible.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()

  // The shared test setup installs a base electronAPI stub; add what the palette
  // touches for detached panels.
  ;(window.electronAPI as unknown as Record<string, unknown>).focusWindowPanel = vi.fn().mockResolvedValue(undefined)

  useAppStore.setState({
    workspaces: [{ id: 'ws-A', name: 'Proj', color: '', rootPath: '/tmp/p', panels: {} } as never],
    selectedWorkspaceId: 'ws-A',
  })
  useWindowPanelStore.setState({ panels: [detached] })
  useUIStore.getState().setShowCommandPalette(true)

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  useUIStore.getState().setShowCommandPalette(false)
})

function renderPalette(windowType: CateWindowType) {
  act(() => {
    root.render(
      <WindowTypeContext.Provider value={windowType}>
        <CommandPalette />
      </WindowTypeContext.Provider>,
    )
  })
}

/** Find the clickable Row whose label matches `text`. */
function rowWithText(text: string): HTMLElement | undefined {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="button"], button, div'))
    .filter((el) => el.textContent?.includes(text))
    // The innermost matching element is the row's content; walk up to a clickable.
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0))[0]
}

describe('CommandPalette in the main window', () => {
  it('lists workspaces and switches to the selected one', () => {
    useAppStore.setState({
      workspaces: [
        { id: 'ws-A', name: 'Proj', color: '#4a8ad0', rootPath: '/tmp/p', panels: {} } as never,
        { id: 'ws-B', name: 'Other Project', color: '#d05c5c', rootPath: '/tmp/other', panels: {} } as never,
      ],
      selectedWorkspaceId: 'ws-A',
    })
    const selectWorkspace = vi.spyOn(useAppStore.getState(), 'selectWorkspace').mockResolvedValue(undefined)

    renderPalette('main')

    expect(host.textContent).toContain('Workspaces')
    expect(host.textContent).toContain('Proj')
    expect(host.textContent).toContain('Other Project')
    expect(host.textContent).toContain('Current')

    const row = rowWithText('Other Project')
    expect(row).toBeTruthy()
    act(() => { row!.click() })

    expect(selectWorkspace).toHaveBeenCalledWith('ws-B')
    expect(useUIStore.getState().showCommandPalette).toBe(false)
    selectWorkspace.mockRestore()
  })

  it('lists panels living in other windows and reveals them via main', () => {
    renderPalette('main')

    expect(host.textContent).toContain('Remote Term')
    expect(host.textContent).toContain('Other window')

    // Activating the detached panel routes to the focus-detached-panel IPC, not
    // a local reveal.
    const row = rowWithText('Remote Term')
    expect(row).toBeTruthy()
    act(() => { row!.click() })
    expect(window.electronAPI.focusWindowPanel).toHaveBeenCalledWith('remote-1')
  })

  it('shows sidebar-only commands', () => {
    renderPalette('main')
    expect(host.textContent).toContain('Toggle Sidebar')
    expect(host.textContent).toContain('Toggle File Explorer')
  })
})

describe('CommandPalette in a detached window', () => {
  it('hides sidebar-only commands but still lists other windows\' panels', () => {
    renderPalette('dock')

    // Sidebar toggles have no meaning without a sidebar.
    expect(host.textContent).not.toContain('Toggle Sidebar')
    expect(host.textContent).not.toContain('Toggle File Explorer')
    // Discovery is bidirectional: a detached window also sees panels that live
    // in OTHER windows (this window doesn't host 'remote-1' locally).
    expect(host.textContent).toContain('Remote Term')
    // ...and ordinary commands still render.
    expect(host.textContent).toContain('New Terminal')
  })

  it('hides a panel that is local to this window (excluded by id)', () => {
    // Seed the dock window's own appStore with the same panel id that appears in
    // the union — it must be filtered out as "local", not shown as elsewhere.
    useAppStore.setState({
      workspaces: [{ id: 'ws-A', name: 'Proj', color: '', rootPath: '/tmp/p', panels: { 'remote-1': { id: 'remote-1', type: 'terminal', title: 'Remote Term', isDirty: false } } } as never],
      selectedWorkspaceId: 'ws-A',
    })
    renderPalette('dock')
    expect(host.textContent).not.toContain('Other window')
  })
})
