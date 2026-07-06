// =============================================================================
// Browser-control INTEGRATION test — proves the cross-layer chain works WITHOUT
// mocking the layer under test. Every existing unit test mocks its neighbor
// (cateApiReverse.test.ts mocks ./cateApiHandlers; cateApiHandlers.test.ts drives
// dispatch directly), so the contract BETWEEN the reverse HTTP responder and the
// real dispatch/forward core is unverified. This closes that:
//
//   raw HTTP POST → createCateApiReverse (real http parse off a tunnel Duplex)
//     → REAL dispatchCateInvoke (unmocked) → scope gate → resolveBrowserTargetWindow
//     → REAL forwardToOwner (sends CATE_HOST_FORWARD to a window's webContents)
//     → a SIMULATED renderer reply (CATE_HOST_FORWARD_REPLY through the fake ipcMain)
//     → the result flows back out as the HTTP 200 { result }.
//
// Only the leaf boundaries are faked (electron, window registry/panels, extension
// registry, storage, logger, agent) — mirroring cateApiHandlers.test.ts's mock set.
// The dispatch, forward round-trip, and HTTP framing are the REAL code.
//
// NOT covered here: a real webview / browser panel, the real runtime tunnel bytes
// (the runtime is a capture fake), and extension-server consent prompts (we drive
// the trusted first-party path). Those live in their own unit tests.
// =============================================================================

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { CATE_HOST_FORWARD, CATE_HOST_FORWARD_REPLY } from '../../shared/ipc-channels'

// --- electron: a fake ipcMain that records .on handlers so the test can drive
// the CATE_HOST_FORWARD_REPLY that the REAL forwardToOwner awaits. `handle`/`app`/
// `dialog` are inert — first-party callers never reach the consent dialog. --------
const { ipcMain, onHandlers } = vi.hoisted(() => {
  const onHandlers = new Map<string, Array<(...a: unknown[]) => void>>()
  return {
    onHandlers,
    ipcMain: {
      handle: (_channel: string, _handler: unknown) => {},
      on: (channel: string, handler: (...a: unknown[]) => void) => {
        const list = onHandlers.get(channel) ?? []
        list.push(handler)
        onHandlers.set(channel, list)
      },
    },
  }
})
vi.mock('electron', () => ({
  ipcMain,
  app: { on: vi.fn() },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
}))

// --- window registry + panel union: the FAKE windows the forward targets. --------
const { activeWindow, windowsById, windowPanelList } = vi.hoisted(() => ({
  activeWindow: { value: undefined as unknown },
  windowsById: new Map<number, unknown>(),
  windowPanelList: { value: [] as Array<{ panelId: string; type: string; ownerWindowId: number }> },
}))
vi.mock('../windowRegistry', () => ({
  getActiveMainWindow: () => activeWindow.value,
  getWindow: (id: number) => windowsById.get(id),
}))
vi.mock('../windowPanels', () => ({ getWindowPanels: () => windowPanelList.value }))

// --- remaining leaf boundaries cateApiHandlers imports (mirror its own test). -----
vi.mock('./ExtensionManager', () => ({
  extensionManager: {
    // First-party callers skip the enabled gate, but registerExtensionHandlers
    // still calls these at startup, so keep them inert.
    isKnown: () => true,
    isEnabled: () => true,
    getManifest: () => undefined,
    init: vi.fn(),
    refresh: vi.fn(async () => {}),
    getCatalogSources: () => [],
    refreshCatalog: vi.fn(async () => {}),
  },
}))
vi.mock('./catalog', () => ({ getCachedCatalog: vi.fn(async () => []) }))
vi.mock('./proxyServer', () => ({ getProxyUrlFor: vi.fn(), identityForGuestUrl: vi.fn() }))
vi.mock('./ExtensionServerManager', () => ({ extensionServerManager: {} }))
vi.mock('../../agent/main/agentManager', () => ({ agentManager: {} }))
vi.mock('./storage', () => ({ getExtensionStorage: vi.fn() }))
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: vi.fn(() => ({ rootPath: '/ws/root' })) }))
vi.mock('../runtime/locator', () => ({
  LOCAL_RUNTIME_ID: 'local',
  parseLocator: (raw: string) => ({ runtimeId: 'local', path: raw }),
}))
vi.mock('../settingsFile', () => ({ getAllSettings: () => ({}), getSetting: () => true }))
vi.mock('../themeBootCache', () => ({ resolveActiveTheme: () => ({ id: 'x', type: 'dark', app: {}, terminal: {} }) }))
vi.mock('../ipc/notifications', () => ({ showOsNotification: vi.fn() }))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// REAL modules under test — no mock of ./cateApiHandlers.
import { createCateApiReverse } from './cateApiReverse'
import { registerExtensionHandlers } from './cateApiHandlers'
import type { Runtime } from '../runtime/types'

const TOKEN = 'secret-bearer-token'
const WS = 'ws-1'

