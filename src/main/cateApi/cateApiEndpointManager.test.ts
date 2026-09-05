import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  runtimes: new Map<string, { id: string; tunnel: { listen: ReturnType<typeof vi.fn>; stopListen: ReturnType<typeof vi.fn> } }>(),
  reverseDispose: vi.fn(),
}))
vi.mock('electron', () => ({}))
vi.mock('../logger', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../settingsFile', () => ({ getSetting: () => true }))
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo: (id: string) => ({ rootPath: id }) }))
vi.mock('../../shared/runtimeLocator', () => ({ parseLocator: (id: string) => ({ runtimeId: id, path: `/work/${id}` }) }))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { resolve: (id: string) => h.runtimes.get(id) } }))
vi.mock('./cateApiReverse', async (importActual) => ({
  ...await importActual<typeof import('./cateApiReverse')>(),
  createCateApiReverse: () => ({ dispose: h.reverseDispose }),
}))

import { CateApiEndpointManager } from './cateApiEndpointManager'

const options = (key: string, runtimeId = 'local') => ({ key, workspaceId: runtimeId, listenerId: key })

beforeEach(() => {
  h.runtimes.clear()
  for (const id of ['local', 'remote']) {
    h.runtimes.set(id, { id, tunnel: {
      listen: vi.fn(async () => ({ port: 41000 })),
      stopListen: vi.fn(),
    } })
  }
})

describe('CateApiEndpointManager teardown', () => {
  it.each(['key', 'runtime', 'all'] as const)('cancels a listener opening during %s disposal', async (mode) => {
    const runtime = h.runtimes.get('local')!
    let release!: (value: { port: number }) => void
    runtime.tunnel.listen.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const manager = new CateApiEndpointManager()
    const opening = manager.ensure(options('pending'))
    const rejected = expect(opening).rejects.toThrow('disposed while opening')
    await vi.waitFor(() => expect(runtime.tunnel.listen).toHaveBeenCalledOnce())
    if (mode === 'key') manager.dispose('pending')
    else if (mode === 'runtime') manager.disposeForRuntime('local')
    else manager.disposeAll()
    release({ port: 41001 })
    await rejected
    expect(runtime.tunnel.stopListen).toHaveBeenCalledWith('pending')
    await expect(manager.ensure(options('pending'))).resolves.toMatchObject({ port: 41000 })
    manager.disposeAll()
  })

  it('disposes every endpoint on a disconnected runtime while preserving other runtimes', async () => {
    const manager = new CateApiEndpointManager()
    await manager.ensure(options('one'))
    await manager.ensure(options('two'))
    await manager.ensure(options('remote', 'remote'))
    manager.disposeForRuntime('local')
    expect(h.runtimes.get('local')!.tunnel.stopListen.mock.calls).toEqual([['one'], ['two']])
    expect(h.runtimes.get('remote')!.tunnel.stopListen).not.toHaveBeenCalled()
    manager.disposeAll()
    expect(h.runtimes.get('remote')!.tunnel.stopListen).toHaveBeenCalledWith('remote')
  })
})
