import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- electron: only app is touched at module load (will-quit handler) --------
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { on: vi.fn() },
}))

// cate.ui.notify reuses the shared OS-notification path; spy on it + the setting.
const { showOsNotification, settings } = vi.hoisted(() => ({
  showOsNotification: vi.fn(),
  settings: {
    notificationsEnabled: true,
    cliEnabled: true,
    cliBrowserReadEnabled: true,
    cliBrowserControlEnabled: true,
    cliTerminalReadEnabled: true,
    cliTerminalInputEnabled: false,
    cliPanelReadEnabled: true,
    cliPanelControlEnabled: true,
    cliEditorReadEnabled: true,
    cliEditorControlEnabled: true,
    cliNotifyEnabled: true,
    cliAgentReadEnabled: true,
    cliAgentControlEnabled: true,
  },
}))
vi.mock('../ipc/notifications', () => ({ showOsNotification }))

const { activeWindow, windowsById, windowPanelList, windowPanelListener, revealWindowPanel, upsertWindowPanel, removeWindowPanel } = vi.hoisted(() => ({
  activeWindow: { value: undefined as unknown },
  windowsById: new Map<number, unknown>(),
  windowPanelList: { value: [] as Array<{
    panelId: string
    type: string
    title?: string
    workspaceId?: string
    ownerWindowId: number
    filePath?: string
    url?: string
    focused?: boolean
    codingAgentRunId?: string
    codingAgentOwnerPanelId?: string
    codingAgentStatus?: 'starting' | 'working' | 'waiting' | 'ready' | 'stopped' | 'failed'
  }> },
  windowPanelListener: { value: null as (() => void) | null },
  revealWindowPanel: vi.fn(() => true),
  upsertWindowPanel: vi.fn(),
  removeWindowPanel: vi.fn(),
}))
vi.mock('../windowRegistry', () => ({
  getActiveMainWindow: () => activeWindow.value,
  getWindow: (id: number) => windowsById.get(id),
}))
vi.mock('../windowPanels', () => ({
  getWindowPanels: () => windowPanelList.value,
  subscribeWindowPanels: vi.fn((listener: () => void) => {
    windowPanelListener.value = listener
    return () => { windowPanelListener.value = null }
  }),
  revealWindowPanel,
  upsertWindowPanel,
  removeWindowPanel,
}))
vi.mock('../../shared/runtimeLocator', () => ({
  LOCAL_RUNTIME_ID: 'local',
  parseLocator: (raw: string) => ({ runtimeId: 'local', path: raw }),
}))
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: vi.fn(() => ({ rootPath: '/ws/root' })) }))
vi.mock('../settingsFile', () => ({
  getAllSettings: () => ({}),
  getSetting: (key: string) => (settings as Record<string, unknown>)[key],
}))
vi.mock('../themeBootCache', () => ({
  resolveActiveTheme: () => ({ id: 'dark-cold', type: 'dark', app: { 'editor-bg': '#111' }, terminal: { black: '#000' } }),
}))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import {
  dispatchCateInvoke,
  forwardTimeoutMs,
  TERMINAL_INPUT_DISABLED,
  TERMINAL_READ_DISABLED,
  BROWSER_CONTROL_DISABLED,
  BROWSER_READ_DISABLED,
  type InvokeScope,
} from './cateApiHandlers'
import {
  cliPermissionCellByKey,
  cliPermissionDenied,
  cliPermissionForMethod,
} from '../../shared/cliPermissions'

const WS = 'ws-1'
const PANEL = 'panel-1'

function scope(forward: InvokeScope['forward'] = vi.fn()): InvokeScope {
  return { workspaceId: WS, panelId: PANEL, forward }
}

