import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { createBrowserEngineHost } from './host'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
vi.mock('electron', () => ({ app: { getPath: () => '/downloads' }, webContents: {} }))

class Engine extends EventEmitter {
  connected = true
  failing = new Set<string>()
  send = vi.fn((message: { request: number; method: string; args: { partition: string } }) => {
    const { request, method, args } = message
    queueMicrotask(() => this.emit('message', method === 'prepare' && this.failing.has(args.partition)
      ? { request, error: 'invalid partition' }
      : { request }))
  })
  exit() {
    this.connected = false
    this.emit('exit')
  }
}

beforeEach(() => spawn.mockReset())

it('keeps healthy partitions available and retries a failed partition', async () => {
  const engine = new Engine()
  const host = createBrowserEngineHost({ userData: '/data', preload: '/guest.js' })
  const broken = { partition: 'persist:ws-broken' }
  const healthy = { partition: 'persist:ws-healthy' }
  spawn.mockReturnValue(engine)
  engine.failing.add(broken.partition)

  await host.call('prepare', broken)
  await host.call('prepare', healthy)
  expect(spawn).not.toHaveBeenCalled()
  const failure = expect(host.call('create', broken)).rejects.toThrow('invalid partition')
  const success = host.call('create', healthy)
  engine.emit('message', { ready: true })
  await Promise.all([failure, success])
  expect(engine.send.mock.calls.map(([message]) => [message.method, message.args.partition])).toEqual([
    ['prepare', broken.partition], ['prepare', healthy.partition], ['create', healthy.partition],
  ])

  engine.failing.clear()
  await host.call('create', broken)
  expect(engine.send).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'create', args: broken }), expect.any(Function))
  expect(spawn).toHaveBeenCalledTimes(1)
  engine.exit()
})

it('reapplies a partition exactly once when concurrent callers start a replacement engine', async () => {
  const first = new Engine()
  const second = new Engine()
  spawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
  const host = createBrowserEngineHost({ userData: '/data', preload: '/guest.js' })
  const options = { partition: 'persist:ws-test' }

  await host.call('prepare', options)
  const create = host.call('create', options)
  first.emit('message', { ready: true })
  await create
  first.exit()

  const pages = [host.call('create', options), host.call('icon', options)]
  second.emit('message', { ready: true })
  await Promise.all(pages)
  expect(second.send.mock.calls.map(([message]) => message.method)).toEqual(['prepare', 'create', 'icon'])
  second.exit()
})
