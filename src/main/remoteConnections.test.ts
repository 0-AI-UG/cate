import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({ dir: '', legacy: [] as unknown[] }))
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }))
vi.mock('./workspaceStateStore', () => ({ getRemoteProjects: () => state.legacy }))
vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))
const connection = { kind: 'server' as const, runtimeId: 'srv_test', host: 'host', user: 'user', remotePath: '/project' }
beforeEach(() => { vi.resetModules(); state.dir = fs.mkdtempSync(path.join(tmpdir(), 'cate-connections-')); state.legacy = [] })
afterEach(() => fs.rmSync(state.dir, { recursive: true, force: true }))
it('migrates old workspace connections once, and does not resurrect removed profiles', async () => {
  state.legacy = [{ connection }, { connection }]
  const { updateRemoteConnections } = await import('./remoteConnections')
  expect(await updateRemoteConnections()).toEqual([connection])
  await updateRemoteConnections(() => [])
  vi.resetModules()
  const restored = await import('./remoteConnections')
  expect(await restored.updateRemoteConnections()).toEqual([])
})
it('persists profiles independently of workspace snapshots and serializes concurrent saves', async () => {
  const { updateRemoteConnections } = await import('./remoteConnections')
  const other = { kind: 'wsl' as const, runtimeId: 'wsl_test', distro: 'Ubuntu', distroPath: '/project' }
  await Promise.all([
    updateRemoteConnections((current) => [...current, connection]),
    updateRemoteConnections((current) => [...current, other]),
  ])
  vi.resetModules()
  const restored = await import('./remoteConnections')
  expect(await restored.updateRemoteConnections()).toEqual([connection, other])
})
it('strips secrets and unknown properties and rejects malformed profiles', async () => {
  const { normalizeRemoteConnection } = await import('./remoteConnections')
  expect(normalizeRemoteConnection({ ...connection, auth: { passphrase: 'secret' }, passphrase: 'secret' })).toEqual(connection)
  expect(normalizeRemoteConnection({ ...connection, port: 70000 })).toBeNull()
  expect(normalizeRemoteConnection({ ...connection, remotePath: '~/project' })).toBeNull()
})
