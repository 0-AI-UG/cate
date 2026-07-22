// =============================================================================
// Reverse-API dispatch (cate.* surface) — the methods the Kitchen Sink test
// extension drives end to end. Exercises dispatchCateInvoke, the single core
// shared by the webview-guest IPC path and the server-side CATE_API reverse
// endpoint:
//
//   version / workspace.get / theme.get / ui.notify   — handled in main
//   storage.get|set|delete|keys|panel.get|panel.set   — backed by storage.ts
//   editor.openFile / canvas.createPanel / panel.setTitle — forwarded to a renderer
//   the not-enabled security gate + unknown methods   — rejected
//
// Collaborators are mocked; storage is a real in-memory fake so the round-trip
// the Kitchen Sink does (set then get) is asserted for real.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'

// --- electron: only app is touched at module load (will-quit handler) --------
const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn(async () => ({ response: 0 })) }))
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { on: vi.fn() },
  dialog: { showMessageBox },
}))

// Agent runtime is a heavy singleton; stub it so importing cateApiHandlers
// stays light and cate.agent.* dispatch is observable.
const { openForExtension, sendForExtension, disposeForExtension, cancelForExtension } =
  vi.hoisted(() => ({
    openForExtension: vi.fn(async () => ({ sessionId: 'sess-1' })),
    sendForExtension: vi.fn(async () => ({ text: 'reply', message: { role: 'assistant' } })),
    disposeForExtension: vi.fn(async () => {}),
    cancelForExtension: vi.fn(async () => {}),
  }))
vi.mock('../../agent/main/agentManager', () => ({
  agentManager: { openForExtension, sendForExtension, disposeForExtension, cancelForExtension },
}))

// cate.ui.notify reuses the shared OS-notification path; spy on it + the setting.
const { showOsNotification, settings } = vi.hoisted(() => ({
  showOsNotification: vi.fn(),
  settings: {
    notificationsEnabled: true,
    cliBrowserReadEnabled: true,
    cliBrowserControlEnabled: true,
    cliTerminalReadEnabled: true,
    cliTerminalInputEnabled: false,
    cliPanelReadEnabled: true,
    cliPanelControlEnabled: true,
    cliEditorReadEnabled: true,
    cliEditorControlEnabled: true,
    cliNotifyEnabled: true,
  },
}))
vi.mock('../ipc/notifications', () => ({ showOsNotification }))

// --- extension registry: enabled/known toggled per test via `state.enabled` ---
const state = vi.hoisted(() => ({
  enabled: true,
  scopes: ['storage', 'editor', 'canvas', 'theme', 'ui', 'workspace.read', 'panel'] as string[] | undefined,
}))
vi.mock('./ExtensionManager', () => ({
  extensionManager: {
    isKnown: () => true,
    isEnabled: () => state.enabled,
    getManifest: () => ({ id: 'cate.kitchensink', name: 'Kitchen Sink', panels: [{ id: 'main', label: 'Kitchen Sink' }], cateApi: state.scopes }),
  },
}))

// Heavy collaborators pulled in by the module's top-level imports — stubbed so
// importing cateApiHandlers doesn't drag in the proxy/server/IPC machinery.
vi.mock('./proxyServer', () => ({ getProxyUrlFor: vi.fn() }))
vi.mock('./ExtensionServerManager', () => ({ extensionServerManager: {} }))
const { activeWindow, windowsById, windowPanelList, revealWindowPanel, upsertWindowPanel, removeWindowPanel } = vi.hoisted(() => ({
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
  }> },
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
  revealWindowPanel,
  upsertWindowPanel,
  removeWindowPanel,
}))
vi.mock('../runtime/locator', () => ({
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

// In-memory storage fake mirroring ExtensionStorage's contract.
const { kv, panelKv } = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  panelKv: new Map<string, Map<string, unknown>>(),
}))
vi.mock('./storage', () => ({
  getExtensionStorage: () => ({
    get: (k: string) => kv.get(k),
    set: (k: string, v: unknown) => { kv.set(k, v) },
    delete: (k: string) => { kv.delete(k) },
    keys: () => [...kv.keys()],
    panelGet: (pid: string, k: string) => panelKv.get(pid)?.get(k),
    panelSet: (pid: string, k: string, v: unknown) => {
      if (!panelKv.has(pid)) panelKv.set(pid, new Map())
      panelKv.get(pid)!.set(k, v)
    },
    onChange: () => () => {},
  }),
}))

