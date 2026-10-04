import { describe, expect, it } from 'vitest'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { base64ToBytes, bytesToBase64 } from '@workspace/files/contract'
import type { MobileBridge, MobileStreamEvent } from '../contract'
import type { MobileClient } from './boot'
import { createMobileStreams, loopbackPort } from './streams'

const tick = () => new Promise((r) => setTimeout(r, 0))
const text = (data: string) => new TextDecoder().decode(base64ToBytes(data))

function setup() {
  const dialed: number[] = []
  const written: string[] = []
  let onData: (bytes: Uint8Array) => void = () => {}
  let onClose: () => void = () => {}
  let closed = false
  const duplex: ByteDuplex = {
    write: (bytes) => { written.push(new TextDecoder().decode(bytes)) },
    onData: (listener) => { onData = listener },
    onClose: (listener) => { onClose = listener },
    close: () => { closed = true },
  }
  const client = {
    connections: { get: (id: string) => (id === 'ws1' ? { dialLoopback: async (port: number) => { dialed.push(port); return duplex } } : undefined) },
  } as unknown as MobileClient
  const events: MobileStreamEvent[] = []
  let release: () => void = () => {}
  const bridge = ((method: string, params: MobileStreamEvent) => {
    if (method !== 'stream.event') return Promise.resolve(null)
    events.push(params)
    // The app takes the first chunk only when released.
    return events.length === 1 ? new Promise((resolve) => { release = () => resolve(null) }) : Promise.resolve(null)
  }) as MobileBridge
  return {
    streams: createMobileStreams(client, bridge), dialed, written, events,
    data: (s: string) => onData(new TextEncoder().encode(s)),
    end: () => onClose(),
    release: () => release(),
    isClosed: () => closed,
  }
}

describe('mobile loopback streams', () => {
  it('forwards the ports of loopback URLs only', () => {
    expect(loopbackPort('http://localhost:3000/a')).toBe(3000)
    expect(loopbackPort('http://127.0.0.1/')).toBe(80)
    expect(loopbackPort('https://app.localhost/')).toBe(443)
    expect(loopbackPort('http://[::1]:5173/')).toBe(5173)
    expect(loopbackPort('https://example.com/')).toBeNull()
    expect(loopbackPort('cate://newtab')).toBeNull()
    expect(loopbackPort('not a url')).toBeNull()
  })

  it('pipes a forwarded connection through the workspace connection', async () => {
    const t = setup()
    await t.streams.open({ streamId: 's', workspaceId: 'ws1', port: 3000 })
    expect(t.dialed).toEqual([3000])
    t.streams.get('s')!.write(bytesToBase64(new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n')))
    expect(t.written).toEqual(['GET / HTTP/1.1\r\n\r\n'])
    t.streams.get('s')!.close()
    expect(t.isClosed()).toBe(true)
  })

  it('sends bytes in order, one chunk at a time, then the end', async () => {
    const t = setup()
    await t.streams.open({ streamId: 's', workspaceId: 'ws1', port: 3000 })
    t.data('a')
    t.data('b')
    t.data('c')
    t.end()
    await tick()
    expect(t.events.map((e) => e.kind === 'data' ? text(e.data) : e.kind)).toEqual(['a'])
    t.release()
    await tick()
    expect(t.events.map((e) => e.kind === 'data' ? text(e.data) : e.kind)).toEqual(['a', 'bc', 'end'])
    expect(t.streams.get('s')).toBeUndefined()
  })
})
