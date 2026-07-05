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
// Catalog-advertised (latest) version + the versions staged on disk, made
// configurable so a test can model "catalog bumped past what's installed".
const catalogState = vi.hoisted(() => ({ version: '1.0.0' }))
const stagedState = vi.hoisted(() => ({ versions: ['1.0.0'] }))
// A gate the catalog read awaits, so a test can hold a scan mid-flight and probe
// what a concurrent refresh() observes before the scan finishes.
const catalogGate = vi.hoisted(() => ({ wait: async (): Promise<void> => {} }))
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
  getCachedCatalog: async () => {
    await catalogGate.wait()
    return [
      { manifest: { id: 'cate.test', name: 'Test', version: catalogState.version, panels: [{ id: 'm', label: 'M' }] }, artifactUrl: 'file:///x.tgz' },
    ]
  },
  fetchCatalog: vi.fn(),
  writeCatalogCache: vi.fn(),
}))
vi.mock('./download', () => ({
  stageArtifact: vi.fn(async () => ({ id: 'cate.test', version: catalogState.version, tgzPath: '/tmp/x.tgz' })),
  stagedVersions: vi.fn(async () => stagedState.versions),
  isStaged: vi.fn((_id: string, version: string) => stagedState.versions.includes(version)),
  removeStaged: vi.fn(),
  removeStagedVersionsExcept: vi.fn(),
}))

const provisionCatalog = vi.hoisted(() => vi.fn())
const provisionStaged = vi.hoisted(() => vi.fn())
vi.mock('./install', () => ({
  provisionCatalogToRuntime: provisionCatalog,
  provisionStagedToRuntime: provisionStaged,
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
  catalogState.version = '1.0.0'
  stagedState.versions = ['1.0.0']
  catalogGate.wait = async () => {}
  connectCb = null
  disconnectCb = null
  disposeForRuntime.mockClear()
  provisionCatalog.mockReset()
  provisionStaged.mockReset()
  // Each provision returns the host dir for its (id, version).
  provisionCatalog.mockImplementation(async () => '/host/cate.test/1.0.0')
  provisionStaged.mockImplementation(async () => '/host/cate.test/1.0.0')
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

  it('concurrent refresh() calls both observe a fully-populated known map', async () => {
    // Two callers race (startup `void refresh()` + a panel's proxy-url await).
    // Hold the first scan mid-flight; the second must NOT short-circuit on `loaded`
    // and resolve against a still-empty map — it must await the in-flight scan.
    let release: () => void = () => {}
    catalogGate.wait = () => new Promise<void>((r) => { release = r })

    const p1 = extensionManager.refresh()
    const p2 = extensionManager.refresh()
    let p2Done = false
    void p2.then(() => { p2Done = true })

    // Let microtasks settle: the buggy version resolves p2 immediately (loaded was
    // set before the scan) while `known` is still empty.
    await Promise.resolve()
    await Promise.resolve()
    expect(p2Done).toBe(false)
    expect(extensionManager.isKnown('cate.test')).toBe(false)

    release()
    await Promise.all([p1, p2])
    expect(extensionManager.isKnown('cate.test')).toBe(true)
  })

  it('provisions the INSTALLED (pinned) version, not the catalog latest', async () => {
    // Catalog advertises 2.0 but only 1.0 is staged on disk (a catalog refresh
    // bumped latest past what's installed).
    catalogState.version = '2.0.0'
    stagedState.versions = ['1.0.0']
    await extensionManager.refresh(true)

    const before = extensionManager.list().find((e) => e.manifest.id === 'cate.test')!
    expect(before.installedVersion).toBe('1.0.0')
    expect(before.updateAvailable).toBe(true)

    // Opening/provisioning a panel must serve 1.0, NOT silently pull 2.0. Because
    // the single-version catalog entry only points at 2.0's artifact, the pinned
    // 1.0 must be served from its ALREADY-STAGED bytes (provisionStagedToRuntime),
    // never re-fetched through provisionCatalogToRuntime (that would download 2.0's
    // bytes into the 1.0 dir, sha256-matching 2.0, and run the wrong code).
    await extensionManager.ensureProvisioned('cate.test', fakeRuntime as never)
    expect(provisionCatalog).not.toHaveBeenCalled()
    const stagedCall = provisionStaged.mock.calls.at(-1)!
    expect(stagedCall[1]).toBe('cate.test')
    expect(stagedCall[2]).toBe('1.0.0')

    // installedVersion stays 1.0 and updateAvailable stays true (no silent update).
    const after = extensionManager.list().find((e) => e.manifest.id === 'cate.test')!
    expect(after.installedVersion).toBe('1.0.0')
    expect(after.updateAvailable).toBe(true)
  })
})