import {
  dispatchCateInvoke,
  requiredScopeFor,
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
import { GRANTED_SCOPES } from './workspaceCateApi'

const EXT = 'cate.kitchensink'
const WS = 'ws-1'
const PANEL = 'panel-1'

function scope(forward: InvokeScope['forward'] = vi.fn()): InvokeScope {
  return { extensionId: EXT, workspaceId: WS, panelId: PANEL, forward }
}

beforeEach(() => {
  state.enabled = true
  state.scopes = ['storage', 'editor', 'canvas', 'theme', 'ui', 'workspace.read', 'panel']
  settings.notificationsEnabled = true
  settings.cliBrowserReadEnabled = true
  settings.cliBrowserControlEnabled = true
  settings.cliTerminalReadEnabled = true
  settings.cliTerminalInputEnabled = false
  settings.cliPanelReadEnabled = true
  settings.cliPanelControlEnabled = true
  settings.cliEditorReadEnabled = true
  settings.cliEditorControlEnabled = true
  settings.cliNotifyEnabled = true
  activeWindow.value = undefined
  windowsById.clear()
  windowPanelList.value = []
  revealWindowPanel.mockClear()
  revealWindowPanel.mockReturnValue(true)
  removeWindowPanel.mockClear()
  upsertWindowPanel.mockClear()
  kv.clear()
  panelKv.clear()
  showOsNotification.mockClear()
  showMessageBox.mockClear()
  showMessageBox.mockResolvedValue({ response: 0 })
  openForExtension.mockClear()
  openForExtension.mockResolvedValue({ sessionId: 'sess-1' })
  sendForExtension.mockClear()
  sendForExtension.mockResolvedValue({ text: 'reply', message: { role: 'assistant' } })
  disposeForExtension.mockClear()
  cancelForExtension.mockClear()
})

describe('dispatchCateInvoke — Kitchen Sink reverse API', () => {
  it('reports the API version for feature detection', async () => {
    expect(await dispatchCateInvoke(scope(), 'cate.version', undefined)).toBe(3)
  })

  it('resolves the workspace root from the locator', async () => {
    const res = await dispatchCateInvoke(scope(), 'cate.workspace.get', undefined)
    expect(res).toEqual({ rootPath: '/ws/root', branch: null, worktree: null })
  })

  it('returns the active theme tokens', async () => {
    const res = (await dispatchCateInvoke(scope(), 'cate.theme.get', undefined)) as { id: string; type: string; app: Record<string, string> }
    expect(res.id).toBe('dark-cold')
    expect(res.type).toBe('dark')
    expect(res.app['editor-bg']).toBe('#111')
  })

  it('shows an OS notification for ui.notify via the shared path, titled with the extension name', async () => {
    const res = await dispatchCateInvoke(scope(), 'cate.ui.notify', { message: 'hi', level: 'info' })
    expect(res).toEqual({ ok: true })
    expect(showOsNotification).toHaveBeenCalledTimes(1)
    expect(showOsNotification).toHaveBeenCalledWith({ title: 'Kitchen Sink', body: 'hi' })
  })

  it('suppresses ui.notify when the user disabled notifications', async () => {
    settings.notificationsEnabled = false
    const res = await dispatchCateInvoke(scope(), 'cate.ui.notify', { message: 'hi' })
    expect(res).toEqual({ ok: true })
    expect(showOsNotification).not.toHaveBeenCalled()
  })

  it('round-trips extension-scoped storage (set then get), the Kitchen Sink autosave path', async () => {
    expect(await dispatchCateInvoke(scope(), 'cate.storage.set', { key: 'kitchensink:notes', value: 'hello' })).toEqual({ ok: true })
    expect(await dispatchCateInvoke(scope(), 'cate.storage.get', { key: 'kitchensink:notes' })).toBe('hello')
    expect(await dispatchCateInvoke(scope(), 'cate.storage.keys', undefined)).toEqual(['kitchensink:notes'])
    expect(await dispatchCateInvoke(scope(), 'cate.storage.delete', { key: 'kitchensink:notes' })).toEqual({ ok: true })
    expect(await dispatchCateInvoke(scope(), 'cate.storage.get', { key: 'kitchensink:notes' })).toBeUndefined()
  })

  it('round-trips panel-scoped storage isolated to the calling panel', async () => {
    await dispatchCateInvoke(scope(), 'cate.storage.panel.set', { key: 'scroll', value: 42 })
    expect(await dispatchCateInvoke(scope(), 'cate.storage.panel.get', { key: 'scroll' })).toBe(42)
    // A different panel id sees nothing.
    const other: InvokeScope = { extensionId: EXT, workspaceId: WS, panelId: 'panel-2', forward: vi.fn() }
    expect(await dispatchCateInvoke(other, 'cate.storage.panel.get', { key: 'scroll' })).toBeUndefined()
  })

  it.each([
    ['cate.editor.openFile', { path: 'package.json' }],
    ['cate.canvas.createPanel', { type: 'extension', extensionPanelId: 'main' }],
    ['cate.panel.setTitle', { title: 'Renamed' }],
    ['cate.panel.list', {}],
    ['cate.panel.focus', { panelId: 'p1' }],
    ['cate.panel.close', { panelId: 'p1' }],
  ])('forwards %s to the owning renderer', async (method, args) => {
    const forward = vi.fn(async () => ({ panelId: 'new' }))
    const res = await dispatchCateInvoke(scope(forward), method, args)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({
      method,
      args: expect.objectContaining(args),
      extensionId: EXT,
      workspaceId: WS,
      panelId: PANEL,
    }))
    expect(res).toEqual({ panelId: 'new' })
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

  it('panel.focus routes a detached panel through the cross-window revealer', async () => {
    windowPanelList.value = [{ panelId: 'detached', type: 'editor', workspaceId: WS, ownerWindowId: 2 }]

    expect(await dispatchCateInvoke(scope(), 'cate.panel.focus', { panelId: 'detached' })).toEqual({ ok: true })
    expect(revealWindowPanel).toHaveBeenCalledWith('detached')
  })

  it('denies methods whose scope the manifest does not declare', async () => {
    // No declared scopes → every scoped method is rejected, but version /
    // panel.* stay allowed (feature detection + panel self-control).
    state.scopes = undefined
    const forward = vi.fn()
    expect(await dispatchCateInvoke(scope(forward), 'cate.version', undefined)).toBe(3)
    expect(await dispatchCateInvoke(scope(forward), 'cate.storage.get', { key: 'k' })).toEqual({ error: 'scope-denied', method: 'cate.storage.get' })
    expect(await dispatchCateInvoke(scope(forward), 'cate.editor.openFile', { path: 'x' })).toEqual({ error: 'scope-denied', method: 'cate.editor.openFile' })
    expect(await dispatchCateInvoke(scope(forward), 'cate.theme.get', undefined)).toEqual({ error: 'scope-denied', method: 'cate.theme.get' })
    expect(forward).not.toHaveBeenCalled()
  })

  it('accepts a bare namespace scope for a more specific method (editor grants editor.write)', async () => {
    state.scopes = ['editor']
    const forward = vi.fn(async () => ({ panelId: 'new' }))
    expect(await dispatchCateInvoke(scope(forward), 'cate.editor.openFile', { path: 'x' })).toEqual({ panelId: 'new' })
  })

  it('gates every method behind the enabled check', async () => {
    state.enabled = false
    const forward = vi.fn()
    expect(await dispatchCateInvoke(scope(forward), 'cate.version', undefined)).toEqual({ error: 'not-enabled', method: 'cate.version' })
    expect(await dispatchCateInvoke(scope(forward), 'cate.storage.get', { key: 'k' })).toEqual({ error: 'not-enabled', method: 'cate.storage.get' })
    expect(await dispatchCateInvoke(scope(forward), 'cate.editor.openFile', { path: 'x' })).toEqual({ error: 'not-enabled', method: 'cate.editor.openFile' })
    // The security gate fires before any forward to a renderer.
    expect(forward).not.toHaveBeenCalled()
  })
})

describe('dispatchCateInvoke — cate.agent.* (open/send/dispose; run is gone)', () => {
  const fakeWin = { isDestroyed: () => false, webContents: {} }
  // Consent is granted once per extension for the app session, so each test
  // uses a fresh extension id to stay isolated.
  let seq = 0
  const agentScope = (): InvokeScope => ({
    extensionId: `cate.agent-test-${++seq}`,
    workspaceId: WS,
    panelId: PANEL,
    forward: vi.fn(),
  })

  it('cate.agent.run is no longer a method (compose open -> send -> dispose)', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.run', { prompt: 'hi' }))
      .toEqual({ error: 'unsupported', method: 'cate.agent.run' })
  })

  it('denies cate.agent.open when the manifest lacks the agent scope', async () => {
    // default scopes (no `agent`)
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.open', {}))
      .toEqual({ error: 'scope-denied', method: 'cate.agent.open' })
    expect(openForExtension).not.toHaveBeenCalled()
  })

  it('opens a session after consent and sends one turn', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    const s = agentScope()
    const opened = await dispatchCateInvoke(s, 'cate.agent.open', {})
    expect(opened).toEqual({ sessionId: 'sess-1' })
    expect(showMessageBox).toHaveBeenCalledTimes(1) // first-use consent
    expect(openForExtension).toHaveBeenCalledWith({
      workspaceId: WS,
      locator: '/ws/root',
      extensionId: s.extensionId,
      sender: fakeWin.webContents,
      resume: undefined,
    })
    const res = await dispatchCateInvoke(s, 'cate.agent.send', { sessionId: 'sess-1', prompt: 'build it' })
    expect(res).toEqual({ text: 'reply', message: { role: 'assistant' } })
    expect(sendForExtension).toHaveBeenCalledWith({ extensionId: s.extensionId, sessionId: 'sess-1', text: 'build it' })
  })

  it('rejects a send without a prompt or session before touching the agent', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.send', { sessionId: 'sess-1', prompt: '   ' }))
      .toEqual({ error: 'bad-args', method: 'cate.agent.send' })
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.send', { prompt: 'hi' }))
      .toEqual({ error: 'bad-args', method: 'cate.agent.send' })
    expect(sendForExtension).not.toHaveBeenCalled()
  })

  it('does not open when the user denies consent', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    showMessageBox.mockResolvedValue({ response: 1 }) // Deny
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.open', {}))
      .toEqual({ error: 'consent-denied', method: 'cate.agent.open' })
    expect(openForExtension).not.toHaveBeenCalled()
  })

  it('surfaces the one-turn-at-a-time guard as agent-busy', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    sendForExtension.mockRejectedValueOnce(new Error('agent-busy'))
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.send', { sessionId: 'sess-1', prompt: 'hi' }))
      .toEqual({ error: 'agent-busy', method: 'cate.agent.send' })
  })

  it('cancels this extension\'s in-flight run', async () => {
    state.scopes = ['agent']
    const s = agentScope()
    expect(await dispatchCateInvoke(s, 'cate.agent.cancel', undefined)).toEqual({ ok: true })
    expect(cancelForExtension).toHaveBeenCalledWith(s.extensionId)
  })

  it('opens a session after consent and returns its handle', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    const s = agentScope()
    // A valid resume handle is a session-jsonl path inside this workspace's
    // .cate/pi-agent dir (getWorkspaceInfo → rootPath '/ws/root').
    const validResume = '/ws/root/.cate/pi-agent/sessions/-ws-root--/abc.jsonl'
    const res = await dispatchCateInvoke(s, 'cate.agent.open', { resume: validResume })
    expect(res).toEqual({ sessionId: 'sess-1' })
    expect(showMessageBox).toHaveBeenCalledTimes(1) // first-use consent
    expect(openForExtension).toHaveBeenCalledWith({
      workspaceId: WS,
      locator: '/ws/root',
      extensionId: s.extensionId,
      sender: fakeWin.webContents,
      // boundedResumePath canonicalizes via the local host's path flavor, so on
      // Windows the accepted handle comes back with native separators.
      resume: path.normalize(validResume),
    })
  })

  it('opens a fresh session when no resume is supplied', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    const s = agentScope()
    const res = await dispatchCateInvoke(s, 'cate.agent.open', {})
    expect(res).toEqual({ sessionId: 'sess-1' })
    expect(openForExtension).toHaveBeenCalledWith(
      expect.objectContaining({ extensionId: s.extensionId, resume: undefined }),
    )
  })

  it.each([
    ['a parent-traversal resume', '/ws/root/.cate/pi-agent/../../../etc/passwd'],
    ['an absolute resume outside the workspace', '/etc/x'],
    ['another workspace\'s session', '/other/project/.cate/pi-agent/sessions/s/x.jsonl'],
    ['a relative resume (not an absolute session path)', '../../other/session.jsonl'],
    ['a bare basename (agentManager needs a full path)', 'abc.jsonl'],
  ])('rejects %s before reaching agentManager', async (_label, resume) => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    const res = await dispatchCateInvoke(agentScope(), 'cate.agent.open', { resume })
    expect(res).toEqual({ error: 'invalid-resume', method: 'cate.agent.open' })
    expect(openForExtension).not.toHaveBeenCalled()
    // Rejected before the consent prompt, too.
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('sends a turn to an open session without re-prompting consent', async () => {
    state.scopes = ['agent']
    const s = agentScope()
    const res = await dispatchCateInvoke(s, 'cate.agent.send', { sessionId: 'sess-1', prompt: '  hi  ' })
    expect(res).toEqual({ text: 'reply', message: { role: 'assistant' } })
    expect(sendForExtension).toHaveBeenCalledWith({ extensionId: s.extensionId, sessionId: 'sess-1', text: 'hi' })
    expect(showMessageBox).not.toHaveBeenCalled() // no consent gate on send
  })

  it('rejects a send with no sessionId or prompt', async () => {
    state.scopes = ['agent']
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.send', { prompt: 'hi' }))
      .toEqual({ error: 'bad-args', method: 'cate.agent.send' })
    expect(sendForExtension).not.toHaveBeenCalled()
  })

  it('maps an unknown/foreign session to no-session', async () => {
    state.scopes = ['agent']
    sendForExtension.mockRejectedValueOnce(new Error('no-session'))
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.send', { sessionId: 'x', prompt: 'hi' }))
      .toEqual({ error: 'no-session', method: 'cate.agent.send' })
  })

  it('disposes an open session', async () => {
    state.scopes = ['agent']
    const s = agentScope()
    expect(await dispatchCateInvoke(s, 'cate.agent.dispose', { sessionId: 'sess-1' })).toEqual({ ok: true })
    expect(disposeForExtension).toHaveBeenCalledWith({ extensionId: s.extensionId, sessionId: 'sess-1' })
  })
})

