// =============================================================================
// proxyServer.getProxyUrlFor — url-mode extensions resolve to the remote page
// directly: no proxy server started, no route token, and NO cateHost preload
// (a remote origin can never satisfy identityForGuestUrl, so it gets no host
// API). A manifest that declares both server and url still takes the server
// path — precedence is server > url > frontend.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ExtensionManifest } from '../../shared/extensions'

const state = vi.hoisted(() => ({
  manifest: null as ExtensionManifest | null,
  createServerCalls: 0,
}))

vi.mock('http', () => {
  const createServer = vi.fn(() => {
    state.createServerCalls++
    const handlers: Record<string, (arg?: unknown) => void> = {}
    const fake = {
      on(ev: string, cb: (arg?: unknown) => void) { handlers[ev] = cb; return fake },
      listen(_port: number, _host: string, cb: () => void) { queueMicrotask(() => cb()) },
      address() { return { port: 4321 } },
    }
    return fake
  })
  return { default: { createServer } }
})

vi.mock('./ExtensionManager', () => ({
  extensionManager: {
    isKnown: () => true,
    isEnabled: () => true,
    getManifest: () => state.manifest,
  },
}))
const joinPanel = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('./ExtensionServerManager', () => ({ extensionServerManager: { joinPanel } }))
vi.mock('./serverTunnel', () => ({ openTunnelDuplex: vi.fn() }))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('electron', () => ({}))
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: vi.fn() }))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { resolve: vi.fn() } }))

import { getProxyUrlFor } from './proxyServer'

const ARGS = { extensionId: 'cate.discord', workspaceId: 'ws1', panelId: 'p1' }

function base(extra: Partial<ExtensionManifest>): ExtensionManifest {
  return { id: 'cate.discord', name: 'Discord', panels: [{ id: 'main', label: 'Discord' }], ...extra }
}

describe('getProxyUrlFor — url mode', () => {
  beforeEach(() => { state.createServerCalls = 0; joinPanel.mockClear() })

  it('returns the remote url with no preload and starts no proxy', async () => {
    state.manifest = base({ url: 'https://discord.com/app' })
    const res = await getProxyUrlFor(ARGS)
    expect(res).toEqual({ url: 'https://discord.com/app', preloadPath: '' })
    expect(state.createServerCalls).toBe(0)
  })

  it('prefers server over url when a manifest declares both', async () => {
    state.manifest = base({ url: 'https://discord.com/app', server: { command: 'node s.js' } })
    const res = await getProxyUrlFor({ ...ARGS, sender: {} as Electron.WebContents })
    expect(res && 'url' in res ? res.url : '').toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ext\//)
    expect(joinPanel).toHaveBeenCalled()
  })
})
