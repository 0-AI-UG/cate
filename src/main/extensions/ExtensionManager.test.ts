// =============================================================================
// ExtensionManager — the per-runtime provisioning layer. Covers the unified
// install path's bookkeeping: an extension is provisioned onto a host THROUGH the
// runtime, the result is cached + de-duped per (runtime, extension), and a bytes
// change (reinstall) bumps a generation so the NEXT use force re-extracts on the
// host (a same-version repair must actually repair the host copy). Also: enabled
// extensions are eagerly provisioned onto a host as it connects.
//
// All host I/O is mocked at the install.ts seam (provisionCatalogToRuntime), so
// this is a pure unit test of the manager's caching/generation/eager logic.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

const enabled = vi.hoisted(() => ({ ids: ['cate.test'] }))
let connectCb: ((id: string, runtime: unknown) => void) | null = null
let disconnectCb: ((id: string) => void) | null = null
const disposeForRuntime = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/u', getAppPath: () => '/tmp/a' } }))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../windowRegistry', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../settingsFile', () => ({
  getSetting: (k: string) =>
    k === 'enabledExtensions' ? enabled.ids : k === 'extensionSideloadPaths' ? [] : [],
  setSetting: vi.fn(),
}))
vi.mock('./manifest', () => ({ loadManifestFromDir: vi.fn(async () => null) }))
vi.mock('./catalog', () => ({
  getCachedCatalog: async () => [
    { manifest: { id: 'cate.test', name: 'Test', version: '1.0.0', panels: [{ id: 'm', label: 'M' }] }, artifactUrl: 'file:///x.tgz' },
  ],
  fetchCatalog: vi.fn(),
  writeCatalogCache: vi.fn(),
}))
vi.mock('./download', () => ({
  stageArtifact: vi.fn(async () => ({ id: 'cate.test', version: '1.0.0', tgzPath: '/tmp/x.tgz' })),
  stagedVersions: vi.fn(async () => ['1.0.0']),
  removeStaged: vi.fn(),
  removeStagedVersionsExcept: vi.fn(),
}))

const provisionCatalog = vi.hoisted(() => vi.fn())
vi.mock('./install', () => ({
  provisionCatalogToRuntime: provisionCatalog,
  provisionSideloadToRuntime: vi.fn(async () => '/host/sideload'),
}))

const fakeRuntime = { id: 'srv_1' }
vi.mock('../runtime/runtimeManager', () => ({
  runtimes: {
    onConnected: (cb: (id: string, runtime: unknown) => void) => { connectCb = cb; return () => {} },
    onDisconnected: (cb: (id: string) => void) => { disconnectCb = cb; return () => {} },
    registeredIds: () => ['srv_1'],
    resolve: () => fakeRuntime,
  },
}))
// The disconnect handler lazy-imports ExtensionServerManager; stub it so we can
// assert disposeForRuntime is invoked for the dropped runtime.
vi.mock('./ExtensionServerManager', () => ({
  extensionServerManager: { disposeForRuntime },
}))

import { ExtensionManager } from './ExtensionManager'

// Fresh instance per test so the per-runtime provision cache + generation state
// can't leak across cases (the app uses a singleton, but isolation matters here).
let extensionManager: ExtensionManager

beforeEach(() => {
  enabled.ids = ['cate.test']
  connectCb = null
  disconnectCb = null
  disposeForRuntime.mockClear()
  provisionCatalog.mockReset()
  // Each catalog provision returns the host dir for its (id, version).
  provisionCatalog.mockImplementation(async () => '/host/cate.test/1.0.0')
  extensionManager = new ExtensionManager()
})

describe('ExtensionManager provisioning', () => {
  it('caches a provision per (runtime, extension): a second call does not re-provision', async () => {
    await extensionManager.refresh(true)
    const a = await extensionManager.ensureProvisioned('cate.test', fakeRuntime as never)
    const b = await extensionManager.ensureProvisioned('cate.test', fakeRuntime as never)
    expect(a).toBe('/host/cate.test/1.0.0')
    expect(b).toBe('/host/cate.test/1.0.0')
    expect(provisionCatalog).toHaveBeenCalledTimes(1)
  })

  it('de-dupes concurrent provisions into a single host upload', async () => {
    await extensionManager.refresh(true)
    const [a, b] = await Promise.all([
      extensionManager.ensureProvisioned('cate.test', fakeRuntime as never),
      extensionManager.ensureProvisioned('cate.test', fakeRuntime as never),
    ])
    expect(a).toBe(b)
    expect(provisionCatalog).toHaveBeenCalledTimes(1)
  })

  it('reinstall force re-extracts on the host (generation bump) even for the same version', async () => {
    await extensionManager.refresh(true)
    await extensionManager.ensureProvisioned('cate.test', fakeRuntime as never)
    expect(provisionCatalog).toHaveBeenLastCalledWith(fakeRuntime, expect.anything(), false)

    // Reinstall bumps the bytes generation; the next provision must force.
    await extensionManager.reinstall('cate.test')
    await extensionManager.ensureProvisioned('cate.test', fakeRuntime as never)
    expect(provisionCatalog).toHaveBeenLastCalledWith(fakeRuntime, expect.anything(), true)
  })

  it('init() subscribes to host connect; provisionAllEnabled provisions enabled extensions', async () => {
    extensionManager.init()
    // init wires the eager-provision handler onto runtime connects.
    expect(connectCb).toBeTypeOf('function')
    // The handler's effect (driven directly to avoid the fire-and-forget timing).
    await extensionManager.refresh(true)
    await extensionManager.provisionAllEnabled(fakeRuntime as never)
    expect(provisionCatalog).toHaveBeenCalledWith(fakeRuntime, expect.anything(), false)
  })

  it('init() invalidates the provision cache and disposes server sessions on disconnect', async () => {
    extensionManager.init()
    expect(disconnectCb).toBeTypeOf('function')

    // Prime a cached provision for srv_1, then simulate a live drop.
    await extensionManager.refresh(true)
    await extensionManager.ensureProvisioned('cate.test', fakeRuntime as never)
    expect(provisionCatalog).toHaveBeenCalledTimes(1)

    disconnectCb!('srv_1')
    // disposeForRuntime is dispatched through a dynamic import (lazy, to dodge the
    // static cycle), so let the microtasks settle before asserting.
    await new Promise((r) => setTimeout(r, 0))
    // The extension server sessions bound to the dead runtime are released.
    expect(disposeForRuntime).toHaveBeenCalledWith('srv_1')

    // The cache for srv_1 was dropped, so the next provision re-uploads (the host
    // copy can't be trusted across a reconnect).
    await extensionManager.ensureProvisioned('cate.test', fakeRuntime as never)
    expect(provisionCatalog).toHaveBeenCalledTimes(2)
  })

  it('does not provision a disabled extension on connect', async () => {
    enabled.ids = []
    await extensionManager.refresh(true)
    await extensionManager.provisionAllEnabled(fakeRuntime as never)
    expect(provisionCatalog).not.toHaveBeenCalled()
  })
})
