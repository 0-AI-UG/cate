import { describe, expect, it, vi } from 'vitest'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { createWebPartitions, type LoopbackDialer } from './webPartitions'
import type { LoopbackProxyOptions } from './loopbackProxy'

const RUNTIME = 'abcdefghijklmnop'

function setup() {
  const setProxy = vi.fn(async () => {})
  let proxyOptions: LoopbackProxyOptions | null = null
  const close = vi.fn(async () => {})
  const partitions = createWebPartitions({
    session: () => ({ setProxy }),
    upstream: () => undefined,
    startProxy: async (options) => {
      proxyOptions = options
      return { port: 41234, close }
    },
  })
  return { partitions, setProxy, close, dialLoopback: (port: number) => proxyOptions!.dialLoopback(port) }
}

const dialer = (id: number, dial: LoopbackDialer['dial'], destroyed = false): LoopbackDialer => ({ id, isDestroyed: () => destroyed, dial })

describe('web partitions', () => {
  it('routes the workspace partition through its proxy, loopback included', async () => {
    const { partitions, setProxy } = setup()
    expect(partitions.isPrepared(`persist:ws-${RUNTIME}`)).toBe(false)
    expect(await partitions.partitionFor(RUNTIME, dialer(1, vi.fn()))).toBe(`persist:ws-${RUNTIME}`)
    expect(setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:41234', proxyBypassRules: '<-loopback>' })
    expect(partitions.isPrepared(`persist:ws-${RUNTIME}`)).toBe(true)
    await partitions.partitionFor(RUNTIME, dialer(2, vi.fn()))
    expect(setProxy).toHaveBeenCalledTimes(1)
    await expect(partitions.partitionFor('../etc', dialer(1, vi.fn()))).rejects.toThrow('invalid runtime id')
  })

  it('answers the proxy challenge only for its own proxies', async () => {
    const { partitions } = setup()
    await partitions.partitionFor(RUNTIME, dialer(1, vi.fn()))
    expect(partitions.credentialsFor('127.0.0.1', 41234)).toBe(partitions.credentials)
    expect(partitions.credentialsFor('127.0.0.1', 8080)).toBeNull()
    expect(partitions.credentialsFor('proxy.corp', 41234)).toBeNull()
  })

  it('dials loopback through a live window serving the workspace', async () => {
    const { partitions, dialLoopback } = setup()
    const pipe = {} as ByteDuplex
    const gone = vi.fn()
    const live = vi.fn(async () => pipe)
    await partitions.partitionFor(RUNTIME, dialer(1, gone, true))
    await partitions.partitionFor(RUNTIME, dialer(2, live))
    expect(await dialLoopback(3000)).toBe(pipe)
    expect(live).toHaveBeenCalledWith(RUNTIME, 3000)
    expect(gone).not.toHaveBeenCalled()
    partitions.releaseDialer(2)
    await expect(dialLoopback(3000)).rejects.toThrow('no window is connected')
  })
})
