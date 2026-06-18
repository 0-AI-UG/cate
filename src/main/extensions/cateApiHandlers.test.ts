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
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { on: vi.fn() },
}))

// cate.ui.notify reuses the shared OS-notification path; spy on it + the setting.
const { showOsNotification, settings } = vi.hoisted(() => ({
  showOsNotification: vi.fn(),
  settings: { notificationsEnabled: true },
}))
vi.mock('../ipc/notifications', () => ({ showOsNotification }))

// --- extension registry: enabled/known toggled per test via `state.enabled` ---
const state = vi.hoisted(() => ({ enabled: true }))
vi.mock('./ExtensionManager', () => ({
  extensionManager: {
    isKnown: () => true,
    isEnabled: () => state.enabled,
    getManifest: () => ({ id: 'cate.kitchensink', name: 'Kitchen Sink', panels: [{ id: 'main', label: 'Kitchen Sink' }] }),
  },
}))

// Heavy collaborators pulled in by the module's top-level imports — stubbed so
// importing cateApiHandlers doesn't drag in the proxy/server/IPC machinery.
vi.mock('./proxyServer', () => ({ getProxyUrlFor: vi.fn() }))
vi.mock('./ExtensionServerManager', () => ({ extensionServerManager: {} }))
vi.mock('../windowRegistry', () => ({ getActiveMainWindow: vi.fn(() => undefined) }))
vi.mock('../runtime/locator', () => ({ parseLocator: (raw: string) => ({ runtimeId: 'local', path: raw }) }))
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
  settings.notificationsEnabled = true
  kv.clear()
  panelKv.clear()
  showOsNotification.mockClear()
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
