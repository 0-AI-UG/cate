// =============================================================================
// CATE_API reverse endpoint (server -> Cate) — the channel the Kitchen Sink's
// POST /api/cate-roundtrip drives: the extension SERVER calls back into Cate
// over a loopback the daemon tunnels into this endpoint. This is a real http
// server parsing real HTTP bytes off a reverse-tunnel Duplex; only the dispatch
// core + runtime tunnel are faked (the dispatch contract has its own test in
// cateApiHandlers.test.ts). We assert: bearer auth, JSON parsing, the storage
// set+get round-trip the Kitchen Sink performs, and the malformed-input guards.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Dispatch core: an in-memory storage impl so the set->get round-trip is real.
const store = vi.hoisted(() => new Map<string, unknown>())
const dispatchCateInvoke = vi.hoisted(() => vi.fn())
const forwardToOwner = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
const authorizeCateInvoke = vi.hoisted(() => vi.fn((): unknown => null))
const windowPanels = vi.hoisted(() => [] as Array<{
  panelId: string
  type: string
  workspaceId: string
}>)
vi.mock('./cateApiHandlers', () => ({
  authorizeCateInvoke,
  dispatchCateInvoke,
  forwardToActiveWindow: vi.fn(async () => ({ error: 'no-host-window' })),
  forwardToOwner,
}))
vi.mock('../windowPanels', () => ({
  getWindowPanels: () => windowPanels,
}))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { createCateApiReverse } from './cateApiReverse'
import { unwrap, ApiError } from '../../cli/cate'
import type { Runtime } from '../runtime/types'

const TOKEN = 'secret-bearer-token'
const CONN = 'rev-conn-1'

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

interface HttpReply {
  status: number
  body: unknown
}

/** Feed a raw HTTP request into the endpoint and resolve with the parsed reply.
 *  Uses Content-Length on the response to know when the full reply has arrived. */