// A fake runtime whose tunnel.write captures the endpoint's HTTP response bytes.
function makeRuntime(): { runtime: Runtime; output: () => Buffer } {
  const chunks: Buffer[] = []
  const runtime = {
    tunnel: {
      write: (_id: string, b64: string) => { chunks.push(Buffer.from(b64, 'base64')) },
      close: vi.fn(),
      ack: vi.fn(),
    },
  } as unknown as Runtime
  return { runtime, output: () => Buffer.concat(chunks) }
}

interface CapturedForward {
  requestId: string
  workspaceId: string
  panelId: string
  extensionId: string
  method: string
  args: unknown
}

// A FAKE window standing in for a renderer. When its webContents.send receives a
// CATE_HOST_FORWARD, it captures the payload and (unless told to stay silent)
// drives the reply back through the SAME channel the real forwardToOwner listens
// on — ipcMain.on(CATE_HOST_FORWARD_REPLY) — making the round-trip real.
function makeWindow(opts: { replyResult?: unknown; reply?: boolean } = {}) {
  const forwards: CapturedForward[] = []
  const send = vi.fn((channel: string, payload: CapturedForward) => {
    if (channel !== CATE_HOST_FORWARD) return
    forwards.push(payload)
    if (opts.reply === false) return
    // Simulate an async renderer reply.
    queueMicrotask(() => {
      for (const h of onHandlers.get(CATE_HOST_FORWARD_REPLY) ?? []) {
        h({}, { requestId: payload.requestId, ok: true, result: opts.replyResult ?? { ok: true } })
      }
    })
  })
  return { win: { isDestroyed: () => false, webContents: { send } }, send, forwards }
}

interface HttpReply { status: number; body: unknown }

/** Feed a raw HTTP request into the endpoint and resolve with the parsed reply.
 *  Uses the response Content-Length to know the full reply has arrived. */
function request(
  endpoint: ReturnType<typeof createCateApiReverse>,
  output: () => Buffer,
  opts: { token?: string | null; json?: unknown; connId?: string },
): Promise<HttpReply> {
  const body = opts.json === undefined ? '' : JSON.stringify(opts.json)
  const headers = [
    'POST / HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
  ]
  if (opts.token !== null) headers.push(`Authorization: Bearer ${opts.token ?? TOKEN}`)
  const raw = headers.join('\r\n') + '\r\n\r\n' + body

  const duplex = endpoint.feedConnection(opts.connId ?? 'rev-conn-1')
  duplex.push(Buffer.from(raw, 'utf8'))

  return new Promise<HttpReply>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('endpoint did not reply')), 2000)
    const poll = setInterval(() => {
      const text = output().toString('utf8')
      const sep = text.indexOf('\r\n\r\n')
      if (sep === -1) return
      const head = text.slice(0, sep)
      const rest = text.slice(sep + 4)
      const lenMatch = /content-length:\s*(\d+)/i.exec(head)
      if (!lenMatch) return
      if (Buffer.byteLength(rest) < Number(lenMatch[1])) return
      clearInterval(poll)
      clearTimeout(deadline)
      const status = Number(/HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0)
      let parsed: unknown = null
      try { parsed = rest ? JSON.parse(rest) : null } catch { parsed = rest }
      resolve({ status, body: parsed })
    }, 2)
  })
}

/** Build a first-party reverse session with the given granted scopes. */
function firstPartySession(runtime: Runtime, grantedScopes: string[]) {
  return createCateApiReverse({
    extensionId: 'first-party',
    workspaceId: WS,
    token: TOKEN,
    runtime,
    caller: 'first-party',
    grantedScopes,
  })
}

// Wire the REAL ipcMain.on(CATE_HOST_FORWARD_REPLY) resolver once — it's the sole
// path that completes a pending forward.
beforeAll(() => {
  registerExtensionHandlers()
})

beforeEach(() => {
  activeWindow.value = undefined
  windowsById.clear()
  windowPanelList.value = []
})

