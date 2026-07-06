// Coverage for WorkspaceCateApiManager: the cliEnabled gate (null when off),
// endpoint minting + caching when on, the first-party reverse session shape
// (caller + granted scopes), and the GRANTED_SCOPES contract. Uses a FAKE
// runtime (stubbed tunnel.*) and a stubbed createCateApiReverse so nothing real
// is opened.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReverseSession } from './cateApiReverse'

const settingsState = vi.hoisted(() => ({ cliEnabled: true as unknown }))
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

vi.mock('electron', () => ({}))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { resolve: () => fakeRuntime } }))
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: () => ({ rootPath: '/ws' }) }))
vi.mock('../settingsFile', () => ({ getSetting: (k: string) => (settingsState as Record<string, unknown>)[k] }))
vi.mock('./cateApiReverse', () => ({
  createCateApiReverse: (s: ReverseSession) => {
    reverseCalls.push(s)
    return { feedConnection: vi.fn(), dispose: reverseDispose }
  },
}))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { WorkspaceCateApiManager, GRANTED_SCOPES } from './workspaceCateApi'

beforeEach(() => {
  settingsState.cliEnabled = true
  reverseCalls.length = 0
  listen.mockClear()
  stopListen.mockClear()
  reverseDispose.mockClear()
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

  it('disposeForWorkspace tears down the listener + reverse endpoint', async () => {
    const mgr = new WorkspaceCateApiManager()
    await mgr.ensureEndpoint('ws1')
    mgr.disposeForWorkspace('ws1')
    expect(stopListen).toHaveBeenCalledWith('cateapi-terminal-ws1')
    expect(reverseDispose).toHaveBeenCalledTimes(1)
    // A subsequent ensure rebuilds a fresh endpoint.
    await mgr.ensureEndpoint('ws1')
    expect(listen).toHaveBeenCalledTimes(2)
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
})
