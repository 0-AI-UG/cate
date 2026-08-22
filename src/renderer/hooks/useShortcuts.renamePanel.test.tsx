// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: { release: vi.fn(), setPendingTransfer: vi.fn(), dispose: vi.fn() },
}))
vi.mock('../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))

import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useShortcuts } from './useShortcuts'
import { setActivePanel } from '../lib/activePanel'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { storedShortcut } from '../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = 'ws-rename-shortcut'
let host: HTMLDivElement
let root: Root
let renamed: string[]

function Harness() {
  useShortcuts()
  return null
}

function dispatchKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { document.dispatchEvent(event) })
  return event
}

beforeEach(() => {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    onMenuTriggerAction: () => () => {},
    onMenuLoadLayout: () => () => {},
  }
  useSettingsStore.setState({ customShortcuts: {} })
  useAppStore.setState({
    selectedWorkspaceId: WS,
    workspaces: [{
      id: WS,
      rootPath: '/repo',
      panels: {
        editor: { id: 'editor', type: 'editor', title: 'Editor' },
        browser: { id: 'browser', type: 'browser', title: 'Browser' },
      },
    }],
  } as never)
  renamed = []
  window.addEventListener('rename-panel', captureRename)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(<Harness />) })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  window.removeEventListener('rename-panel', captureRename)
  setActivePanel(null)
  useSettingsStore.setState({ customShortcuts: {} })
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: null } as never)
})

function captureRename(event: Event) {
  renamed.push((event as CustomEvent<{ panelId: string }>).detail.panelId)
}

describe('rename focused panel shortcut', () => {
  it('dispatches the default Cmd+R to the focused non-browser panel', () => {
    setActivePanel('editor')
    const event = dispatchKey({ key: 'r', code: 'KeyR', metaKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(renamed).toEqual(['editor'])
  })

  it('leaves Cmd+R to a focused browser panel for reload', () => {
    setActivePanel('browser')
    const event = dispatchKey({ key: 'r', code: 'KeyR', metaKey: true })

    expect(event.defaultPrevented).toBe(false)
    expect(renamed).toEqual([])
  })

  it('honours a customized rename binding', () => {
    useSettingsStore.setState({
      customShortcuts: {
        renamePanel: storedShortcut('y', { command: true, shift: true }),
      },
    })
    setActivePanel('editor')

    dispatchKey({ key: 'r', code: 'KeyR', metaKey: true })
    expect(renamed).toEqual([])

    dispatchKey({ key: 'y', code: 'KeyY', metaKey: true, shiftKey: true })
    expect(renamed).toEqual(['editor'])
  })
})
