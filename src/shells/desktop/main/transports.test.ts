// The desktop shell's loopback TCP dial (12.3). The network side is the
// portable dialer's, tested in runtime/transports.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { dialLoopbackTcp } from './transports'

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