beforeEach(() => {
  settings.notificationsEnabled = true
  settings.cliEnabled = true
  settings.cliBrowserReadEnabled = true
  settings.cliBrowserControlEnabled = true
  settings.cliTerminalReadEnabled = true
  settings.cliTerminalInputEnabled = false
  settings.cliPanelReadEnabled = true
  settings.cliPanelControlEnabled = true
  settings.cliEditorReadEnabled = true
  settings.cliEditorControlEnabled = true
  settings.cliNotifyEnabled = true
  settings.cliAgentReadEnabled = true
  settings.cliAgentControlEnabled = true
  activeWindow.value = undefined
  windowsById.clear()
  windowPanelList.value = []
  windowPanelListener.value = null
  revealWindowPanel.mockClear()
  revealWindowPanel.mockReturnValue(true)
  removeWindowPanel.mockClear()
  upsertWindowPanel.mockClear()
  showOsNotification.mockClear()
})

describe('dispatchCateInvoke — CLI host API', () => {
  it('reports the API version for feature detection', async () => {
    expect(await dispatchCateInvoke(scope(), 'cate.version', undefined)).toBe(7)
  })

  it('suppresses ui.notify when the user disabled notifications', async () => {
    settings.notificationsEnabled = false
    const res = await dispatchCateInvoke(scope(), 'cate.ui.notify', { message: 'hi' })
    expect(res).toEqual({ ok: true })
    expect(showOsNotification).not.toHaveBeenCalled()
  })

  it.each([
    ['cate.editor.openFile', { path: 'package.json' }],
    ['cate.canvas.createPanel', { type: 'browser' }],
    ['cate.panel.setTitle', { title: 'Renamed' }],
    ['cate.panel.list', {}],
    ['cate.panel.close', { panelId: 'p1' }],
  ])('forwards %s to the owning renderer', async (method, args) => {
    const forward = vi.fn(async () => ({ panelId: 'new' }))
    const res = await dispatchCateInvoke(scope(forward), method, args)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({
      method,
      args: expect.objectContaining(args),
      workspaceId: WS,
      panelId: PANEL,
    }))
    expect(res).toEqual({ panelId: 'new' })
  })

  it('registers a created panel immediately for a follow-up targeted command', async () => {
    activeWindow.value = { id: 9, isDestroyed: () => false, webContents: { send: vi.fn() } }
    const forward = vi.fn(async () => ({ panelId: 'fresh-browser' }))

    expect(await dispatchCateInvoke(
      scope(forward),
      'cate.canvas.createPanel',
      { type: 'browser', url: 'https://example.test' },
    )).toEqual({ panelId: 'fresh-browser' })

    expect(upsertWindowPanel).toHaveBeenCalledWith(9, {
      panelId: 'fresh-browser',
      type: 'browser',
      title: 'https://example.test',
      workspaceId: WS,
      url: 'https://example.test',
      focused: false,
    })
  })

  it('rejects unknown methods as unsupported', async () => {
    expect(await dispatchCateInvoke(scope(), 'cate.bogus.method', undefined)).toEqual({ error: 'unsupported', method: 'cate.bogus.method' })
  })

  it('evicts a successfully closed panel from the cross-window union immediately', async () => {
    // Without eviction the debounced report keeps serving the stale row to
    // panel.list, so a close-then-verify caller reads the panel as still open.
    const forward = vi.fn(async () => ({ ok: true }))
    await dispatchCateInvoke(scope(forward), 'cate.panel.close', { panelId: 'p1' })
    expect(removeWindowPanel).toHaveBeenCalledWith('p1')
  })

  it('does not evict when the close is rejected (dirty-gate cancel)', async () => {
    const forward = vi.fn(async () => ({ error: 'close-cancelled' }))
    await dispatchCateInvoke(scope(forward), 'cate.panel.close', { panelId: 'p1' })
    expect(removeWindowPanel).not.toHaveBeenCalled()
  })

  it('panel.list merges immediate local rows with detached-window rows', async () => {
    windowPanelList.value = [{
      panelId: 'detached-browser',
      type: 'browser',
      title: 'Docs',
      workspaceId: WS,
      ownerWindowId: 2,
      url: 'https://docs.example/',
      focused: true,
    }]
    const forward = vi.fn(async () => [
      { panelId: 'local-editor', type: 'editor', title: 'a.ts', focused: false, filePath: '/ws/root/a.ts' },
    ])

    expect(await dispatchCateInvoke(scope(forward), 'cate.panel.list', {})).toEqual([
      { panelId: 'local-editor', type: 'editor', title: 'a.ts', focused: false, filePath: '/ws/root/a.ts' },
      { panelId: 'detached-browser', type: 'browser', title: 'Docs', focused: true, url: 'https://docs.example/' },
    ])
  })
})

