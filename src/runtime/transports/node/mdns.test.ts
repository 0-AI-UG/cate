// mDNS advertisement and discovery by runtimeId. Needs working multicast,
// which CI sandboxes often lack: probe for it first and skip when it is not
// there, rather than faking the network.

import dgram from 'node:dgram'
import { describe, expect, it } from 'vitest'
import { advertiseRuntime, discoverRuntime } from './sameNetwork'

async function multicastWorks(): Promise<boolean> {
  const group = '224.0.0.251'
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1_000)
      socket.once('error', () => { clearTimeout(timer); resolve(false) })
      socket.on('message', (message) => {
        if (message.toString() === 'cate-probe') { clearTimeout(timer); resolve(true) }
      })
      socket.bind(0, () => {
        try {
          socket.addMembership(group)
          socket.setMulticastLoopback(true)
          socket.send('cate-probe', socket.address().port, group)
        } catch {
          clearTimeout(timer)
          resolve(false)
        }
      })
    })
  } finally {
    socket.close()
  }
}

const multicast = await multicastWorks()

describe.skipIf(!multicast)('mdns', () => {
  it('finds the runtime advertising a runtimeId and ignores others', async () => {
    const runtimeId = 'mdnstestaaaaaaaa'
    const ad = advertiseRuntime({ runtimeId, port: 45_123 })
    const other = advertiseRuntime({ runtimeId: 'mdnstestbbbbbbbb', port: 45_124 })
    try {
      const found = await discoverRuntime(runtimeId, { timeoutMs: 8_000 })
      expect(found.length).toBeGreaterThan(0)
      expect(found.every((address) => address.endsWith(':45123'))).toBe(true)
      expect(await discoverRuntime('mdnstestcccccccc', { timeoutMs: 1_500 })).toEqual([])
    } finally {
      await ad.stop()
      await other.stop()
    }
  }, 15_000)
})
