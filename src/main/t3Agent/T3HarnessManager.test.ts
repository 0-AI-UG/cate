import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Runtime } from '../runtime/types'
import { T3HarnessManager } from './T3HarnessManager'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), disconnected: vi.fn(), windowClosed: vi.fn(),
}))
vi.mock('electron', () => ({ app: {}, session: {} }))
vi.mock('../runtime/runtimeManager', () => ({ resolveLocator: mocks.resolve, runtimes: { onDisconnected: mocks.disconnected } }))
vi.mock('../cateApi/serverTunnel', () => ({ openTunnelDuplex: vi.fn() }))
vi.mock('../cateApi/workspaceCateApi', () => ({ workspaceCateApi: {} }))
vi.mock('../windowRegistry', () => ({ onWindowClosed: mocks.windowClosed }))

function runtime() {
  return {
    validatePathStrict: vi.fn(async (path: string) => path.replace('/alias', '/repo')),
    server: { stop: vi.fn() },
    process: { create: vi.fn().mockResolvedValue(undefined), write: vi.fn(), kill: vi.fn() },
  }
}
function instance(key: string, rt: ReturnType<typeof runtime>) {
  return {
    key, runtime: rt, environmentId: 'env', proxyPort: 4321,
    serverId: key, panels: new Set<string>(),
    proxy: { close: vi.fn((done: () => void) => done()) },
  }
}
let manager: T3HarnessManager
let local: ReturnType<typeof runtime>
let remote: ReturnType<typeof runtime>
let start: MockInstance<(key: string, runtimeId: string, runtime: Runtime) => Promise<unknown>>
const request = { workspaceId: 'ws', panelId: 'panel', cwd: '/repo' }
beforeEach(() => {
  vi.clearAllMocks()
  local = runtime(); remote = runtime()
  mocks.resolve.mockImplementation((cwd: string) => ({
    runtimeId: cwd.startsWith('ssh:') ? 'remote' : 'local',
    path: cwd.replace(/^ssh:/, ''), runtime: cwd.startsWith('ssh:') ? remote : local,
  }))
  manager = new T3HarnessManager()
  // Mock only starting a server and synchronizing files. Public manager methods
  // still own validation, startup sharing, lifecycle and checkout/window isolation.
  const boundary = manager as unknown as {
    startInstance(key: string, runtimeId: string, runtime: Runtime): Promise<unknown>
    ensureLocalThreadMode(): Promise<void>
  }
  start = vi.spyOn(boundary, 'startInstance').mockImplementation(async (key, _id, rt) => instance(key, rt as unknown as ReturnType<typeof runtime>))
  vi.spyOn(boundary, 'ensureLocalThreadMode').mockResolvedValue(undefined)
})
afterEach(async () => { await manager.disposeAll(); vi.restoreAllMocks() })

