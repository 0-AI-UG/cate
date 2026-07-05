// =============================================================================
// proxyServer.ensureProxyServer — a rejected start must NOT be cached forever.
// If the first listen() errors (e.g. a transient bind failure), the cached
// startPromise has to be cleared so a later call re-attempts and can succeed,
// instead of replaying the same rejection for the rest of the process lifetime.
// =============================================================================

import { describe, it, expect, vi } from 'vitest'

// Toggle whether the next listen() succeeds or errors.
const listenState = vi.hoisted(() => ({ fail: true }))

// Fake http.createServer: each returned server records its handlers and, on
// listen(), asynchronously either emits 'error' or invokes the ready callback
// (async so it fires AFTER ensureProxyServer assigns startPromise, mirroring the
// real async listen — a synchronous error would run inside the Promise executor
// before the assignment).
vi.mock('http', () => {
  const createServer = vi.fn(() => {
    const handlers: Record<string, (arg?: unknown) => void> = {}
    const fake = {
      on(ev: string, cb: (arg?: unknown) => void) { handlers[ev] = cb; return fake },
      listen(_port: number, _host: string, cb: () => void) {
        if (listenState.fail) {
          queueMicrotask(() => handlers['error']?.(new Error('EADDRINUSE (simulated)')))
        } else {
          queueMicrotask(() => cb())
        }
      },
      address() { return { port: 4321 } },
    }
    return fake
  })
  return { default: { createServer } }
})

vi.mock('./ExtensionManager', () => ({ extensionManager: {} }))
vi.mock('./ExtensionServerManager', () => ({ extensionServerManager: {} }))
vi.mock('./serverTunnel', () => ({ openTunnelDuplex: vi.fn() }))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('electron', () => ({}))
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: vi.fn() }))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { resolve: vi.fn() } }))

import { ensureProxyServer } from './proxyServer'

describe('ensureProxyServer — rejected start is not cached', () => {
  it('re-attempts after an initial listen failure and can then succeed', async () => {
    listenState.fail = true
    await expect(ensureProxyServer()).rejects.toThrow(/simulated/)

    // A later call must NOT return the same cached rejection.
    listenState.fail = false
    await expect(ensureProxyServer()).resolves.toBe(4321)
  })
})
