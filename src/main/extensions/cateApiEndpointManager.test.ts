import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const runtimes = new Map<string, {
    id: string
    tunnel: {
      listen: ReturnType<typeof vi.fn>
      stopListen: ReturnType<typeof vi.fn>
      ack: ReturnType<typeof vi.fn>
    }
  }>()
  const bindReverseTunnel = vi.fn()
  const reverseDispose = vi.fn()
  return { runtimes, bindReverseTunnel, reverseDispose }
})

vi.mock('../logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../workspaceManager', () => ({
  getWorkspaceInfo: (workspaceId: string) => ({ rootPath: workspaceId }),
}))
vi.mock('../../shared/runtimeLocator', () => ({
  parseLocator: (rootPath: string) => ({ runtimeId: rootPath, path: `/work/${rootPath}` }),
}))
vi.mock('../runtime/runtimeManager', () => ({
  runtimes: { resolve: (runtimeId: string) => h.runtimes.get(runtimeId) },
}))
vi.mock('./cateApiReverse', () => ({
  createCateApiReverse: () => ({ dispose: h.reverseDispose }),
  bindReverseTunnel: (...args: unknown[]) => h.bindReverseTunnel(...args),
}))

import { CateApiEndpointManager } from './cateApiEndpointManager'

type Owner = 'extension' | 'first-party'

function options(key: string, owner: Owner, runtimeId: string) {
  return {
    key,
    owner,
    extensionId: `ext-${key}`,
    workspaceId: runtimeId,
    listenerId: `listener-${key}`,
  }
}

interface TestBinding {
  port: number
  dispose: ReturnType<typeof vi.fn>
}

const pending = new Map<string, (binding: TestBinding) => void>()
let nextPort = 41000

function makeBinding(): TestBinding {
  return { port: nextPort++, dispose: vi.fn() }
}

function deferBindings(): void {
  h.bindReverseTunnel.mockImplementation(
    (_runtime: unknown, _reverse: unknown, listenerId: string) =>
      new Promise<TestBinding>((resolve) => pending.set(listenerId, resolve)),
  )
}

function release(key: string, binding: TestBinding): void {
  const resolve = pending.get(`listener-${key}`)
  if (!resolve) throw new Error(`No pending binding for ${key}`)
  pending.delete(`listener-${key}`)
  resolve(binding)
}

beforeEach(() => {
  h.runtimes.clear()
  for (const id of ['local', 'remote']) {
    h.runtimes.set(id, {
      id,
      tunnel: {
        listen: vi.fn(async () => ({ port: nextPort++ })),
        stopListen: vi.fn(),
        ack: vi.fn(),
      },
    })
  }
  h.bindReverseTunnel.mockReset()
  h.bindReverseTunnel.mockImplementation(async () => makeBinding())
  h.reverseDispose.mockClear()
  pending.clear()
  nextPort = 41000
})

describe('CateApiEndpointManager teardown races', () => {
  // Kept in one test because this manager intentionally lazy-imports
  // cateApiReverse; Vitest's global restoreMocks restores that dynamic module's
  // export between tests. Each section uses a fresh manager, so lifecycle state
  // remains isolated while all three public teardown methods are covered.
  it('cancels in-flight ensures by key, runtime, and owner without crossing owner boundaries', async () => {
    // dispose(key)
    deferBindings()
    const byKey = new CateApiEndpointManager()
    const opening = byKey.ensure(options('one', 'extension', 'local'))
    const rejected = expect(opening).rejects.toThrow('disposed while opening')
    await vi.waitFor(() => expect(h.bindReverseTunnel).toHaveBeenCalledTimes(1))

    byKey.dispose('one')
    const stale = makeBinding()
    release('one', stale)

    await rejected
    expect(stale.dispose).toHaveBeenCalledOnce()

    h.bindReverseTunnel.mockImplementation(async () => makeBinding())
    await expect(byKey.ensure(options('one', 'extension', 'local'))).resolves.toMatchObject({ port: 41001 })

    // disposeForRuntime(owner, runtimeId)
    const localExtBinding = makeBinding()
    const localFirstBinding = makeBinding()
    const remoteExtBinding = makeBinding()
    h.bindReverseTunnel.mockImplementation(
      (_runtime: unknown, _reverse: unknown, listenerId: string) => {
        if (listenerId === 'listener-local-ext') {
          return new Promise<TestBinding>((resolve) => pending.set(listenerId, resolve))
        }
        return Promise.resolve(listenerId === 'listener-local-first' ? localFirstBinding : remoteExtBinding)
      },
    )
    const byRuntime = new CateApiEndpointManager()
    const localExtension = byRuntime.ensure(options('local-ext', 'extension', 'local'))
    const localFirstParty = byRuntime.ensure(options('local-first', 'first-party', 'local'))
    const remoteExtension = byRuntime.ensure(options('remote-ext', 'extension', 'remote'))
    const runtimeOutcomes = [localExtension, localFirstParty, remoteExtension].map((promise) =>
      promise.then(() => 'resolved', (err) => `rejected: ${String(err)}`),
    )
    await vi.waitFor(() => expect(pending.has('listener-local-ext')).toBe(true))

    byRuntime.disposeForRuntime('extension', 'local')
    release('local-ext', localExtBinding)

    await expect(Promise.all(runtimeOutcomes)).resolves.toEqual([
      expect.stringContaining('disposed while opening'),
      'resolved',
      'resolved',
    ])
    expect(localExtBinding.dispose).toHaveBeenCalledOnce()
    expect(localFirstBinding.dispose).not.toHaveBeenCalled()
    expect(remoteExtBinding.dispose).not.toHaveBeenCalled()

    // disposeAll(owner)
    const extensionBinding = makeBinding()
    const firstPartyBinding = makeBinding()
    h.bindReverseTunnel.mockImplementation(
      (_runtime: unknown, _reverse: unknown, listenerId: string) => {
        if (listenerId === 'listener-ext') {
          return new Promise<TestBinding>((resolve) => pending.set(listenerId, resolve))
        }
        return Promise.resolve(firstPartyBinding)
      },
    )
    const byOwner = new CateApiEndpointManager()
    const extension = byOwner.ensure(options('ext', 'extension', 'local'))
    const firstParty = byOwner.ensure(options('first', 'first-party', 'local'))
    const ownerOutcomes = [extension, firstParty].map((promise) =>
      promise.then(() => 'resolved', (err) => `rejected: ${String(err)}`),
    )
    await vi.waitFor(() => expect(pending.has('listener-ext')).toBe(true))

    byOwner.disposeAll('extension')
    release('ext', extensionBinding)

    await expect(Promise.all(ownerOutcomes)).resolves.toEqual([
      expect.stringContaining('disposed while opening'),
      'resolved',
    ])
    expect(extensionBinding.dispose).toHaveBeenCalledOnce()
    expect(firstPartyBinding.dispose).not.toHaveBeenCalled()
  })
})
