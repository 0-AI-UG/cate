// =============================================================================
// Tests for DockWindowTitlebar — the macOS header bar for detached dock windows.
//
// jsdom's navigator is not "Mac", so the real IS_MAC is false and the component
// would render null. We mock the platform module to force the macOS path, then
// verify: it shows the active panel's title when windowed, falls back sensibly,
// and collapses (renders nothing) in native fullscreen.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('../lib/platform', () => ({ IS_MAC: true }))

import DockWindowTitlebar from './DockWindowTitlebar'
import { useAppStore } from '../stores/appStore'
import { useActivePanelStore } from '../lib/activePanel'
import type { PanelState } from '../../shared/types'

const WS = 'ws-test'

let host: HTMLDivElement
let root: Root

function panel(id: string, title: string): PanelState {
  return { id, type: 'terminal', title } as PanelState
}

function seedWorkspace(panels: Record<string, PanelState>) {
  act(() => {
    useAppStore.setState({
      workspaces: [{ id: WS, name: 'Test', rootPath: '/tmp', panels } as never],
    })
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.mocked(window.electronAPI.isMainWindowFullscreen).mockReturnValue(false)
  act(() => { useActivePanelStore.setState({ activePanelId: null }) })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.restoreAllMocks()
})

function render() {
  act(() => { root.render(<DockWindowTitlebar workspaceId={WS} />) })
  return host
}

describe('DockWindowTitlebar', () => {
  it('shows the active panel title when windowed', () => {
    seedWorkspace({ a: panel('a', 'Terminal — cate'), b: panel('b', 'Editor') })
    act(() => { useActivePanelStore.setState({ activePanelId: 'b' }) })
    const el = render()
    expect(el.textContent).toContain('Editor')
  })

  it('falls back to the first panel title when nothing is active', () => {
    seedWorkspace({ a: panel('a', 'Terminal — cate') })
    const el = render()
    expect(el.textContent).toContain('Terminal — cate')
  })

  it('renders nothing in native fullscreen', () => {
    seedWorkspace({ a: panel('a', 'Terminal — cate') })
    vi.mocked(window.electronAPI.isMainWindowFullscreen).mockReturnValue(true)
    const el = render()
    expect(el.querySelector('.dock-window-titlebar')).toBeNull()
  })
})