describe('dispatchCateInvoke: coding agent orchestration boundary', () => {
  it('allows a long monitor call without extending unrelated host actions', () => {
    expect(forwardTimeoutMs('cate.codingAgent.wait')).toBe(65_000)
    expect(forwardTimeoutMs('cate.codingAgent.apply')).toBe(10_000)
    expect(forwardTimeoutMs('cate.codingAgent.discard')).toBe(10_000)
    expect(forwardTimeoutMs('cate.editor.openFile')).toBe(10_000)
  })

  it('routes review commands to the window that owns the review panel', async () => {
    const send = vi.fn(() => { throw new Error('closed for test') })
    windowsById.set(8, { isDestroyed: () => false, webContents: { send } })
    windowPanelList.value = [{
      panelId: 'review-panel',
      type: 'review',
      workspaceId: WS,
      ownerWindowId: 8,
    }]

    const result = await dispatchCateInvoke({
      workspaceId: WS,
      panelId: 'reviewer-terminal',
      forward: vi.fn(),
    }, 'cate.review.inspect', { panelId: 'review-panel' })

    expect(result).toEqual({ error: 'no-owner', method: 'cate.review.inspect' })
    expect(send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      workspaceId: WS,
      panelId: 'reviewer-terminal',
      method: 'cate.review.inspect',
      args: { panelId: 'review-panel' },
    }))
  })

  it('applies the CLI master switch to terminal orchestration', async () => {
    settings.cliEnabled = false
    const forward = vi.fn()

    expect(await dispatchCateInvoke({
      workspaceId: WS,
      panelId: 'supervisor-cli-off',
      forward,
    }, 'cate.codingAgent.create', { agentId: 'codex', prompt: 'Implement it' })).toEqual({
      error: 'cli-disabled: enable Command-line control (cate CLI) in Cate Settings → CLI',
      method: 'cate.codingAgent.create',
    })
    expect(forward).not.toHaveBeenCalled()
  })

  it('applies the CLI master switch to terminal host capabilities', async () => {
    settings.cliEnabled = false
    const forward = vi.fn()

    expect(await dispatchCateInvoke({
      workspaceId: WS,
      panelId: 'supervisor-cli-gate',
      forward,
    }, 'cate.terminal.press', { key: 'enter' })).toEqual({
      error: 'cli-disabled: enable Command-line control (cate CLI) in Cate Settings → CLI',
      method: 'cate.terminal.press',
    })
    expect(forward).not.toHaveBeenCalled()
  })

  it('applies per-capability CLI permissions to terminal host capabilities', async () => {
    settings.cliTerminalInputEnabled = false
    const forward = vi.fn()

    expect(await dispatchCateInvoke({
      workspaceId: WS,
      panelId: 'supervisor-cell-gate',
      forward,
    }, 'cate.terminal.press', { key: 'enter' })).toEqual({
      error: TERMINAL_INPUT_DISABLED,
      method: 'cate.terminal.press',
    })
    expect(forward).not.toHaveBeenCalled()
  })

  it('launches into an existing terminal in the window that owns it', async () => {
    const send = vi.fn(() => { throw new Error('closed for test') })
    windowsById.set(9, { isDestroyed: () => false, webContents: { send } })
    windowPanelList.value = [{
      panelId: 'target-terminal',
      type: 'terminal',
      workspaceId: WS,
      ownerWindowId: 9,
    }]

    const result = await dispatchCateInvoke({
      workspaceId: WS,
      panelId: 'caller-terminal',
      forward: vi.fn(),
    }, 'cate.codingAgent.create', {
      prompt: 'Review it',
      terminalPanelId: 'target-terminal',
    })

    expect(result).toEqual({ error: 'no-owner', method: 'cate.codingAgent.create' })
    expect(send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      panelId: 'caller-terminal',
      method: 'cate.codingAgent.create',
      args: expect.objectContaining({ terminalPanelId: 'target-terminal' }),
    }))
  })

  it('routes a transferred worker to its exact owner window', async () => {
    const send = vi.fn(() => { throw new Error('closed for test') })
    windowsById.set(7, { isDestroyed: () => false, webContents: { send } })
    windowPanelList.value = [{
      panelId: 'worker-panel',
      type: 'terminal',
      ownerWindowId: 7,
      codingAgentRunId: 'run-1',
      codingAgentOwnerPanelId: 'supervisor-1',
    }]
    const fallback = vi.fn()

    const result = await dispatchCateInvoke({
      workspaceId: WS,
      panelId: 'supervisor-1',
      forward: fallback,
    }, 'cate.codingAgent.inspect', { runId: 'run-1' })

    expect(result).toEqual({ error: 'no-owner', method: 'cate.codingAgent.inspect' })
    expect(send).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('lists direct workers reported by detached owner windows', async () => {
    const send = vi.fn(() => { throw new Error('closed for test') })
    windowsById.set(7, { isDestroyed: () => false, webContents: { send } })
    windowPanelList.value = [{
      panelId: 'worker-panel',
      type: 'terminal',
      workspaceId: WS,
      ownerWindowId: 7,
      codingAgentRunId: 'run-detached',
      codingAgentOwnerPanelId: 'supervisor-1',
      codingAgentStatus: 'ready',
    }]

    const result = await dispatchCateInvoke({
      workspaceId: WS,
      panelId: 'supervisor-1',
      forward: vi.fn(async () => []),
    }, 'cate.codingAgent.list', {})

    expect(result).toEqual([{
      id: 'run-detached',
      panelId: 'worker-panel',
      status: 'ready',
    }])
    expect(send).toHaveBeenCalledOnce()
  })

  it('coordinates one event-driven wait across workers in different windows', async () => {
    const sendA = vi.fn(() => { throw new Error('closed for test') })
    const sendB = vi.fn(() => { throw new Error('closed for test') })
    windowsById.set(7, { isDestroyed: () => false, webContents: { send: sendA } })
    windowsById.set(8, { isDestroyed: () => false, webContents: { send: sendB } })
    windowPanelList.value = [
      {
        panelId: 'worker-a',
        type: 'terminal',
        ownerWindowId: 7,
        codingAgentRunId: 'run-a',
        codingAgentOwnerPanelId: 'supervisor-1',
        codingAgentStatus: 'ready',
      },
      {
        panelId: 'worker-b',
        type: 'terminal',
        ownerWindowId: 8,
        codingAgentRunId: 'run-b',
        codingAgentOwnerPanelId: 'supervisor-1',
        codingAgentStatus: 'waiting',
      },
    ]

    const result = await dispatchCateInvoke({
      workspaceId: WS,
      panelId: 'supervisor-1',
      forward: vi.fn(),
    }, 'cate.codingAgent.wait', { runIds: ['run-a', 'run-b'] })

    expect(result).toEqual({
      timedOut: false,
      changedRunIds: ['run-a', 'run-b'],
      runs: [
        { id: 'run-a', panelId: 'worker-a', status: 'ready' },
        { id: 'run-b', panelId: 'worker-b', status: 'waiting' },
      ],
    })
    expect(sendA).toHaveBeenCalledOnce()
    expect(sendB).toHaveBeenCalledOnce()
  })

  it('wakes a cross-window wait from the shared window-panel event stream', async () => {
    const send = vi.fn(() => { throw new Error('closed for test') })
    windowsById.set(7, { isDestroyed: () => false, webContents: { send } })
    windowsById.set(8, { isDestroyed: () => false, webContents: { send } })
    windowPanelList.value = [
      {
        panelId: 'worker-a',
        type: 'terminal',
        ownerWindowId: 7,
        codingAgentRunId: 'run-a',
        codingAgentOwnerPanelId: 'supervisor-1',
        codingAgentStatus: 'working',
      },
      {
        panelId: 'worker-b',
        type: 'terminal',
        ownerWindowId: 8,
        codingAgentRunId: 'run-b',
        codingAgentOwnerPanelId: 'supervisor-1',
        codingAgentStatus: 'working',
      },
    ]
    const waiting = dispatchCateInvoke({
      workspaceId: WS,
      panelId: 'supervisor-1',
      forward: vi.fn(),
    }, 'cate.codingAgent.wait', { runIds: ['run-a', 'run-b'] })

    expect(windowPanelListener.value).toBeTypeOf('function')
    windowPanelList.value[1].codingAgentStatus = 'ready'
    windowPanelListener.value!()

    await expect(waiting).resolves.toMatchObject({
      timedOut: false,
      changedRunIds: ['run-b'],
    })
    expect(windowPanelListener.value).toBeNull()
  })
})

