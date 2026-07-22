// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@xterm/xterm', () => ({ Terminal: class {} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./terminalSettings', () => ({
  getTerminalFontFamily: () => '',
  getTerminalBaseFontSize: () => 13,
  getScrollback: () => 1000,
  getScrollSensitivity: () => 1,
  getContrastRatio: () => 4.5,
  getOptionIsMeta: () => true,
  effectiveCursorBlink: () => false,
}))
vi.mock('./terminalInput', () => ({
  createTerminalLinkHandler: () => () => {},
  makeTerminalKeyEventHandler: () => () => true,
}))
vi.mock('./terminalOsc52Clipboard', () => ({ registerOsc52ClipboardHandler: () => () => {} }))
vi.mock('./terminalFileLinkProvider', () => ({
  createFileLinkProvider: () => ({ provideLinks: () => {} }),
  resolveLinkRoot: () => '',
}))
vi.mock('./terminalDom', () => ({ clearWebglDisabled: vi.fn(), releaseWebglGrant: vi.fn() }))
vi.mock('../themeManager', () => ({ getActiveTheme: () => ({ terminal: {} }) }))
vi.mock('../../stores/appStore', () => ({
  awaitWorkspaceSync: async () => {},
  useAppStore: { getState: () => ({ workspaces: [], updatePanelTitleFromAgent: vi.fn() }) },
}))
vi.mock('../workspace/session', () => ({ replayTerminalLog: async () => {} }))
vi.mock('../agent/agentScreenDetector', () => ({
  forgetAgentTracker: vi.fn(),
}))
vi.mock('../../hooks/useProcessMonitor', () => ({ forgetTerminalForProcessMonitor: vi.fn() }))

import { dispose } from './terminalLifecycle'
import { ptyToPanel, registry, setPtyForPanel } from './registryState'
import { useStatusStore } from '../../stores/statusStore'
import type { RegistryEntry } from './registryState'

const terminalKill = vi.fn(async () => undefined)

function fakeEntry(workspaceId: string): RegistryEntry {
  return {
    terminal: { dispose: vi.fn() } as any,
    fitAddon: { dispose: vi.fn() } as any,
    webglAddon: null,
    searchAddon: {} as any,
    serializeAddon: { dispose: vi.fn() } as any,
    ptyId: '',
    cleanupListeners: [],
    lastScrollTop: 0,
    hasScrollListener: false,
    hasVisibilityListener: false,
    workspaceId,
    alive: true,
  }
}

beforeEach(() => {
  registry.clear()
  ptyToPanel.clear()
  terminalKill.mockClear()
  useStatusStore.setState({ workspaces: {} })
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { terminalKill },
  })
})

describe('terminal disposal status lifecycle', () => {
  it('removes status after terminal identity has been deleted from the resolver', () => {
    const panelId = 'panel-status'
    const ptyId = 'pty-status'
    const workspaceId = 'ws-status'
    registry.set(panelId, fakeEntry(workspaceId))
    setPtyForPanel(panelId, ptyId)
    useStatusStore.getState().setTerminalActivity(
      workspaceId,
      ptyId,
      { type: 'running', processName: 'node' },
    )

    dispose(panelId)

    expect(ptyToPanel.has(ptyId)).toBe(false)
    expect(registry.has(panelId)).toBe(false)
    expect(useStatusStore.getState().workspaces[workspaceId]?.terminals[ptyId]).toBeUndefined()
    expect(terminalKill).toHaveBeenCalledWith(ptyId)
  })
})
