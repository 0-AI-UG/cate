// =============================================================================
// proxyServer.identityForGuestUrl — the trusted-identity resolver used by the
// cateHost reverse API. A guest's (extensionId, workspaceId) is derived from the
// opaque routeToken in the URL PATH, but only when the URL is served by THIS
// proxy's own origin. A guest that navigates off-origin to
// `https://attacker.com/ext/<validToken>/…` must NOT resolve to the extension's
// identity (it would otherwise inherit the full cate.* API).
// =============================================================================

import { describe, it, expect, beforeAll, vi } from 'vitest'

const EXT_ID = 'cate.frontendkit'
const WS = 'ws-1'

// Only ExtensionManager's identity/enable checks matter for route resolution.
vi.mock('./ExtensionManager', () => ({
  extensionManager: {
    isKnown: (id: string) => id === EXT_ID,
    isEnabled: () => true,
    getManifest: () => ({ id: EXT_ID, name: 'Frontend Kit', frontend: 'index.html', panels: [{ id: 'main', label: 'Frontend Kit' }] }),
    ensureProvisioned: async () => '/tmp/does-not-matter',
  },
}))
vi.mock('./ExtensionServerManager', () => ({ extensionServerManager: {} }))
vi.mock('./serverTunnel', () => ({ openTunnelDuplex: vi.fn() }))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('electron', () => ({}))
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: () => ({ rootPath: '/ws/root' }) }))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { resolve: () => ({ id: 'local', file: {} }) } }))

import { ensureProxyServer, getProxyUrlFor, identityForGuestUrl, getProxyOrigin } from './proxyServer'

describe('identityForGuestUrl — origin-scoped route identity', () => {
  let port: number
  let token: string

  beforeAll(async () => {
    port = await ensureProxyServer()
    const resolved = await getProxyUrlFor({ extensionId: EXT_ID, workspaceId: WS, panelId: 'main' })
    token = /\/ext\/([^/]+)\//.exec((resolved as { url: string }).url)![1]
  })

  it('resolves the identity for a URL on the proxy origin with a valid route token', () => {
    const url = `http://127.0.0.1:${port}/ext/${token}/index.html`
    expect(identityForGuestUrl(url)).toEqual({ extensionId: EXT_ID, workspaceId: WS })
    expect(getProxyOrigin()).toBe(`http://127.0.0.1:${port}`)
  })

  it('rejects a URL with the correct route path but a non-proxy origin', () => {
    // Same valid /ext/<token>/ path, but served from an attacker origin — must
    // NOT resolve to the extension's identity.
    expect(identityForGuestUrl(`https://attacker.com/ext/${token}/index.html`)).toBeNull()
    expect(identityForGuestUrl(`http://127.0.0.1:1/ext/${token}/index.html`)).toBeNull()
    expect(identityForGuestUrl(`file:///ext/${token}/index.html`)).toBeNull()
  })

  it('rejects an unknown route token even on the proxy origin', () => {
    expect(identityForGuestUrl(`http://127.0.0.1:${port}/ext/deadbeef/index.html`)).toBeNull()
  })
})
