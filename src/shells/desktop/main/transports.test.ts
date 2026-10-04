// The desktop shell's local and loopback TCP dials (12.3). The network side
// is the portable dialer's, tested in runtime/transports.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import type { ByteDuplex } from '@kernel/rpc/contract'
import type { LocalRuntime } from '@runtime/daemon/desktop'
import { createShellTransportHost, dialLoopbackTcp, type ShellTransportDeps } from './transports'

describe('shell transports: loopback TCP', () => {
  it('connects to a port on this machine', async () => {
    const server = http.createServer((_req, res) => res.end('hi'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const duplex = await dialLoopbackTcp((server.address() as AddressInfo).port)
    const text = await new Promise<string>((resolve) => {
      let out = ''
      duplex.onData((bytes) => { out += Buffer.from(bytes).toString() })
      duplex.onClose(() => resolve(out))
      duplex.write(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
    })
    expect(text).toMatch(/200 OK[\s\S]*hi$/)
    await new Promise((resolve) => server.close(resolve))
    await expect(dialLoopbackTcp(0)).rejects.toThrow('invalid port')
  })
})

describe('shell transports: local runtimes', () => {
  it('starts a root once at a time: a second dial waits, then connects', async () => {
    const events: string[] = []
    let finishFirst!: () => void
    let starts = 0
    const startLocal = (root: string): Promise<LocalRuntime> => {
      const n = starts++
      events.push(`start ${n}`)
      const local = { runtimeId: 'r', root, endpoint: '/s', duplex: { close: () => events.push(`close ${n}`) } as unknown as ByteDuplex, started: n === 0 }
      if (n > 0) return Promise.resolve(local)
      return new Promise((resolve) => { finishFirst = () => { events.push('started 0'); resolve(local) } })
    }
    const host = createShellTransportHost({ startLocal } as unknown as ShellTransportDeps)

    host.prestartLocal('/w')
    const dial = host.dialLocal('/w')
    await new Promise((r) => setTimeout(r, 10))
    expect(events).toEqual(['start 0'])
    finishFirst()
    await dial
    expect(events).toEqual(['start 0', 'started 0', 'close 0', 'start 1'])
  })
})