function request(
  endpoint: ReturnType<typeof createCateApiReverse>,
  output: () => Buffer,
  opts: { method?: string; path?: string; token?: string | null; json?: unknown },
): Promise<HttpReply> {
  const body = opts.json === undefined ? '' : JSON.stringify(opts.json)
  const headers = [
    `${opts.method ?? 'POST'} ${opts.path ?? '/'} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
  ]
  if (opts.token !== null) headers.push(`Authorization: Bearer ${opts.token ?? TOKEN}`)
  const raw = headers.join('\r\n') + '\r\n\r\n' + body

  const duplex = endpoint.feedConnection(CONN)
  duplex.push(Buffer.from(raw, 'utf8'))

  return new Promise<HttpReply>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('endpoint did not reply')), 1000)
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

beforeEach(() => {
  store.clear()
  windowPanels.length = 0
  dispatchCateInvoke.mockReset()
  authorizeCateInvoke.mockReset()
  authorizeCateInvoke.mockReturnValue(null)
  // Mirror the real dispatch for the two storage methods the round-trip uses.
  dispatchCateInvoke.mockImplementation(async (_scope, method: string, args: { key?: string; value?: unknown }) => {
    if (method === 'cate.storage.set') { store.set(String(args.key), args.value); return { ok: true } }
    if (method === 'cate.storage.get') return store.get(String(args.key))
    return { error: 'unsupported', method }
  })
})

describe('createCateApiReverse — server-side CATE_API endpoint', () => {
  it('binds Cate Agent forwarding to its owning renderer', async () => {
    const host = makeRuntime()
    const owner = { isDestroyed: () => false } as never
    const endpoint = createCateApiReverse({
      extensionId: 'cate-agent',
      workspaceId: 'ws-1',
      token: TOKEN,
      runtime: host.runtime,
      caller: 'cate-agent',
      ownerWebContents: owner,
    })
    await request(endpoint, host.output, {
      json: { method: 'cate.codingAgent.create', args: { prompt: 'Implement it' } },
    })

    const scope = dispatchCateInvoke.mock.calls[0][0]
    const payload = {
      extensionId: 'cate-agent',
      workspaceId: 'ws-1',
      panelId: '',
      method: 'cate.codingAgent.create',
      args: {},
    }
    await scope.forward(payload)
    expect(forwardToOwner).toHaveBeenCalledWith(owner, payload)
    endpoint.dispose()
  })

  it('round-trips storage.set then storage.get (the Kitchen Sink roundtrip)', async () => {
    // Two requests = two connections (HTTP/1.1 Connection: close). Each endpoint
    // gets its own runtime/output, but both dispatch into the shared store, so
    // the second read sees what the first write persisted.
    const set = makeRuntime()
    const setEp = createCateApiReverse({ extensionId: 'cate.kitchensink', workspaceId: 'ws-1', token: TOKEN, runtime: set.runtime })
    const setRes = await request(setEp, set.output, { json: { method: 'cate.storage.set', args: { key: 'kitchensink:roundtrip', value: 'stamp-42' } } })
    expect(setRes.status).toBe(200)
    expect(setRes.body).toEqual({ result: { ok: true } })
    setEp.dispose()

    const get = makeRuntime()
    const getEp = createCateApiReverse({ extensionId: 'cate.kitchensink', workspaceId: 'ws-1', token: TOKEN, runtime: get.runtime })
    const getRes = await request(getEp, get.output, { json: { method: 'cate.storage.get', args: { key: 'kitchensink:roundtrip' } } })
    expect(getRes.status).toBe(200)
    expect(getRes.body).toEqual({ result: 'stamp-42' })
    getEp.dispose()
  })

  it('rejects a request with no bearer token (401, no dispatch)', async () => {
    const { runtime, output } = makeRuntime()
    const endpoint = createCateApiReverse({ extensionId: 'cate.kitchensink', workspaceId: 'ws-1', token: TOKEN, runtime })

    const res = await request(endpoint, output, { token: null, json: { method: 'cate.storage.get', args: { key: 'x' } } })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
    expect(dispatchCateInvoke).not.toHaveBeenCalled()
    endpoint.dispose()
  })

  it('rejects a wrong bearer token (401)', async () => {
    const { runtime, output } = makeRuntime()
    const endpoint = createCateApiReverse({ extensionId: 'cate.kitchensink', workspaceId: 'ws-1', token: TOKEN, runtime })

    const res = await request(endpoint, output, { token: 'wrong', json: { method: 'cate.storage.get', args: {} } })
    expect(res.status).toBe(401)
    expect(dispatchCateInvoke).not.toHaveBeenCalled()
    endpoint.dispose()
  })

  it('400s a body that is not valid JSON', async () => {
    const { runtime, output } = makeRuntime()
    const endpoint = createCateApiReverse({ extensionId: 'cate.kitchensink', workspaceId: 'ws-1', token: TOKEN, runtime })

    // Hand-roll a request with a non-JSON body but a correct Content-Length.
    const body = 'not json{'
    const raw = [
      'POST / HTTP/1.1',
      'Host: 127.0.0.1',
      'Connection: close',
      `Authorization: Bearer ${TOKEN}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      '', body,
    ].join('\r\n')
    const duplex = endpoint.feedConnection('rev-bad-json')
    duplex.push(Buffer.from(raw, 'utf8'))

    const res = await new Promise<HttpReply>((resolve) => {
      const poll = setInterval(() => {
        const text = output().toString('utf8')
        if (!text.includes('\r\n\r\n')) return
        clearInterval(poll)
        const status = Number(/HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0)
        const bodyText = text.slice(text.indexOf('\r\n\r\n') + 4)
        resolve({ status, body: JSON.parse(bodyText) })
      }, 2)
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'bad-json' })
    endpoint.dispose()
  })

  it('threads first-party caller + grantedScopes into the dispatch scope', async () => {
    const { runtime, output } = makeRuntime()
    const endpoint = createCateApiReverse({
      extensionId: 'first-party', workspaceId: 'ws-1', token: TOKEN, runtime,
      caller: 'first-party', grantedScopes: ['browser'],
    })
    await request(endpoint, output, { json: { method: 'cate.storage.get', args: { key: 'x' } } })
    expect(dispatchCateInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ caller: 'first-party', grantedScopes: ['browser'] }),
      'cate.storage.get',
      { key: 'x' },
    )
    endpoint.dispose()
  })

  it('leaves caller/grantedScopes undefined for an extension-server session', async () => {
    const { runtime, output } = makeRuntime()
    const endpoint = createCateApiReverse({ extensionId: 'cate.kitchensink', workspaceId: 'ws-1', token: TOKEN, runtime })
    await request(endpoint, output, { json: { method: 'cate.storage.get', args: { key: 'x' } } })
    expect(dispatchCateInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ caller: undefined, grantedScopes: undefined }),
      'cate.storage.get',
      { key: 'x' },
    )
    endpoint.dispose()
  })

  it('serializes a void (undefined) result so the CLI reads it as success', async () => {
    // Void-result host methods (cate browser back/click/type, cate panel set-title)
    // resolve `undefined`. The wire body must still carry a `result` key, otherwise
    // the CLI's unwrap sees neither `result` nor `error` and throws 'malformed
    // response' on a request that actually succeeded.
    dispatchCateInvoke.mockResolvedValue(undefined)
    const { runtime, output } = makeRuntime()
    const endpoint = createCateApiReverse({ extensionId: 'first-party', workspaceId: 'ws-1', token: TOKEN, runtime, caller: 'first-party', grantedScopes: ['panel'] })

    const res = await request(endpoint, output, { json: { method: 'cate.panel.setTitle', args: { title: 'x' } } })
    expect(res.status).toBe(200)
    // (a) The body is valid and carries the result key.
    expect(res.body).toEqual({ result: null })
    // (b) The CLI's unwrap treats it as SUCCESS (no throw), not 'malformed response'.
    let unwrapped: unknown
    expect(() => { unwrapped = unwrap('cate.panel.setTitle', res.status, res.body) }).not.toThrow(ApiError)
    expect(unwrapped).toBeNull()
    endpoint.dispose()
  })

  it('drops a stale selected panel instead of poisoning later browser calls', async () => {
    windowPanels.push({ panelId: 'browser-1', type: 'browser', workspaceId: 'ws-1' })
    const first = makeRuntime()
    const endpoint = createCateApiReverse({
      extensionId: 'first-party',
      workspaceId: 'ws-1',
      token: TOKEN,
      runtime: first.runtime,
      caller: 'first-party',
      grantedScopes: ['browser', 'panel'],
    })

    const selected = await request(endpoint, first.output, {
      json: {
        method: 'cate.panel.target.set',
        args: { panelId: 'browser-1' },
        clientId: 'cli-session',
      },
    })
    expect(selected.body).toEqual({
      result: { panelId: 'browser-1', type: 'browser' },
    })

    windowPanels.length = 0
    dispatchCateInvoke.mockResolvedValue({ snapshot: '- document' })
    const second = makeRuntime()
    const secondEndpoint = createCateApiReverse({
      extensionId: 'first-party',
      workspaceId: 'ws-1',
      token: TOKEN,
      runtime: second.runtime,
      caller: 'first-party',
      grantedScopes: ['browser', 'panel'],
    })
    const snapshot = await request(secondEndpoint, second.output, {
      json: {
        method: 'cate.browser.snapshot',
        args: {},
        clientId: 'cli-session',
      },
    })

    expect(snapshot.body).toEqual({ result: { snapshot: '- document' } })
    expect(dispatchCateInvoke).toHaveBeenLastCalledWith(
      expect.any(Object),
      'cate.browser.snapshot',
      {},
    )
    endpoint.dispose()
    secondEndpoint.dispose()
  })

  it('checks panel-target authorization before reading or changing the target', async () => {
    windowPanels.push({ panelId: 'browser-1', type: 'browser', workspaceId: 'ws-1' })
    authorizeCateInvoke.mockReturnValueOnce({
      error: 'Panels Read access is disabled in Settings → CLI.',
      method: 'cate.panel.target.set',
    })
    const first = makeRuntime()
    const endpoint = createCateApiReverse({
      extensionId: 'first-party',
      workspaceId: 'ws-1',
      token: TOKEN,
      runtime: first.runtime,
      caller: 'first-party',
      grantedScopes: ['panel'],
    })

    const denied = await request(endpoint, first.output, {
      json: {
        method: 'cate.panel.target.set',
        args: { panelId: 'browser-1' },
        clientId: 'cli-session',
      },
    })
    expect(denied.body).toEqual({
      result: {
        error: 'Panels Read access is disabled in Settings → CLI.',
        method: 'cate.panel.target.set',
      },
    })

    const second = makeRuntime()
    const secondEndpoint = createCateApiReverse({
      extensionId: 'first-party',
      workspaceId: 'ws-1',
      token: TOKEN,
      runtime: second.runtime,
      caller: 'first-party',
      grantedScopes: ['panel'],
    })
    const current = await request(secondEndpoint, second.output, {
      json: { method: 'cate.panel.target.current', args: {}, clientId: 'cli-session' },
    })
    expect(current.body).toEqual({ result: { panelId: null } })
    expect(authorizeCateInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ caller: 'first-party', grantedScopes: ['panel'] }),
      'cate.panel.target.set',
      { panelId: 'browser-1' },
    )
    endpoint.dispose()
    secondEndpoint.dispose()
  })

  it('400s when no method is supplied', async () => {
    const { runtime, output } = makeRuntime()
    const endpoint = createCateApiReverse({ extensionId: 'cate.kitchensink', workspaceId: 'ws-1', token: TOKEN, runtime })

    const res = await request(endpoint, output, { json: { args: { key: 'x' } } })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'no-method' })
    endpoint.dispose()
  })
})
