// Coverage for WorkspaceCateApiManager: the cliEnabled gate (null when off),
// endpoint minting + caching when on, the first-party reverse session shape
// (caller + granted scopes), and the GRANTED_SCOPES contract. Uses a FAKE
// runtime (stubbed tunnel.*) and a stubbed createCateApiReverse so nothing real
// is opened.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReverseSession } from './cateApiReverse'

const settingsState = vi.hoisted(() => ({ cliEnabled: true as unknown }))
const resolve = vi.hoisted(() => vi.fn())
const listen = vi.fn(async (_name: string) => ({ port: 54321 }))
const stopListen = vi.fn()
const ack = vi.fn()

const fakeRuntime = {
  id: 'local',
  tunnel: { listen, stopListen, ack, open: vi.fn(), write: vi.fn(), close: vi.fn() },
}

// Capture the session createCateApiReverse is called with, to assert its shape.
const reverseCalls: ReverseSession[] = []
const reverseDispose = vi.fn()
// feedConnection returns a fake per-conn duplex whose push() we can observe, so
// the tunnel connection callbacks (onData push+ack, onClose push(null)) can be
// driven and asserted.
const feedConnection = vi.fn((_connId: string) => ({ push: vi.fn() }))

vi.mock('electron', () => ({}))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { resolve } }))
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: () => ({ rootPath: '/ws' }) }))
vi.mock('../settingsFile', () => ({ getSetting: (k: string) => (settingsState as Record<string, unknown>)[k] }))
// Stub only createCateApiReverse (so nothing real is opened); keep the REAL
// bindReverseTunnel so its tunnel wiring (the onConnection/onData/onClose trio
// asserted below) actually runs against the fake runtime.
vi.mock('./cateApiReverse', async (importActual) => ({
  ...(await importActual<typeof import('./cateApiReverse')>()),
  createCateApiReverse: (s: ReverseSession) => {
    reverseCalls.push(s)
    return { feedConnection, dispose: reverseDispose }
  },
}))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { WorkspaceCateApiManager, GRANTED_SCOPES } from './workspaceCateApi'

beforeEach(() => {
  settingsState.cliEnabled = true
  resolve.mockReset()
  resolve.mockReturnValue(fakeRuntime)
  reverseCalls.length = 0
  listen.mockClear()
  stopListen.mockClear()
  reverseDispose.mockClear()
  feedConnection.mockClear()
  ack.mockClear()
})

describe('GRANTED_SCOPES contract', () => {
  it('includes browser and excludes storage + agent', () => {
    expect(GRANTED_SCOPES).toContain('browser')
    expect(GRANTED_SCOPES).not.toContain('storage')
    expect(GRANTED_SCOPES).not.toContain('agent')
    expect([...GRANTED_SCOPES]).toEqual(['browser', 'workspace.read', 'theme', 'ui', 'editor', 'canvas', 'panel'])
  })
})

