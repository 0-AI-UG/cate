import { afterEach, expect, it, vi } from 'vitest'
import type { RemoteRuntimeConnection } from '../../shared/runtimeConnection'

const profile: RemoteRuntimeConnection = { kind: 'server', runtimeId: 'srv_test', host: 'host', user: 'me', remotePath: '/project' }
afterEach(() => vi.unstubAllGlobals())
it('shares loads, accepts broadcasts, and does not overwrite them with stale responses', async () => {
  vi.resetModules()
  let publish: (connections: RemoteRuntimeConnection[]) => void = () => {}
  let resolveList: (connections: RemoteRuntimeConnection[]) => void = () => {}
  const list = vi.fn(() => new Promise<RemoteRuntimeConnection[]>((resolve) => { resolveList = resolve }))
  vi.stubGlobal('window', { electronAPI: {
    onRemoteConnectionsChanged: vi.fn((callback) => { publish = callback; return () => {} }), remoteConnectionsList: list,
  } })
  const { useRemoteConnectionsStore: store } = await import('./remoteConnectionsStore')
  const first = store.getState().load()
  const second = store.getState().load()
  expect(list).toHaveBeenCalledTimes(1)
  publish([profile])
  resolveList([])
  await Promise.all([first, second])
  expect(store.getState().connections).toEqual([profile])
})
it('retries failed loads and preserves the list after a rejected save', async () => {
  vi.resetModules()
  const list = vi.fn().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue([profile])
  vi.stubGlobal('window', { electronAPI: {
    onRemoteConnectionsChanged: vi.fn(() => () => {}), remoteConnectionsList: list,
    remoteConnectionsSave: vi.fn().mockRejectedValue(new Error('Disk full')),
  } })
  const { useRemoteConnectionsStore: store } = await import('./remoteConnectionsStore')
  await store.getState().load()
  expect(store.getState().error).toBe('Read failed')
  await store.getState().load()
  expect(store.getState().connections).toEqual([profile])
  await expect(store.getState().save({ kind: 'wsl', distro: 'Ubuntu', distroPath: '/project' })).rejects.toThrow('Disk full')
  expect(store.getState().connections).toEqual([profile])
})