describe('dispatchCateInvoke — cate.browser.* namespace', () => {
  // webContents.send throws so the real forwardToOwner resolves fast ('no-owner')
  // rather than waiting 10s for a reply, while still recording the target.
  function makeWin() {
    const send = vi.fn(() => { throw new Error('no-reply') })
    return { win: { isDestroyed: () => false, webContents: { send } }, send }
  }

  it('routes an explicit browser panelId to that panel’s owner window', async () => {
    // A send spy that throws lets the real forwardToOwner resolve immediately
    // (it maps a failed send to 'no-owner') instead of waiting on a reply, while
    // still capturing exactly which window's webContents the method reached.
    const send = vi.fn((..._args: unknown[]) => { throw new Error('no-reply') })
    const ownerWin = { isDestroyed: () => false, webContents: { id: 7, send } }
    windowPanelList.value = [{ panelId: 'browser-7', type: 'browser', ownerWindowId: 42 }]
    windowsById.set(42, ownerWin)
    // Active window is a DIFFERENT window — the panelId must win over it.
    activeWindow.value = makeWin().win
    const s: InvokeScope = { workspaceId: WS, panelId: '', forward: vi.fn(),
    }
    await dispatchCateInvoke(s, 'cate.browser.back', { panelId: 'browser-7' })
    // Forwarded to the OWNER window (id 42's webContents), not the active window.
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ method: 'cate.browser.back', args: { panelId: 'browser-7' }, panelId: '' }),
    )
  })

  it('returns no-such-browser for an unknown panelId without forwarding', async () => {
    const forward = vi.fn()
    const s: InvokeScope = { workspaceId: WS, panelId: '', forward,
    }
    const res = await dispatchCateInvoke(s, 'cate.browser.back', { panelId: 'does-not-exist' })
    expect(res).toEqual({ error: 'no-such-browser', method: 'cate.browser.back' })
    expect(forward).not.toHaveBeenCalled()
  })

  it('returns no-host-window when there is no active window and no panelId', async () => {
    activeWindow.value = undefined
    const s: InvokeScope = { workspaceId: WS, panelId: '', forward: vi.fn(),
    }
    const res = await dispatchCateInvoke(s, 'cate.browser.back', {})
    expect(res).toEqual({ error: 'no-host-window', method: 'cate.browser.back' })
  })

  // --- Addressed panel whose owner window is missing / destroyed ---------------

  it('returns no-host-window when the addressed browser panel’s owner window is missing', async () => {
    // Panel resolves to ownerWindowId 42, but the registry has no such window.
    windowPanelList.value = [{ panelId: 'browser-7', type: 'browser', ownerWindowId: 42 }]
    const forward = vi.fn()
    const s: InvokeScope = { workspaceId: WS, panelId: '', forward,
    }
    const res = await dispatchCateInvoke(s, 'cate.browser.back', { panelId: 'browser-7' })
    expect(res).toEqual({ error: 'no-host-window', method: 'cate.browser.back' })
    expect(forward).not.toHaveBeenCalled()
  })

  it('returns no-host-window when the addressed browser panel’s owner window is destroyed', async () => {
    const send = vi.fn()
    windowPanelList.value = [{ panelId: 'browser-7', type: 'browser', ownerWindowId: 42 }]
    windowsById.set(42, { isDestroyed: () => true, webContents: { id: 7, send } })
    const s: InvokeScope = { workspaceId: WS, panelId: '', forward: vi.fn(),
    }
    const res = await dispatchCateInvoke(s, 'cate.browser.back', { panelId: 'browser-7' })
    expect(res).toEqual({ error: 'no-host-window', method: 'cate.browser.back' })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('dispatchCateInvoke — cate.terminal.* namespace', () => {
  function makeWin() {
    const send = vi.fn((..._args: unknown[]) => { throw new Error('no-reply') })
    return { win: { isDestroyed: () => false, webContents: { send } }, send }
  }

  const firstParty = (forward: InvokeScope['forward'] = vi.fn()): InvokeScope => ({ workspaceId: WS, panelId: '', forward,
  })

  it('forwards read to the active window when unaddressed (focused-terminal resolution is renderer-side)', async () => {
    const { win, send } = makeWin()
    activeWindow.value = win
    const res = await dispatchCateInvoke(firstParty(), 'cate.terminal.read', {})
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1]).toEqual(expect.objectContaining({ method: 'cate.terminal.read' }))
  })

  it('routes an explicit terminal panelId to that panel’s owner window', async () => {
    settings.cliTerminalInputEnabled = true
    const send = vi.fn((..._args: unknown[]) => { throw new Error('no-reply') })
    const ownerWin = { isDestroyed: () => false, webContents: { id: 7, send } }
    windowPanelList.value = [{ panelId: 'term-7', type: 'terminal', ownerWindowId: 42 }]
    windowsById.set(42, ownerWin)
    // Active window is a DIFFERENT window — the panelId must win over it.
    activeWindow.value = makeWin().win
    await dispatchCateInvoke(firstParty(), 'cate.terminal.press', { panelId: 'term-7', key: 'enter' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ method: 'cate.terminal.press', args: { panelId: 'term-7', key: 'enter' } }),
    )
  })

  it('returns no-such-terminal for an unknown or non-terminal panelId without forwarding', async () => {
    windowPanelList.value = [{ panelId: 'browser-7', type: 'browser', ownerWindowId: 42 }]
    const forward = vi.fn()
    expect(await dispatchCateInvoke(firstParty(forward), 'cate.terminal.read', { panelId: 'ghost' }))
      .toEqual({ error: 'no-such-terminal', method: 'cate.terminal.read' })
    expect(await dispatchCateInvoke(firstParty(forward), 'cate.terminal.read', { panelId: 'browser-7' }))
      .toEqual({ error: 'no-such-terminal', method: 'cate.terminal.read' })
    expect(forward).not.toHaveBeenCalled()
  })

  // --- The cliTerminalInputEnabled gate (main-side, default off) ---------------

  it('refuses type/press while cliTerminalInputEnabled is off, saying how to enable it', async () => {
    const { win, send } = makeWin()
    activeWindow.value = win
    windowPanelList.value = [{ panelId: 'term-7', type: 'terminal', ownerWindowId: 42 }]
    windowsById.set(42, win)
    for (const [method, args] of [
      ['cate.terminal.type', { panelId: 'term-7', text: 'ls' }],
      ['cate.terminal.press', { panelId: 'term-7', key: 'enter' }],
    ] as const) {
      expect(await dispatchCateInvoke(firstParty(), method, args)).toEqual({
        error: TERMINAL_INPUT_DISABLED,
        method,
      })
    }
    // Refused at dispatch — the owner window is never touched.
    expect(send).not.toHaveBeenCalled()
    expect(TERMINAL_INPUT_DISABLED).toMatch(/Settings → CLI/)
  })

  it('read is NOT gated by the input setting', async () => {
    const { win, send } = makeWin()
    activeWindow.value = win
    expect(settings.cliTerminalInputEnabled).toBe(false)
    await dispatchCateInvoke(firstParty(), 'cate.terminal.read', {})
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('refuses read while cliTerminalReadEnabled is off, saying how to enable it', async () => {
    settings.cliTerminalReadEnabled = false
    const { win, send } = makeWin()
    activeWindow.value = win
    expect(await dispatchCateInvoke(firstParty(), 'cate.terminal.read', {})).toEqual({
      error: TERMINAL_READ_DISABLED,
      method: 'cate.terminal.read',
    })
    expect(send).not.toHaveBeenCalled()
    expect(TERMINAL_READ_DISABLED).toMatch(/Settings → CLI/)
  })

  it('forwards type once the setting is on', async () => {
    settings.cliTerminalInputEnabled = true
    const { win, send } = makeWin()
    activeWindow.value = win
    windowPanelList.value = [{ panelId: 'term-7', type: 'terminal', ownerWindowId: 42 }]
    windowsById.set(42, win)
    await dispatchCateInvoke(firstParty(), 'cate.terminal.type', { panelId: 'term-7', text: 'ls' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ method: 'cate.terminal.type', args: { panelId: 'term-7', text: 'ls' } }),
    )
  })
})

