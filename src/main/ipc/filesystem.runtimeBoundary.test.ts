import { beforeEach, expect, test, vi } from 'vitest'
import { parseLocator, formatLocator } from '../../shared/runtimeLocator'
import { FS_COPY, FS_RENAME, FS_WRITE_FILE } from '../../shared/ipc-channels'

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  handlers: new Map<string, (...args: any[]) => Promise<unknown>>(),
  read: vi.fn().mockResolvedValue('disk'),
  write: vi.fn().mockResolvedValue('/repo/a'),
  rename: vi.fn().mockResolvedValue('/repo/dest'),
  copy: vi.fn().mockResolvedValue('/repo/dest/source'),
}))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => Promise<unknown>) => mocks.handlers.set(name, fn) }, shell: {} }))
vi.mock('../runtime/runtimeManager', () => ({
  resolveLocator: (locator: string) => ({ ...parseLocator(locator), runtime: { file: { rename: mocks.rename, copy: mocks.copy, writeFile: mocks.write, readFile: mocks.read } } }),
  runtimes: { onConnected: vi.fn(), onDisconnected: vi.fn() },
}))
vi.mock('../windowRegistry', () => ({ windowFromEvent: () => undefined, sendToWindow: vi.fn(), broadcastToAll: mocks.broadcast }))
vi.mock('../store', () => ({ getSettingSync: () => [] }))
import { registerHandlers } from './filesystem'
registerHandlers()
beforeEach(() => {
  mocks.write.mockReset().mockResolvedValue('/repo/a')
  mocks.read.mockReset().mockResolvedValue('disk')
  mocks.rename.mockReset().mockResolvedValue('/repo/dest')
  mocks.copy.mockReset().mockResolvedValue('/repo/dest/source')
})

test.each([FS_RENAME, FS_COPY])('%s rejects cross-runtime destinations before filesystem mutation', async channel => {
  const source = formatLocator({ runtimeId: 'remote-a', path: '/repo/source' })
  const destination = formatLocator({ runtimeId: 'remote-b', path: '/repo/dest' })
  await expect(mocks.handlers.get(channel)!({}, source, destination, 'workspace')).rejects.toThrow(/same runtime|different runtime/)
  expect(mocks.rename).not.toHaveBeenCalled()
  expect(mocks.copy).not.toHaveBeenCalled()
})

test.each([FS_RENAME, FS_COPY])('%s forwards same-runtime host paths and workspace scope', async channel => {
  const source = formatLocator({ runtimeId: 'remote-a', path: '/repo/source' })
  const destination = formatLocator({ runtimeId: 'remote-a', path: '/repo/dest' })
  await mocks.handlers.get(channel)!({}, source, destination, 'workspace')
  expect(channel === FS_RENAME ? mocks.rename : mocks.copy).toHaveBeenCalledWith('/repo/source', '/repo/dest', { ownerWindowId: undefined, scopeId: 'workspace' })
})

test('publishes a file move only after successful mutation', async () => {
  mocks.broadcast.mockClear()
  mocks.rename.mockRejectedValueOnce(new Error('failed'))
  await expect(mocks.handlers.get(FS_RENAME)!({}, '/repo/a', '/repo/b')).rejects.toThrow('failed')
  expect(mocks.broadcast).not.toHaveBeenCalled()
  await mocks.handlers.get(FS_RENAME)!({}, '/repo/a', '/repo/b')
  expect(mocks.broadcast).toHaveBeenCalledWith('fs:entryMoved', { from: '/repo/a', to: '/repo/b' })
})


test('an issued write completes before a rename can move its destination', async () => {
  let finish!: (path: string) => void
  mocks.write.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
  const writing = mocks.handlers.get(FS_WRITE_FILE)!({}, '/repo/a', 'edits', 'workspace')
  await Promise.resolve(); await Promise.resolve()
  const moving = mocks.handlers.get(FS_RENAME)!({}, '/repo/a', '/repo/b', 'workspace')
  await Promise.resolve(); await Promise.resolve()
  expect(mocks.rename).not.toHaveBeenCalled()
  finish('/repo/a'); await Promise.all([writing, moving])
  expect(mocks.rename).toHaveBeenCalledOnce()
})

test('rejects an old-path save queued behind a rename even if its renderer has not received the move event', async () => {
  mocks.read.mockRejectedValue(new Error('ENOENT'))
  await expect(mocks.handlers.get(FS_WRITE_FILE)!({}, '/repo/a', 'edits', 'workspace', 'disk')).rejects.toThrow(/changed/)
  expect(mocks.write).not.toHaveBeenCalled()
})
