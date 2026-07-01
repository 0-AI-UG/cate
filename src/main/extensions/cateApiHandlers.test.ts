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

// --- electron: only app is touched at module load (will-quit handler) --------
const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn(async () => ({ response: 0 })) }))
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { on: vi.fn() },
  dialog: { showMessageBox },
}))

// Agent runtime is a heavy singleton; stub it so importing cateApiHandlers
// stays light and cate.agent.run dispatch is observable.
const { runForExtension, openForExtension, sendForExtension, disposeForExtension, cancelForExtension } =
  vi.hoisted(() => ({
    runForExtension: vi.fn(async () => ({ text: 'done', message: null })),
    openForExtension: vi.fn(async () => ({ sessionId: 'sess-1' })),
    sendForExtension: vi.fn(async () => ({ text: 'reply', message: { role: 'assistant' } })),
    disposeForExtension: vi.fn(async () => {}),
    cancelForExtension: vi.fn(async () => {}),
  }))
vi.mock('../../agent/main/agentManager', () => ({
  agentManager: { runForExtension, openForExtension, sendForExtension, disposeForExtension, cancelForExtension },
}))

// cate.ui.notify reuses the shared OS-notification path; spy on it + the setting.
const { showOsNotification, settings } = vi.hoisted(() => ({
  showOsNotification: vi.fn(),
  settings: { notificationsEnabled: true },
}))
vi.mock('../ipc/notifications', () => ({ showOsNotification }))

// --- extension registry: enabled/known toggled per test via `state.enabled` ---
const state = vi.hoisted(() => ({
  enabled: true,
  scopes: ['storage', 'editor', 'canvas', 'theme', 'ui', 'workspace.read'] as string[] | undefined,
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
const { activeWindow } = vi.hoisted(() => ({ activeWindow: { value: undefined as unknown } }))
vi.mock('../windowRegistry', () => ({ getActiveMainWindow: () => activeWindow.value }))
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

import { dispatchCateInvoke, type InvokeScope } from './cateApiHandlers'

const EXT = 'cate.kitchensink'
const WS = 'ws-1'
const PANEL = 'panel-1'

function scope(forward: InvokeScope['forward'] = vi.fn()): InvokeScope {
  return { extensionId: EXT, workspaceId: WS, panelId: PANEL, forward }
}

beforeEach(() => {
  state.enabled = true
  state.scopes = ['storage', 'editor', 'canvas', 'theme', 'ui', 'workspace.read']
  settings.notificationsEnabled = true
  activeWindow.value = undefined
  kv.clear()
  panelKv.clear()
  showOsNotification.mockClear()
  showMessageBox.mockClear()
  showMessageBox.mockResolvedValue({ response: 0 })
  runForExtension.mockClear()
  runForExtension.mockResolvedValue({ text: 'done', message: null })
  openForExtension.mockClear()
  openForExtension.mockResolvedValue({ sessionId: 'sess-1' })
  sendForExtension.mockClear()
  sendForExtension.mockResolvedValue({ text: 'reply', message: { role: 'assistant' } })
  disposeForExtension.mockClear()
  cancelForExtension.mockClear()
})

describe('dispatchCateInvoke — Kitchen Sink reverse API', () => {
  it('reports the API version for feature detection', async () => {
    expect(await dispatchCateInvoke(scope(), 'cate.version', undefined)).toBe(1)
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
  ])('forwards %s to the owning renderer', async (method, args) => {
    const forward = vi.fn(async () => ({ panelId: 'new' }))
    const res = await dispatchCateInvoke(scope(forward), method, args)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ method, args, extensionId: EXT, workspaceId: WS, panelId: PANEL }))
    expect(res).toEqual({ panelId: 'new' })
  })

  it('rejects unknown methods as unsupported', async () => {
    expect(await dispatchCateInvoke(scope(), 'cate.bogus.method', undefined)).toEqual({ error: 'unsupported', method: 'cate.bogus.method' })
  })

  it('denies methods whose scope the manifest does not declare', async () => {
    // No declared scopes → every scoped method is rejected, but version /
    // panel.* stay allowed (feature detection + panel self-control).
    state.scopes = undefined
    const forward = vi.fn()
    expect(await dispatchCateInvoke(scope(forward), 'cate.version', undefined)).toBe(1)
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

describe('dispatchCateInvoke — cate.agent.run', () => {
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

  it('denies cate.agent.run when the manifest lacks the agent scope', async () => {
    // default scopes (no `agent`)
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.run', { prompt: 'hi' }))
      .toEqual({ error: 'scope-denied', method: 'cate.agent.run' })
    expect(runForExtension).not.toHaveBeenCalled()
  })

  it('runs one turn through pi after consent and returns the final text', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    const s = agentScope()
    const res = await dispatchCateInvoke(s, 'cate.agent.run', { prompt: '  build it  ' })
    expect(res).toEqual({ text: 'done', message: null })
    expect(showMessageBox).toHaveBeenCalledTimes(1) // first-use consent
    expect(runForExtension).toHaveBeenCalledWith('build it', {
      workspaceId: WS,
      locator: '/ws/root',
      extensionId: s.extensionId,
      sender: fakeWin.webContents,
    })
  })

  it('rejects an empty prompt before touching the agent', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.run', { prompt: '   ' }))
      .toEqual({ error: 'bad-args', method: 'cate.agent.run' })
    expect(runForExtension).not.toHaveBeenCalled()
  })

  it('does not run when the user denies consent', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    showMessageBox.mockResolvedValue({ response: 1 }) // Deny
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.run', { prompt: 'hi' }))
      .toEqual({ error: 'consent-denied', method: 'cate.agent.run' })
    expect(runForExtension).not.toHaveBeenCalled()
  })

  it('surfaces the one-run-at-a-time guard as agent-busy', async () => {
    state.scopes = ['agent']
    activeWindow.value = fakeWin
    runForExtension.mockRejectedValueOnce(new Error('agent-busy'))
    expect(await dispatchCateInvoke(agentScope(), 'cate.agent.run', { prompt: 'hi' }))
      .toEqual({ error: 'agent-busy', method: 'cate.agent.run' })
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
      resume: validResume,
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
