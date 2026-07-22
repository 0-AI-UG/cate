// =============================================================================
// useWindowRuntime — composition + own-effect integration (rendered).
//
// This is the unit every window mounts to gain shared functionality "for free".
// The test verifies it actually composes the shared pieces (shortcuts, theme,
// settings load, agent detector) AND wires its own effects: the Cmd+, settings
// toggle, the cross-window reveal listener, and the external-file-drop guard.
// The heavy sub-hooks are mocked so we assert the wiring, not their internals.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// vi.mock factories are hoisted above module top-level, so the spies they
// reference must come from vi.hoisted (also hoisted) rather than plain consts.
const h = vi.hoisted(() => ({
  useShortcuts: vi.fn(),
  useThemeAndScaleHydration: vi.fn(),
  startAgentScreenDetector: vi.fn(),
  stopAgentScreenDetector: vi.fn(),
  noteAgentHookEvent: vi.fn(),
  revealPanel: vi.fn(),
  loadSettings: vi.fn(),
  loadUIState: vi.fn(),
  openSettings: vi.fn(),
  closeSettings: vi.fn(),
  settingsOpen: false,
  useOwnedTerminalTelemetry: vi.fn(),
}))
vi.mock('../../hooks/useShortcuts', () => ({ useShortcuts: h.useShortcuts }))
vi.mock('./useThemeAndScaleHydration', () => ({ useThemeAndScaleHydration: h.useThemeAndScaleHydration }))
vi.mock('../agent/agentScreenDetector', () => ({
  startAgentScreenDetector: h.startAgentScreenDetector,
  stopAgentScreenDetector: h.stopAgentScreenDetector,
  applyRemoteAgentScreenState: vi.fn(),
  noteAgentHookEvent: h.noteAgentHookEvent,
}))
vi.mock('../workspace/panelReveal', () => ({ revealPanel: h.revealPanel }))
vi.mock('../../hooks/useProcessMonitor', () => ({ useOwnedTerminalTelemetry: h.useOwnedTerminalTelemetry }))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ loadSettings: h.loadSettings }), subscribe: () => () => {} },
}))
vi.mock('../../stores/uiStateStore', () => ({ useUIStateStore: { getState: () => ({ loadUIState: h.loadUIState }) } }))
vi.mock('../../stores/uiStore', () => ({
  useUIStore: { getState: () => ({ showSettings: h.settingsOpen, openSettings: h.openSettings, closeSettings: h.closeSettings }) },
}))
vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({ selectedWorkspaceId: 'ws-X', workspaces: [{ id: 'ws-X', panels: { p9: {} } }] }),
    // setupWindowPanelSync subscribes to report this window's panels.
    subscribe: () => () => {},
  },
}))
// windowPanelStore is real (harmless); the runtime only calls setPanels on it.

import { useWindowRuntime } from './useWindowRuntime'

// IPC callbacks captured from the electronAPI stub, so the test can fire them.
const captured: Record<string, (...a: unknown[]) => void> = {}

let host: HTMLDivElement
let root: Root

function Harness() {
  useWindowRuntime()
  return <div>runtime</div>
}

beforeEach(() => {
  h.settingsOpen = false
  for (const k of Object.keys(captured)) delete captured[k]
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    onMenuOpenSettings: vi.fn((cb: () => void) => { captured.menuSettings = cb; return () => {} }),
    onAgentScreenStateUpdate: vi.fn((cb: (...a: unknown[]) => void) => { captured.agent = cb; return () => {} }),
    onShellAgentHookEvent: vi.fn((cb: (...a: unknown[]) => void) => { captured.hook = cb; return () => {} }),
    onRevealPanelInWindow: vi.fn((cb: (id: string) => void) => { captured.reveal = cb as never; return () => {} }),
    onWindowPanelsChanged: vi.fn((cb: (...a: unknown[]) => void) => { captured.union = cb; return () => {} }),
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.clearAllMocks()
})

function mount() {
  act(() => { root.render(<Harness />) })
}

describe('useWindowRuntime', () => {
  it('composes the shared window behaviors', () => {
    mount()
    expect(h.useThemeAndScaleHydration).toHaveBeenCalled()
    expect(h.useShortcuts).toHaveBeenCalled()
    expect(h.loadSettings).toHaveBeenCalled()
    expect(h.loadUIState).toHaveBeenCalled()
    expect(h.startAgentScreenDetector).toHaveBeenCalled()
    // Owner-routed terminal telemetry must be wired in EVERY window so detached
    // terminals learn their agent presence (and can flip to `running`).
    expect(h.useOwnedTerminalTelemetry).toHaveBeenCalled()
    expect(window.electronAPI.onAgentScreenStateUpdate).toHaveBeenCalled()
    // Subscribes to the cross-window panel union so this window can discover
    // panels in other windows.
    expect(window.electronAPI.onWindowPanelsChanged).toHaveBeenCalled()
  })

  it('routes owner-window agent hook events into the coordinator', () => {
    mount()
    expect(window.electronAPI.onShellAgentHookEvent).toHaveBeenCalled()
    const event = { terminalId: 'pty-1', agentId: 'claude-code', kind: 'turn-start', sessionId: 's', raw: {} }
    act(() => { captured.hook('pty-1', event) })
    expect(h.noteAgentHookEvent).toHaveBeenCalledWith(event)
  })

  it('opens settings when the Cmd+, menu fires (and the detector stops on unmount)', () => {
    mount()
    expect(window.electronAPI.onMenuOpenSettings).toHaveBeenCalled()
    act(() => { captured.menuSettings() })
    expect(h.openSettings).toHaveBeenCalled()

    act(() => { root.unmount() })
    expect(h.stopAgentScreenDetector).toHaveBeenCalled()
  })

  it('reveals a panel in this window when main asks', () => {
    mount()
    act(() => { captured.reveal('p9') })
    expect(h.revealPanel).toHaveBeenCalledWith('ws-X', 'p9', { retry: true })
  })

  it('swallows external OS file drops so the window cannot navigate to file://', () => {
    mount()
    const e = new Event('dragover', { cancelable: true, bubbles: true })
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], dropEffect: '' } })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })

  it('ignores INTERNAL drags (panel/file reorder) so their drop still fires', () => {
    mount()
    const e = new Event('dragover', { cancelable: true, bubbles: true })
    Object.defineProperty(e, 'dataTransfer', { value: { types: ['application/x-cate-panel'], dropEffect: '' } })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})