describe('dispatchCateInvoke — cate.browser.* namespace', () => {
  // webContents.send throws so the real forwardToOwner resolves fast ('no-owner')
  // rather than waiting 10s for a reply, while still recording the target.
  function makeWin() {
    const send = vi.fn(() => { throw new Error('no-reply') })
    return { win: { isDestroyed: () => false, webContents: { send } }, send }
  }

  // Browser consent is granted once per extension for the app session (module-
  // level Set), so each consent test uses a fresh extension id to stay isolated.
  let extSeq = 0
  const extBrowserScope = (): InvokeScope => ({
    extensionId: `cate.browser-ext-${++extSeq}`,
    workspaceId: WS,
    panelId: PANEL,
    forward: vi.fn(),
  })

  it('maps every cate.browser.* method to the single `browser` scope', () => {
    expect(requiredScopeFor('cate.browser.open')).toBe('browser')
    expect(requiredScopeFor('cate.browser.back')).toBe('browser')
    expect(requiredScopeFor('cate.browser.wait')).toBe('browser')
    expect(requiredScopeFor('cate.browser.press')).toBe('browser')
  })

  it('panel.list/focus/close need the `panel` scope; panel self-identity stays scope-free', () => {
    expect(requiredScopeFor('cate.panel.list')).toBe('panel')
    expect(requiredScopeFor('cate.panel.focus')).toBe('panel')
    expect(requiredScopeFor('cate.panel.close')).toBe('panel')
    expect(requiredScopeFor('cate.panel.setTitle')).toBeNull()
  })

  it('denies panel.list without the panel scope', async () => {
    state.scopes = ['editor']
    const forward = vi.fn()
    expect(await dispatchCateInvoke(scope(forward), 'cate.panel.list', {})).toEqual({
      error: 'scope-denied',
      method: 'cate.panel.list',
    })
    expect(forward).not.toHaveBeenCalled()
  })

  it('lets a first-party caller with granted `browser` scope through the gate', async () => {
    const { win, send } = makeWin()
    activeWindow.value = win
    const s: InvokeScope = {
      extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward: vi.fn(),
      caller: 'first-party', grantedScopes: ['browser'],
    }
    const res = await dispatchCateInvoke(s, 'cate.browser.back', {})
    // Passed the scope gate and reached the forward to the active window (no
    // panelId given) — not scope-denied, no consent prompt for first-party.
    expect(res).not.toEqual({ error: 'scope-denied', method: 'cate.browser.back' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('denies an extension whose manifest lacks the `browser` scope', async () => {
    activeWindow.value = makeWin().win
    state.scopes = ['storage', 'editor'] // no browser
    const res = await dispatchCateInvoke(scope(), 'cate.browser.back', {})
    expect(res).toEqual({ error: 'scope-denied', method: 'cate.browser.back' })
  })

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
    const s: InvokeScope = {
      extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward: vi.fn(),
      caller: 'first-party', grantedScopes: ['browser'],
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
    const s: InvokeScope = {
      extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward,
      caller: 'first-party', grantedScopes: ['browser'],
    }
    const res = await dispatchCateInvoke(s, 'cate.browser.back', { panelId: 'does-not-exist' })
    expect(res).toEqual({ error: 'no-such-browser', method: 'cate.browser.back' })
    expect(forward).not.toHaveBeenCalled()
  })

  it('returns no-host-window when there is no active window and no panelId', async () => {
    activeWindow.value = undefined
    const s: InvokeScope = {
      extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward: vi.fn(),
      caller: 'first-party', grantedScopes: ['browser'],
    }
    const res = await dispatchCateInvoke(s, 'cate.browser.back', {})
    expect(res).toEqual({ error: 'no-host-window', method: 'cate.browser.back' })
  })

  // --- Extension consent (first-party skips this; extensions must be prompted) --

  it('denies an extension browser call when the user rejects the consent prompt', async () => {
    const { win, send } = makeWin()
    activeWindow.value = win
    state.scopes = ['browser']
    showMessageBox.mockResolvedValue({ response: 1 }) // Deny
    const res = await dispatchCateInvoke(extBrowserScope(), 'cate.browser.back', {})
    expect(res).toEqual({ error: 'consent-denied', method: 'cate.browser.back' })
    // Denied before the forward — the target window is never touched.
    expect(send).not.toHaveBeenCalled()
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('forwards an extension browser call after the user allows consent', async () => {
    const { win, send } = makeWin()
    activeWindow.value = win
    state.scopes = ['browser']
    // showMessageBox defaults to { response: 0 } (Allow) via beforeEach.
    const res = await dispatchCateInvoke(extBrowserScope(), 'cate.browser.back', {})
    // Passed consent and reached the forward (send throws → 'no-owner', not
    // 'consent-denied' / 'scope-denied').
    expect(res).not.toEqual({ error: 'consent-denied', method: 'cate.browser.back' })
    expect(res).not.toEqual({ error: 'scope-denied', method: 'cate.browser.back' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('prompts for browser consent only once per session for the same extension', async () => {
    const { win, send } = makeWin()
    activeWindow.value = win
    state.scopes = ['browser']
    const s = extBrowserScope()
    await dispatchCateInvoke(s, 'cate.browser.back', {})
    // A second cate.browser.* call from the same extension reuses the grant.
    await dispatchCateInvoke(s, 'cate.browser.forward', {})
    expect(showMessageBox).toHaveBeenCalledTimes(1) // no re-prompt
    expect(send).toHaveBeenCalledTimes(2) // both forwarded
  })

  // --- Addressed panel whose owner window is missing / destroyed ---------------

  it('returns no-host-window when the addressed browser panel’s owner window is missing', async () => {
    // Panel resolves to ownerWindowId 42, but the registry has no such window.
    windowPanelList.value = [{ panelId: 'browser-7', type: 'browser', ownerWindowId: 42 }]
    const forward = vi.fn()
    const s: InvokeScope = {
      extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward,
      caller: 'first-party', grantedScopes: ['browser'],
    }
    const res = await dispatchCateInvoke(s, 'cate.browser.back', { panelId: 'browser-7' })
    expect(res).toEqual({ error: 'no-host-window', method: 'cate.browser.back' })
    expect(forward).not.toHaveBeenCalled()
  })

  it('returns no-host-window when the addressed browser panel’s owner window is destroyed', async () => {
    const send = vi.fn()
    windowPanelList.value = [{ panelId: 'browser-7', type: 'browser', ownerWindowId: 42 }]
    windowsById.set(42, { isDestroyed: () => true, webContents: { id: 7, send } })
    const s: InvokeScope = {
      extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward: vi.fn(),
      caller: 'first-party', grantedScopes: ['browser'],
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

  const firstParty = (forward: InvokeScope['forward'] = vi.fn()): InvokeScope => ({
    extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward,
    caller: 'first-party', grantedScopes: ['terminal'],
  })

  it('maps every cate.terminal.* method to the single `terminal` scope', () => {
    expect(requiredScopeFor('cate.terminal.read')).toBe('terminal')
    expect(requiredScopeFor('cate.terminal.type')).toBe('terminal')
    expect(requiredScopeFor('cate.terminal.press')).toBe('terminal')
  })

  it('denies a caller without the terminal scope', async () => {
    state.scopes = ['browser'] // no terminal
    activeWindow.value = makeWin().win
    expect(await dispatchCateInvoke(scope(), 'cate.terminal.read', {})).toEqual({
      error: 'scope-denied',
      method: 'cate.terminal.read',
    })
  })

  it('forwards read to the active window when unaddressed (focused-terminal resolution is renderer-side)', async () => {
    const { win, send } = makeWin()
    activeWindow.value = win
    const res = await dispatchCateInvoke(firstParty(), 'cate.terminal.read', {})
    expect(res).not.toEqual({ error: 'scope-denied', method: 'cate.terminal.read' })
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

  it('rejects extension callers outright — the terminal surface is first-party only', async () => {
    // Everything else is in the extension's favor: enabled, terminal scope
    // declared, both toggles on. The caller check alone must refuse it.
    state.scopes = ['terminal']
    settings.cliTerminalReadEnabled = true
    settings.cliTerminalInputEnabled = true
    const { win, send } = makeWin()
    activeWindow.value = win
    for (const [method, args] of [
      ['cate.terminal.read', {}],
      ['cate.terminal.type', { panelId: 'term-7', text: 'ls' }],
      ['cate.terminal.press', { panelId: 'term-7', key: 'enter' }],
    ] as const) {
      expect(await dispatchCateInvoke(scope(), method, args)).toEqual({
        error: 'terminal-first-party-only',
        method,
      })
    }
    expect(send).not.toHaveBeenCalled()
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

// =============================================================================
// TRUST-BOUNDARY CHARACTERIZATION
//
// First-party callers (interactive terminals + the pi agent, reaching dispatch
// through the per-workspace CATE_API loopback) are DELIBERATELY trusted: they
// skip BOTH the extension-enabled/known gate (cateApiHandlers.ts ~376-380) and
// the browser consent prompt (~408-412), and carry GRANTED_SCOPES that include
// `browser` instead of a manifest (workspaceCateApi.ts ~14-15, ~41-56). The
// bearer token is a per-workspace randomBytes(32) bound to loopback and injected
// into every terminal PTY's env, so anything spawned in a Cate terminal inherits
// it and can drive `cate.browser.*` on the user's live browser with no prompt.
//
// This is a product/security TRADEOFF ("trusted terminal"), not a missing check.
// These tests LOCK IN that intended behavior so an accidental future change to
// the caller guards is caught. If the tradeoff is ever revisited, these are the
// assertions to flip on purpose.
// =============================================================================
describe('dispatchCateInvoke — first-party trust boundary (characterization)', () => {
  function makeWin() {
    const send = vi.fn(() => { throw new Error('no-reply') })
    return { win: { isDestroyed: () => false, webContents: { send } }, send }
  }

  it('first-party callers intentionally bypass the enabled gate AND the browser consent prompt', async () => {
    // enabled=false would make a NON-first-party caller fail the enabled gate
    // outright — proving the first-party pass-through is the branch under test
    // (not just an incidentally-enabled extension).
    state.enabled = false
    const { win, send } = makeWin()
    activeWindow.value = win
    const s: InvokeScope = {
      extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward: vi.fn(),
      caller: 'first-party', grantedScopes: ['browser'],
    }
    // A snapshot of the user's live, authenticated browser — the exact call the
    // trust boundary permits without a prompt.
    const res = await dispatchCateInvoke(s, 'cate.browser.snapshot', {})
    // Reached the forward (send throws → resolved as a no-owner-style result),
    // so it was NOT stopped by the enabled gate, the scope gate, or consent.
    expect(res).not.toEqual({ error: 'not-enabled', method: 'cate.browser.snapshot' })
    expect(res).not.toEqual({ error: 'scope-denied', method: 'cate.browser.snapshot' })
    expect(res).not.toEqual({ error: 'consent-denied', method: 'cate.browser.snapshot' })
    expect(send).toHaveBeenCalledTimes(1)
    // The load-bearing assertion: no consent dialog was shown for first-party.
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('a non-first-party (extension) caller with no prior consent IS prompted and denied', async () => {
    // Same enabled state as above would matter, but here the extension is enabled
    // and holds the browser scope, so the ONLY remaining gate is consent — which
    // first-party skipped above. A fresh ext id avoids the once-per-session grant.
    state.enabled = true
    state.scopes = ['browser']
    const { win, send } = makeWin()
    activeWindow.value = win
    showMessageBox.mockResolvedValue({ response: 1 }) // user clicks Deny
    const extScope: InvokeScope = {
      extensionId: 'cate.browser-boundary-ext', workspaceId: WS, panelId: PANEL, forward: vi.fn(),
    }
    const res = await dispatchCateInvoke(extScope, 'cate.browser.snapshot', {})
    expect(res).toEqual({ error: 'consent-denied', method: 'cate.browser.snapshot' })
    // The prompt WAS shown (unlike first-party) and the browser was never touched.
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('the Browser → Control permission gates acting verbs but not reading ones', async () => {
    settings.cliBrowserControlEnabled = false
    const { win, send } = makeWin()
    activeWindow.value = win
    const s: InvokeScope = {
      extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward: vi.fn(),
      caller: 'first-party', grantedScopes: ['browser'],
    }
    expect(await dispatchCateInvoke(s, 'cate.browser.click', { ref: 'e1' })).toEqual({
      error: BROWSER_CONTROL_DISABLED,
      method: 'cate.browser.click',
    })
    // Refused by the permission, not a prompt — and the browser was never touched.
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(BROWSER_CONTROL_DISABLED).toMatch(/Settings → CLI/)
    // Read stays allowed: the two halves are independent.
    await dispatchCateInvoke(s, 'cate.browser.snapshot', {})
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('the Browser → Read permission gates snapshot/screenshot while Control stays on', async () => {
    settings.cliBrowserReadEnabled = false
    const { win, send } = makeWin()
    activeWindow.value = win
    const s: InvokeScope = {
      extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward: vi.fn(),
      caller: 'first-party', grantedScopes: ['browser'],
    }
    expect(await dispatchCateInvoke(s, 'cate.browser.snapshot', {})).toEqual({
      error: BROWSER_READ_DISABLED,
      method: 'cate.browser.snapshot',
    })
    expect(send).not.toHaveBeenCalled()
    expect(BROWSER_READ_DISABLED).toMatch(/Settings → CLI/)
    // Control is a separate grant and still goes through.
    await dispatchCateInvoke(s, 'cate.browser.click', { ref: 'e1' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  // --- The rest of the matrix: Panels, Editor, Notifications ------------------

  it('gates panel, editor and notification verbs on their own matrix cells', async () => {
    const { win } = makeWin()
    activeWindow.value = win
    windowPanelList.value = [{ panelId: 'p1', type: 'editor', ownerWindowId: 1 }]
    const s: InvokeScope = {
      extensionId: 'cate.terminal', workspaceId: WS, panelId: '', forward: vi.fn(),
      caller: 'first-party', grantedScopes: [...GRANTED_SCOPES],
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

  it('an unlisted verb in a covered namespace falls into that surface\'s Control cell', () => {
    // New verbs must fail into the stricter half rather than escaping the matrix.
    expect(cliPermissionForMethod('cate.browser.somethingNew')?.key).toBe('cliBrowserControlEnabled')
    expect(cliPermissionForMethod('cate.panel.somethingNew')?.key).toBe('cliPanelControlEnabled')
    // Namespaces the matrix doesn't cover stay governed by scopes alone.
    expect(cliPermissionForMethod('cate.storage.get')).toBeUndefined()
    expect(cliPermissionForMethod('cate.version')).toBeUndefined()
  })

  it('CLI permissions do NOT affect extensions: a consented extension browses with both browser cells off', async () => {
    settings.cliBrowserControlEnabled = false
    settings.cliBrowserReadEnabled = false
    state.enabled = true
    state.scopes = ['browser']
    const { win, send } = makeWin()
    activeWindow.value = win
    showMessageBox.mockResolvedValue({ response: 0 }) // user clicks Allow
    const extScope: InvokeScope = {
      extensionId: 'cate.cli-toggle-boundary-ext', workspaceId: WS, panelId: PANEL, forward: vi.fn(),
    }
    const res = await dispatchCateInvoke(extScope, 'cate.browser.snapshot', {})
    // Consent (the extension gate) ran and the forward was reached — the CLI
    // toggle never came into play for a non-first-party caller.
    expect(res).not.toEqual({ error: BROWSER_CONTROL_DISABLED, method: 'cate.browser.snapshot' })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
