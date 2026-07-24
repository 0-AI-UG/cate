// =============================================================================
// CATE_HOST_SUBSCRIBE — repeated subscribes on ONE guest webContents must hook
// its 'destroyed' teardown at most once. A fresh 'destroyed' listener per
// subscribe would stack across subscribe/unsubscribe cycles and eventually trip
// Node's MaxListenersExceededWarning (unsubscribe removes the Subscription, not
// the hook), so the host dedups the hook per webContents.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the ipcMain handlers so we can invoke CATE_HOST_SUBSCRIBE directly.
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...a: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, cb: (...a: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...a: unknown[]) => unknown) => handlers.set(ch, cb),
  },
  app: { on: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}))

const IDENTITY = { extensionId: 'cate.kitchensink', workspaceId: 'ws-1' }
vi.mock('./ExtensionManager', () => ({
  extensionManager: {
    init: vi.fn(),
    refresh: vi.fn(async () => {}),
    getCatalogSources: () => [],
    refreshCatalog: vi.fn(async () => {}),
    isKnown: () => true,
    isEnabled: () => true,
    getManifest: () => ({ id: IDENTITY.extensionId, name: 'Kitchen Sink', panels: [] }),
  },
}))
vi.mock('./catalog', () => ({ getCachedCatalog: async () => [] }))
vi.mock('./proxyServer', () => ({
  getProxyUrlFor: vi.fn(),
  identityForGuestUrl: () => IDENTITY,
}))
vi.mock('./ExtensionServerManager', () => ({ extensionServerManager: { disposeForWebContents: vi.fn() } }))
vi.mock('../../agent/main/agentManager', () => ({ agentManager: {} }))
vi.mock('./storage', () => ({ getExtensionStorage: async () => ({ onChange: () => () => {} }) }))
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: vi.fn() }))
vi.mock('../windowRegistry', () => ({ getActiveMainWindow: () => undefined }))
vi.mock('../windowPanels', () => ({ getWindowPanels: () => [] }))
vi.mock('../../shared/runtimeLocator', () => ({ LOCAL_RUNTIME_ID: 'local', parseLocator: (r: string) => ({ runtimeId: 'local', path: r }) }))
vi.mock('../settingsFile', () => ({ getAllSettings: () => ({}), getSetting: () => true }))
vi.mock('../themeBootCache', () => ({ resolveActiveTheme: () => ({}) }))
vi.mock('../ipc/notifications', () => ({ showOsNotification: vi.fn() }))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { CATE_HOST_SUBSCRIBE, CATE_HOST_UNSUBSCRIBE } from '../../shared/ipc-channels'
import { registerExtensionHandlers } from './cateApiHandlers'

function makeWebContents(id: number): { id: number; destroyedListeners: number; getURL: () => string; once: (ev: string, cb: () => void) => void; send: () => void } {
  return {
    id,
    destroyedListeners: 0,
    getURL: () => 'http://127.0.0.1:5555/ext/token/index.html',
    once(ev: string, _cb: () => void) { if (ev === 'destroyed') this.destroyedListeners++ },
    send: vi.fn(),
  }
}

beforeEach(() => {
  handlers.clear()
  registerExtensionHandlers()
})

describe('CATE_HOST_SUBSCRIBE — destroyed hook dedup', () => {
  it('adds at most one destroyed listener across many subscribes on the same webContents', async () => {
    const subscribe = handlers.get(CATE_HOST_SUBSCRIBE)!
    const unsubscribe = handlers.get(CATE_HOST_UNSUBSCRIBE)!
    const wc = makeWebContents(42)
    const event = { sender: wc }
    const payload = { ...IDENTITY, panelId: 'panel-1', topic: 'storage.change' }

    for (let i = 0; i < 6; i++) {
      const res = await subscribe(event, payload)
      expect(res).toEqual({ ok: true })
      await unsubscribe(event, { panelId: 'panel-1', topic: 'storage.change' })
    }
    // One resubscribe with no intervening unsubscribe, to be thorough.
    await subscribe(event, payload)

    expect(wc.destroyedListeners).toBe(1)
  })
})