describe('browser-control integration — HTTP → real dispatch → forward → renderer reply', () => {
  it('happy path: cate.browser.open reaches the owner renderer and the reply flows back as HTTP 200', async () => {
    // A browser panel 'b1' owned by the same fake window that is active.
    const owner = makeWindow({ replyResult: { ok: true, navigated: 'https://x.test' } })
    activeWindow.value = owner.win
    windowsById.set(100, owner.win)
    windowPanelList.value = [{ panelId: 'b1', type: 'browser', ownerWindowId: 100 }]

    const { runtime, output } = makeRuntime()
    const endpoint = firstPartySession(runtime, ['browser'])
    const res = await request(endpoint, output, {
      json: { method: 'cate.browser.open', args: { url: 'https://x.test', panelId: 'b1' } },
    })

    // The renderer received exactly the documented CATE_HOST_FORWARD payload.
    expect(owner.forwards).toHaveLength(1)
    const fwd = owner.forwards[0]!
    expect(fwd.method).toBe('cate.browser.open') // keeps the cate. prefix
    expect((fwd.args as { panelId?: string }).panelId).toBe('b1') // addressed panel in args
    expect(fwd.panelId).toBe('') // caller origin (server has no owning panel)
    expect(fwd.workspaceId).toBe(WS)
    expect(typeof fwd.requestId).toBe('string')

    // The simulated reply's result is what the HTTP caller sees.
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ result: { ok: true, navigated: 'https://x.test' } })
    endpoint.dispose()
  })

  it('owner-window routing: an addressed panel routes the forward to ITS window, not the active one', async () => {
    const active = makeWindow() // a DIFFERENT window that must NOT receive the forward
    const target = makeWindow({ replyResult: { ok: true } })
    activeWindow.value = active.win
    windowsById.set(1, active.win)
    windowsById.set(2, target.win)
    windowPanelList.value = [{ panelId: 'b2', type: 'browser', ownerWindowId: 2 }]

    const { runtime, output } = makeRuntime()
    const endpoint = firstPartySession(runtime, ['browser'])
    const res = await request(endpoint, output, {
      json: { method: 'cate.browser.back', args: { panelId: 'b2' } },
    })

    expect(target.send).toHaveBeenCalledTimes(1)
    expect(active.send).not.toHaveBeenCalled()
    expect(target.forwards[0]!.method).toBe('cate.browser.back')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ result: { ok: true } })
    endpoint.dispose()
  })

  it('no-such-browser: an unknown or non-browser panelId errors without forwarding', async () => {
    const active = makeWindow()
    activeWindow.value = active.win
    windowsById.set(1, active.win)
    // Only a TERMINAL panel with this id exists — not a browser.
    windowPanelList.value = [{ panelId: 'term1', type: 'terminal', ownerWindowId: 1 }]

    const { runtime, output } = makeRuntime()

    // Unknown panelId.
    const ep1 = firstPartySession(runtime, ['browser'])
    const unknown = await request(ep1, output, {
      json: { method: 'cate.browser.open', args: { url: 'https://x.test', panelId: 'nope' } },
      connId: 'rev-a',
    })
    expect(unknown.status).toBe(200)
    expect(unknown.body).toEqual({ result: { error: 'no-such-browser', method: 'cate.browser.open' } })
    ep1.dispose()

    // A real panel id that is NOT a browser → same error.
    const two = makeRuntime()
    const ep2 = firstPartySession(two.runtime, ['browser'])
    const nonBrowser = await request(ep2, two.output, {
      json: { method: 'cate.browser.open', args: { panelId: 'term1' } },
      connId: 'rev-b',
    })
    expect(nonBrowser.body).toEqual({ result: { error: 'no-such-browser', method: 'cate.browser.open' } })
    ep2.dispose()

    expect(active.send).not.toHaveBeenCalled()
  })

  it('scope denied: a session without the browser scope is rejected before any forward', async () => {
    const owner = makeWindow()
    activeWindow.value = owner.win
    windowsById.set(100, owner.win)
    windowPanelList.value = [{ panelId: 'b1', type: 'browser', ownerWindowId: 100 }]

    const { runtime, output } = makeRuntime()
    const endpoint = firstPartySession(runtime, ['storage']) // no 'browser'
    const res = await request(endpoint, output, {
      json: { method: 'cate.browser.open', args: { url: 'https://x.test', panelId: 'b1' } },
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ result: { error: 'scope-denied', method: 'cate.browser.open' } })
    expect(owner.send).not.toHaveBeenCalled()
    endpoint.dispose()
  })

  it('auth: an absent bearer token is rejected 401 before any dispatch/forward', async () => {
    const owner = makeWindow()
    activeWindow.value = owner.win
    windowsById.set(100, owner.win)
    windowPanelList.value = [{ panelId: 'b1', type: 'browser', ownerWindowId: 100 }]

    const { runtime, output } = makeRuntime()
    const endpoint = firstPartySession(runtime, ['browser'])
    const res = await request(endpoint, output, {
      token: null,
      json: { method: 'cate.browser.open', args: { url: 'https://x.test', panelId: 'b1' } },
    })

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
    expect(owner.send).not.toHaveBeenCalled()
    endpoint.dispose()
  })

  it('auth: a wrong bearer token is rejected 401 before any dispatch/forward', async () => {
    const owner = makeWindow()
    activeWindow.value = owner.win
    windowsById.set(100, owner.win)
    windowPanelList.value = [{ panelId: 'b1', type: 'browser', ownerWindowId: 100 }]

    const { runtime, output } = makeRuntime()
    const endpoint = firstPartySession(runtime, ['browser'])
    const res = await request(endpoint, output, {
      token: 'wrong-token',
      json: { method: 'cate.browser.open', args: { url: 'https://x.test', panelId: 'b1' } },
    })

    expect(res.status).toBe(401)
    expect(owner.send).not.toHaveBeenCalled()
    endpoint.dispose()
  })
})