describe('WorkspaceCateApiManager.ensureEndpoint', () => {
  it('returns null and opens NO listener when cliEnabled is disabled (the gate)', async () => {
    settingsState.cliEnabled = false
    const mgr = new WorkspaceCateApiManager()
    const ep = await mgr.ensureEndpoint('ws1')
    expect(ep).toBeNull()
    expect(listen).not.toHaveBeenCalled()
    expect(reverseCalls).toHaveLength(0)
  })

  it('fails closed on a non-boolean-true cliEnabled value', async () => {
    settingsState.cliEnabled = undefined
    const mgr = new WorkspaceCateApiManager()
    expect(await mgr.ensureEndpoint('ws1')).toBeNull()
    expect(listen).not.toHaveBeenCalled()
  })

  it('mints a first-party endpoint with the granted browser scope when enabled', async () => {
    const mgr = new WorkspaceCateApiManager()
    const ep = await mgr.ensureEndpoint('ws1')
    expect(ep).toEqual({ port: 54321, token: expect.any(String) })
    expect(ep!.token.length).toBeGreaterThan(20)
    expect(listen).toHaveBeenCalledTimes(1)
    expect(listen.mock.calls[0][0]).toBe('cateapi-terminal-ws1')

    // First-party reverse session: caller + granted scopes (not a manifest).
    expect(reverseCalls).toHaveLength(1)
    const session = reverseCalls[0]
    expect(session.caller).toBe('first-party')
    expect(session.grantedScopes).toContain('browser')
    expect(session.grantedScopes).not.toContain('storage')
    expect(session.grantedScopes).not.toContain('agent')
    expect(session.token).toBe(ep!.token)
    expect(session.workspaceId).toBe('ws1')
  })

  it('caches the endpoint per workspace (no second listener)', async () => {
    const mgr = new WorkspaceCateApiManager()
    const a = await mgr.ensureEndpoint('ws1')
    const b = await mgr.ensureEndpoint('ws1')
    expect(b).toEqual(a)
    expect(listen).toHaveBeenCalledTimes(1)
    expect(reverseCalls).toHaveLength(1)
  })

  it('disposeForRuntime drops endpoints on the disconnected runtime', async () => {
    const mgr = new WorkspaceCateApiManager()
    await mgr.ensureEndpoint('ws1')
    mgr.disposeForRuntime('local')
    expect(stopListen).toHaveBeenCalledWith('cateapi-terminal-ws1')
    await mgr.ensureEndpoint('ws1')
    expect(listen).toHaveBeenCalledTimes(2)
  })

  it('returns null (fail-soft) when the listener fails to open', async () => {
    listen.mockRejectedValueOnce(new Error('no daemon'))
    const mgr = new WorkspaceCateApiManager()
    const ep = await mgr.ensureEndpoint('ws1')
    expect(ep).toBeNull()
    expect(reverseDispose).toHaveBeenCalledTimes(1)
  })

  it('returns null (fail-soft) when the runtime is not registered (resolve throws)', async () => {
    // A runtime disconnect/reconnect window: runtimes.resolve throws for the
    // unresolved id. ensureEndpoint must still resolve to null so the terminal/
    // agent spawns without CATE_API, not reject and abort the spawn.
    resolve.mockImplementation(() => { throw new Error('No runtime registered for id "local"') })
    const mgr = new WorkspaceCateApiManager()
    const ep = await mgr.ensureEndpoint('ws1')
    expect(ep).toBeNull()
    expect(listen).not.toHaveBeenCalled()
    expect(reverseCalls).toHaveLength(0)
  })

  it('serializes two concurrent calls for the same workspace (no double-listen)', async () => {
    // Hold the first listen open so BOTH ensureEndpoint calls are in flight
    // before either completes — without withLock this would double-listen.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    listen.mockImplementationOnce(async () => { await gate; return { port: 54321 } })

    const mgr = new WorkspaceCateApiManager()
    const p1 = mgr.ensureEndpoint('ws1')
    const p2 = mgr.ensureEndpoint('ws1')
    release()
    const [a, b] = await Promise.all([p1, p2])

    expect(a).toEqual({ port: 54321, token: expect.any(String) })
    expect(b).toEqual(a) // both callers share the one endpoint
    expect(listen).toHaveBeenCalledTimes(1)
    expect(reverseCalls).toHaveLength(1)
  })

  it('disposeAll tears down every workspace endpoint', async () => {
    const mgr = new WorkspaceCateApiManager()
    await mgr.ensureEndpoint('ws1')
    await mgr.ensureEndpoint('ws2')
    expect(listen).toHaveBeenCalledTimes(2)

    mgr.disposeAll()
    expect(stopListen).toHaveBeenCalledWith('cateapi-terminal-ws1')
    expect(stopListen).toHaveBeenCalledWith('cateapi-terminal-ws2')
    expect(stopListen).toHaveBeenCalledTimes(2)
    expect(reverseDispose).toHaveBeenCalledTimes(2)

    // Every endpoint is gone: a subsequent ensure rebuilds from scratch.
    await mgr.ensureEndpoint('ws1')
    expect(listen).toHaveBeenCalledTimes(3)
  })
})

describe('WorkspaceCateApiManager tunnel connection callbacks', () => {
  // Pull the (onConnection, onData, onClose) trio the manager wired into
  // runtime.tunnel.listen for the freshly-minted endpoint.
  async function wire() {
    const mgr = new WorkspaceCateApiManager()
    await mgr.ensureEndpoint('ws1')
    const [, onConnection, onData, onClose] = listen.mock.calls[0] as unknown as [
      string,
      (connId: string) => void,
      (connId: string, b64: string) => void,
      (connId: string) => void,
    ]
    return { mgr, onConnection, onData, onClose }
  }

  it('onData pushes the decoded bytes into the conn duplex and credits the ack window', async () => {
    const { onConnection, onData } = await wire()
    onConnection('c1')
    const duplex = feedConnection.mock.results[0].value as { push: ReturnType<typeof vi.fn> }

    const payload = Buffer.from('hello world')
    onData('c1', payload.toString('base64'))

    expect(duplex.push).toHaveBeenCalledWith(payload)
    // ack is credited with the DECODED byte length (mirror of ExtensionServerManager).
    expect(ack).toHaveBeenCalledWith('c1', payload.length)
  })

  it('onData for an unknown conn is a no-op (no push, no ack)', async () => {
    const { onData } = await wire()
    onData('ghost', Buffer.from('x').toString('base64'))
    expect(ack).not.toHaveBeenCalled()
  })

  it('onClose pushes null (EOF) into the conn duplex', async () => {
    const { onConnection, onClose } = await wire()
    onConnection('c1')
    const duplex = feedConnection.mock.results[0].value as { push: ReturnType<typeof vi.fn> }

    onClose('c1')
    expect(duplex.push).toHaveBeenCalledWith(null)
  })

  it('onClose forgets the conn: a later onData for it is a no-op', async () => {
    const { onConnection, onData, onClose } = await wire()
    onConnection('c1')
    onClose('c1')
    onData('c1', Buffer.from('late').toString('base64'))
    // Only the close-time push(null) ran; the post-close data was dropped, so no ack.
    expect(ack).not.toHaveBeenCalled()
  })

  it('onClose for an unknown conn does not throw', async () => {
    const { onClose } = await wire()
    expect(() => onClose('ghost')).not.toThrow()
  })
})