describe('dispatchCateInvoke — first-party trust boundary (characterization)', () => {
  function makeWin() {
    const send = vi.fn(() => { throw new Error('no-reply') })
    return { win: { isDestroyed: () => false, webContents: { send } }, send }
  }

  it('the Browser → Control permission gates acting verbs but not reading ones', async () => {
    settings.cliBrowserControlEnabled = false
    const { win, send } = makeWin()
    activeWindow.value = win
    const s: InvokeScope = { workspaceId: WS, panelId: '', forward: vi.fn(),
    }
    expect(await dispatchCateInvoke(s, 'cate.browser.command', {
      command: ['click', '@s1e1'],
    })).toEqual({
      error: BROWSER_CONTROL_DISABLED,
      method: 'cate.browser.command',
    })
    // Refused by the permission, not a prompt — and the browser was never touched.
    expect(send).not.toHaveBeenCalled()
    expect(BROWSER_CONTROL_DISABLED).toMatch(/Settings → CLI/)
    // Read stays allowed: the two halves are independent.
    await dispatchCateInvoke(s, 'cate.browser.readCommand', { command: ['snapshot', '-i'] })
    expect(send).toHaveBeenCalledTimes(1)
    // The request-aware gate cannot be bypassed by using the read envelope.
    expect(await dispatchCateInvoke(s, 'cate.browser.readCommand', {
      command: ['click', '@s1e1'],
    })).toEqual({
      error: BROWSER_CONTROL_DISABLED,
      method: 'cate.browser.readCommand',
    })
  })

  it('the Browser → Read permission gates snapshot/screenshot while Control stays on', async () => {
    settings.cliBrowserReadEnabled = false
    const { win, send } = makeWin()
    activeWindow.value = win
    const s: InvokeScope = { workspaceId: WS, panelId: '', forward: vi.fn(),
    }
    expect(await dispatchCateInvoke(s, 'cate.browser.readCommand', {
      command: ['snapshot'],
    })).toEqual({
      error: BROWSER_READ_DISABLED,
      method: 'cate.browser.readCommand',
    })
    expect(await dispatchCateInvoke(s, 'cate.browser.readCommand', {
      command: ['get', 'text', '@s1e1'],
    })).toEqual({
      error: BROWSER_READ_DISABLED,
      method: 'cate.browser.readCommand',
    })
    expect(send).not.toHaveBeenCalled()
    expect(BROWSER_READ_DISABLED).toMatch(/Settings → CLI/)
    // Control is a separate grant and still goes through.
    await dispatchCateInvoke(s, 'cate.browser.command', { command: ['click', '@s1e1'] })
    expect(send).toHaveBeenCalledTimes(1)
  })

  // --- The rest of the matrix: Panels, Editor, Notifications ------------------

  it('gates panel, editor and notification verbs on their own matrix cells', async () => {
    const { win } = makeWin()
    activeWindow.value = win
    windowPanelList.value = [{ panelId: 'p1', type: 'editor', ownerWindowId: 1 }]
    const s: InvokeScope = { workspaceId: WS, panelId: '', forward: vi.fn(),
    }

    // Each cell denies exactly its own half, naming itself in the error.
    settings.cliPanelReadEnabled = false
    expect(await dispatchCateInvoke(s, 'cate.panel.list', {})).toEqual({
      error: cliPermissionDenied(cliPermissionCellByKey('cliPanelReadEnabled')),
      method: 'cate.panel.list',
    })
    settings.cliPanelControlEnabled = false
    expect(await dispatchCateInvoke(s, 'cate.canvas.createPanel', { type: 'terminal' })).toEqual({
      error: cliPermissionDenied(cliPermissionCellByKey('cliPanelControlEnabled')),
      method: 'cate.canvas.createPanel',
    })
    settings.cliEditorControlEnabled = false
    expect(await dispatchCateInvoke(s, 'cate.editor.openFile', { path: '/a.ts' })).toEqual({
      error: cliPermissionDenied(cliPermissionCellByKey('cliEditorControlEnabled')),
      method: 'cate.editor.openFile',
    })
    settings.cliNotifyEnabled = false
    expect(await dispatchCateInvoke(s, 'cate.ui.notify', { message: 'hi' })).toEqual({
      error: cliPermissionDenied(cliPermissionCellByKey('cliNotifyEnabled')),
      method: 'cate.ui.notify',
    })
    expect(showOsNotification).not.toHaveBeenCalled()
  })

  it('gates agent observation and control on separate matrix cells', async () => {
    const forward = vi.fn(async () => [])
    const s: InvokeScope = { workspaceId: WS, panelId: 'supervisor-1', forward,
    }

    settings.cliAgentReadEnabled = false
    expect(await dispatchCateInvoke(s, 'cate.codingAgent.list', {})).toEqual({
      error: cliPermissionDenied(cliPermissionCellByKey('cliAgentReadEnabled')),
      method: 'cate.codingAgent.list',
    })
    settings.cliAgentReadEnabled = true
    settings.cliAgentControlEnabled = false
    expect(await dispatchCateInvoke(s, 'cate.codingAgent.create', { prompt: 'Do it' })).toEqual({
      error: cliPermissionDenied(cliPermissionCellByKey('cliAgentControlEnabled')),
      method: 'cate.codingAgent.create',
    })
    expect(forward).not.toHaveBeenCalled()
  })

  it('does not let first-party callers change the user view with panel.focus', async () => {
    const forward = vi.fn()
    windowPanelList.value = [{ panelId: 'p1', type: 'editor', ownerWindowId: 1 }]
    const s: InvokeScope = { workspaceId: WS, panelId: '', forward,
    }

    expect(await dispatchCateInvoke(s, 'cate.panel.focus', { panelId: 'p1' })).toEqual({
      error: 'unsupported',
      method: 'cate.panel.focus',
    })
    expect(revealWindowPanel).not.toHaveBeenCalled()
    expect(forward).not.toHaveBeenCalled()
  })

  it('an unlisted verb in a covered namespace falls into that surface\'s Control cell', () => {
    // New verbs must fail into the stricter half rather than escaping the matrix.
    expect(cliPermissionForMethod('cate.browser.somethingNew')?.key).toBe('cliBrowserControlEnabled')
    expect(cliPermissionForMethod('cate.panel.somethingNew')?.key).toBe('cliPanelControlEnabled')
    expect(cliPermissionForMethod('cate.codingAgent.somethingNew')?.key).toBe('cliAgentControlEnabled')
    expect(cliPermissionForMethod('cate.review.inspect')?.key).toBe('cliAgentReadEnabled')
    expect(cliPermissionForMethod('cate.review.somethingNew')?.key).toBe('cliAgentControlEnabled')
    // Unknown namespaces have no permission cell and are rejected by dispatch.
    expect(cliPermissionForMethod('cate.unknown.get')).toBeUndefined()
    expect(cliPermissionForMethod('cate.version')).toBeUndefined()
  })
})