describe('T3 harness lifecycle', () => {
  it('shares concurrent startup for aliases of the same checkout, but keeps panel chat routes independent', async () => {
    const [first, second] = await Promise.all([
      manager.getPanelTarget({ ...request, cwd: '/alias', threadId: 'one' }, 1),
      manager.getPanelTarget({ ...request, panelId: 'other', threadId: 'two' }, 2),
    ])
    expect(start).toHaveBeenCalledTimes(1)
    expect(local.validatePathStrict).toHaveBeenCalledWith('/alias', 1, 'ws')
    expect(first.partition).toBe(second.partition)
    expect(first.url).toBe('http://127.0.0.1:4321/env/one')
    expect(second.url).toBe('http://127.0.0.1:4321/env/two')
    manager.panelClosed('panel')
    expect(local.server.stop).not.toHaveBeenCalled()
    expect(manager.getStatus('/alias').phase).toBe('running')
  })

  it('reopens a conversation without repeating provider file synchronization', async () => {
    const boundary = manager as unknown as { ensureLocalThreadMode(): Promise<void> }
    const first = await manager.getPanelTarget({ ...request, threadId: 'saved' }, 1)
    manager.panelClosed(request.panelId)
    const reopened = await manager.getPanelTarget({ ...request, threadId: 'saved' }, 1)
    expect(reopened).toEqual(first)
    expect(start).toHaveBeenCalledOnce()
    // startInstance is mocked above; settings sync belongs inside startup,
    // never on the per-panel URL resolution path.
    expect(boundary.ensureLocalThreadMode).not.toHaveBeenCalled()
    expect(local.validatePathStrict).toHaveBeenCalledTimes(2)
  })

  it('isolates worktrees and remote runtimes, including disconnect and reconnect', async () => {
    const main = await manager.getPanelTarget(request, 1)
    const worktree = await manager.getPanelTarget({ ...request, panelId: 'worktree', cwd: '/feature' }, 1)
    const ssh = await manager.getPanelTarget({ ...request, panelId: 'ssh', cwd: 'ssh:/repo' }, 1)
    expect(new Set([main.partition, worktree.partition, ssh.partition]).size).toBe(3)
    mocks.disconnected.mock.calls.at(-1)![0]('remote')
    await vi.waitFor(() => expect(remote.server.stop).toHaveBeenCalledWith('remote:/repo'))
    expect(local.server.stop).not.toHaveBeenCalled()
    expect(manager.getStatus('ssh:/repo').phase).toBe('stopped')
    const reconnected = await manager.getPanelTarget({ ...request, panelId: 'ssh', cwd: 'ssh:/repo', threadId: 'saved' }, 1)
    expect(reconnected.partition).toBe(ssh.partition)
    expect(reconnected.url).toContain('/env/saved')
    expect(start).toHaveBeenCalledTimes(4)
  })

  it('reports startup failure and allows a fresh retry', async () => {
    start.mockRejectedValueOnce(new Error('server launch failed'))
    await expect(manager.getPanelTarget(request, 1)).rejects.toThrow('server launch failed')
    expect(manager.getStatus('/repo')).toEqual({ phase: 'error', message: 'server launch failed' })
    await manager.getPanelTarget(request, 1)
    expect(manager.getStatus('/repo').phase).toBe('running')
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('restarts a canonical checkout without losing its partition or touching siblings', async () => {
    const before = await manager.getPanelTarget({ ...request, cwd: '/alias', threadId: 'saved' }, 1)
    await manager.getPanelTarget({ ...request, cwd: '/feature', panelId: 'other' }, 1)
    await manager.restart('/alias')
    expect(local.server.stop).toHaveBeenCalledExactlyOnceWith('local:/repo')
    expect(manager.getStatus('/feature').phase).toBe('running')
    const after = await manager.getPanelTarget({ ...request, threadId: 'saved' }, 1)
    expect(after).toEqual(before)
    expect(start).toHaveBeenCalledTimes(3)
  })

  it('cleans up a startup that finishes while shutdown is waiting', async () => {
    let finish!: (value: ReturnType<typeof instance>) => void
    start.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const opening = manager.getPanelTarget(request, 1)
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    const shutdown = manager.disposeAll()
    const started = instance('local:/repo', local)
    finish(started)
    await Promise.all([opening, shutdown])
    expect(started.proxy.close).toHaveBeenCalledOnce()
    expect(local.server.stop).toHaveBeenCalledExactlyOnceWith('local:/repo')
    expect(manager.getStatus('/repo').phase).toBe('stopped')
  })

  it('rejects invalid workspace access before starting anything', async () => {
    local.validatePathStrict.mockRejectedValueOnce(new Error('not authorized'))
    await expect(manager.getPanelTarget(request, 9)).rejects.toThrow('not authorized')
    expect(start).not.toHaveBeenCalled()
  })
})

describe('T3 provider sign-in ownership', () => {
  it('rejects another window and cancels the process when its owner closes', async () => {
    const auth = await manager.startProviderAuth({ workspaceId: 'ws', cwd: '/repo', providerId: 'codex' }, 1)
    expect(() => manager.getProviderAuth(auth.id, 2)).toThrow('not found')
    expect(() => manager.writeProviderAuth(auth.id, 2, '\r')).toThrow('not found')
    expect(() => manager.cancelProviderAuth(auth.id, 2)).toThrow('not found')
    expect(local.process.kill).not.toHaveBeenCalled()
    manager.writeProviderAuth(auth.id, 1, '\r')
    expect(local.process.write).toHaveBeenCalledWith(auth.id, '\r')
    mocks.windowClosed.mock.calls.at(-1)![0](1)
    expect(local.process.kill).toHaveBeenCalledWith(auth.id)
    expect(manager.getProviderAuth(auth.id, 1).phase).toBe('cancelled')
    const onExit = local.process.create.mock.calls[0][2]
    onExit(auth.id, 0)
    expect(manager.getProviderAuth(auth.id, 1).phase).toBe('cancelled')
  })

  it('marks only remote sign-in as failed when that runtime disconnects', async () => {
    const auth = await manager.startProviderAuth({ workspaceId: 'ws', cwd: 'ssh:/repo', providerId: 'codex' }, 1)
    const sibling = await manager.startProviderAuth({ workspaceId: 'ws', cwd: '/repo', providerId: 'codex' }, 1)
    mocks.disconnected.mock.calls.at(-1)![0]('remote')
    expect(manager.getProviderAuth(auth.id, 1).phase).toBe('failed')
    expect(manager.getProviderAuth(sibling.id, 1).phase).toBe('running')
  })
})

it('copies provider secrets through canonical directory aliases and still rejects collision-renamed files', async () => {
  const secret = 'provider-env-Y29kZXg-VE9LRU4.bin'
  const rt = {
    file: {
      mkdir: vi.fn(),
      readDir: vi.fn(async (dir: string) => dir === '/source' ? [
        { name: secret, path: '/source/' + secret, isDirectory: false },
        { name: 'desktop-bootstrap-token.bin', path: '/source/desktop-bootstrap-token.bin', isDirectory: false },
      ] : []),
      remove: vi.fn(),
      copy: vi.fn().mockResolvedValue('/private/tmp/secrets/' + secret),
    },
  }
  const boundary = manager as unknown as { copyProviderSecrets(runtime: unknown, runtimeId: string, sourceDir: string, targetDir: string): Promise<void> }
  await boundary.copyProviderSecrets(rt, 'local', '/source', '/tmp/secrets')
  expect(rt.file.copy).toHaveBeenCalledExactlyOnceWith('/source/' + secret, '/tmp/secrets')
  rt.file.copy.mockResolvedValue('/private/tmp/secrets/unexpected-copy.bin')
  await expect(boundary.copyProviderSecrets(rt, 'local', '/source', '/tmp/secrets')).rejects.toThrow('unexpected destination')
})
