import { describe, expect, it, vi } from 'vitest'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { createWebPartitions, type LoopbackDialer } from './webPartitions'
import type { LoopbackProxyOptions } from './loopbackProxy'

const RUNTIME = 'abcdefghijklmnop'

function setup() {
  const setProxy = vi.fn(async (_config: Electron.ProxyConfig) => {})
  const closeAllConnections = vi.fn(async () => {})
  let upstream: string | undefined
  let proxyOptions: LoopbackProxyOptions | null = null
  const close = vi.fn(async () => {})
  const partitions = createWebPartitions({
    session: () => ({ setProxy, closeAllConnections }),
    upstream: () => upstream,
    startProxy: async (options) => {
      proxyOptions = options
      return { port: 41234, close }
    },
  })
  return {
    partitions, setProxy, close, closeAllConnections,
    setUpstream: (value: string | undefined) => { upstream = value },
    hasProxy: () => proxyOptions !== null,
    dialLoopback: (port: number) => proxyOptions!.dialLoopback(port),
    reachesClientNetwork: () => proxyOptions!.reachesClientNetwork(),
  }
}

const dialer = (id: number, dial: LoopbackDialer['dial'], destroyed = false): LoopbackDialer => ({ id, isDestroyed: () => destroyed, dial })

describe('web partitions', () => {
  it('lets the proxy reach this machine\'s network only while every connection to the runtime does', async () => {
    const { partitions, reachesClientNetwork } = setup()
    await partitions.partitionFor(RUNTIME, dialer(1, vi.fn()), true)
    await partitions.partitionFor(RUNTIME, dialer(2, vi.fn()), false)
    expect(reachesClientNetwork()).toBe(false)
    await partitions.partitionFor(RUNTIME, dialer(3, vi.fn()), true)
    expect(reachesClientNetwork()).toBe(false)
  })

  it('routes the workspace partition through its proxy, loopback included', async () => {
    const { partitions, setProxy } = setup()
    expect(partitions.isPrepared(`persist:ws-${RUNTIME}`)).toBe(false)
    expect(await partitions.partitionFor(RUNTIME, dialer(1, vi.fn()), false)).toBe(`persist:ws-${RUNTIME}`)
    expect(setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:41234', proxyBypassRules: '<-loopback>' })
    expect(partitions.isPrepared(`persist:ws-${RUNTIME}`)).toBe(true)
    await partitions.partitionFor(RUNTIME, dialer(2, vi.fn()), true)
    expect(setProxy).toHaveBeenCalledTimes(1)
    await expect(partitions.partitionFor('../etc', dialer(1, vi.fn()), true)).rejects.toThrow('invalid runtime id')
  })

  it('answers the proxy challenge only for its own proxies', async () => {
    const { partitions } = setup()
    await partitions.partitionFor(RUNTIME, dialer(1, vi.fn()), false)
    expect(partitions.credentialsFor('127.0.0.1', 41234)).toBe(partitions.credentials)
    expect(partitions.credentialsFor('127.0.0.1', 8080)).toBeNull()
    expect(partitions.credentialsFor('proxy.corp', 41234)).toBeNull()
  })

  it('dials loopback through a live window serving the workspace', async () => {
    const { partitions, dialLoopback } = setup()
    const pipe = {} as ByteDuplex
    const gone = vi.fn()
    const live = vi.fn(async () => pipe)
    await partitions.partitionFor(RUNTIME, dialer(1, gone, true), false)
    await partitions.partitionFor(RUNTIME, dialer(2, live), false)
    expect(await dialLoopback(3000)).toBe(pipe)
    expect(live).toHaveBeenCalledWith(RUNTIME, 3000)
    expect(gone).not.toHaveBeenCalled()
    partitions.releaseDialer(2)
    await expect(dialLoopback(3000)).rejects.toThrow('no window is connected')
  })

  it('leaves networking to Chromium when the connection permits this machine\'s network', async () => {
    const { partitions, setProxy, hasProxy } = setup()
    await partitions.partitionFor(RUNTIME, dialer(1, vi.fn()), true)
    expect(setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'system' })
    expect(hasProxy()).toBe(false)
    expect(partitions.isPrepared(`persist:ws-${RUNTIME}`)).toBe(true)
  })

  it('switches to protected routing and closes native sockets on a policy downgrade', async () => {
    const { partitions, setProxy, closeAllConnections } = setup()
    await partitions.partitionFor(RUNTIME, dialer(1, vi.fn()), true)
    await partitions.partitionFor(RUNTIME, dialer(2, vi.fn()), false)
    expect(setProxy.mock.calls.map(([config]) => config)).toEqual([
      { mode: 'system' },
      { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:41234', proxyBypassRules: '<-loopback>' },
    ])
    expect(closeAllConnections).toHaveBeenCalledOnce()
  })

  it('applies changed native proxy settings without restarting a workspace', async () => {
    const { partitions, setProxy, closeAllConnections, setUpstream } = setup()
    await partitions.partitionFor(RUNTIME, dialer(1, vi.fn()), true)
    setUpstream('http://user:secret@proxy.corp:8080;bypass=*.internal')
    await partitions.refresh()
    expect(setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers', proxyRules: 'http://proxy.corp:8080', proxyBypassRules: '*.internal',
    })
    expect(partitions.credentialsFor('proxy.corp', 8080)).toEqual({ username: 'user', password: 'secret' })
    expect(partitions.credentialsFor('elsewhere', 8080)).toBeNull()
    setUpstream(undefined)
    await partitions.refresh()
    expect(setProxy).toHaveBeenLastCalledWith({ mode: 'system' })
    expect(partitions.credentialsFor('proxy.corp', 8080)).toBeNull()
    expect(closeAllConnections).toHaveBeenCalledTimes(2)
  })

  it('serializes concurrent preparation so a restrictive policy wins', async () => {
    const { partitions, setProxy } = setup()
    await Promise.all([
      partitions.partitionFor(RUNTIME, dialer(1, vi.fn()), true),
      partitions.partitionFor(RUNTIME, dialer(2, vi.fn()), false),
    ])
    expect(setProxy).toHaveBeenCalledExactlyOnceWith({
      mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:41234', proxyBypassRules: '<-loopback>',
    })
  })

  it('does not mark an in-flight native setup ready after a stricter policy arrives', async () => {
    const { partitions, setProxy, closeAllConnections } = setup()
    let entered!: () => void
    const applying = new Promise<void>((resolve) => { entered = resolve })
    let finish!: () => void
    setProxy.mockImplementationOnce(async () => {
      entered()
      await new Promise<void>((resolve) => { finish = resolve })
    })
    const first = partitions.partitionFor(RUNTIME, dialer(1, vi.fn()), true)
    await applying
    const second = partitions.partitionFor(RUNTIME, dialer(2, vi.fn()), false)
    finish()
    await first
    expect(setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:41234', proxyBypassRules: '<-loopback>',
    })
    expect(closeAllConnections).toHaveBeenCalledOnce()
    await second
  })

  it('can restore the previous setting after a failed reconfiguration', async () => {
    const { partitions, setProxy, setUpstream } = setup()
    await partitions.partitionFor(RUNTIME, dialer(1, vi.fn()), true)
    setUpstream('http://proxy.corp:8080')
    setProxy.mockRejectedValueOnce(new Error('proxy configuration failed'))
    await expect(partitions.refresh()).rejects.toThrow('proxy configuration failed')
    expect(partitions.isPrepared(`persist:ws-${RUNTIME}`)).toBe(false)
    setUpstream(undefined)
    await partitions.refresh()
    expect(partitions.isPrepared(`persist:ws-${RUNTIME}`)).toBe(true)
    expect(setProxy).toHaveBeenLastCalledWith({ mode: 'system' })
  })
})
